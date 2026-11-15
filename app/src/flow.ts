// The key loop as a small state machine. See CLAUDE.md §1 and §6.
// goal → read screen → guide finger → tap detected → say what was tapped → read next screen → … → done
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { CONVEX_URL } from './config';
import type { Eyes } from './bridge';
import { clearSpeechQueue, GuideLoop, isSpeaking, say } from './feedback';
import * as Haptics from 'expo-haptics';
import type { Box, Point } from './guidance';
import { inOnZone, smooth } from './guidance';

const api = anyApi as any;

export type FlowState = 'idle' | 'planning' | 'guiding' | 'pin' | 'done' | 'error';
type Target = { label: string; box: Box };
type Step = {
  target: Target | null;
  say: string;
  warning: string | null;
  pin: boolean;
  done: boolean;
  doneSay: string | null;
  digits: { label: string; box: Box }[];
};

// Anything that can answer Convex calls: the real ConvexHttpClient, or MockBackend in MOCK_CAMERA mode.
export type Backend = {
  action(fn: any, args: any): Promise<any>;
  mutation(fn: any, args: any): Promise<any>;
};
// The parts of Eyes (src/bridge.ts) the flow needs. MockEyes (src/mock.ts) provides the same.
type EyesLike = Pick<Eyes, 'captureFrame' | 'setTarget' | 'setSensitivity'>;

export type FlowListener = (s: { state: FlowState; status: string; goal: string; needPin: boolean }) => void;

export class Flow {
  state: FlowState = 'idle';
  status = 'Hold the button and say what you want.';
  goal = '';
  needPin = false;

  private client: Backend | null;
  private sessionId: string | null = null;
  private history: string[] = [];
  private target: Target | null = null;
  private finger: Point | null = null;
  private loop: GuideLoop;
  private planning = false;
  private changedWhilePlanning = false;
  private tapTimer: ReturnType<typeof setTimeout> | null = null;
  private reached = false;
  private pressWatch: ReturnType<typeof setInterval> | null = null;
  private frameHash = ''; // camera hash of the screen we're guiding on (hand excluded) // finger got onto (or right next to) the current button at least once
  private screenRegion: Box | null = null; // where the kiosk screen is in the camera frame (from the AI)
  private lastScreenId: string | null = null; // screen used for the current step; after a tap we skip it in the cache
  private replans = 0; // restarts caused by the screen moving mid-read; capped so camera noise can't loop forever
  private lastInstruction = '';
  private pin: string[] = [];
  private pinDigits: { label: string; box: Box }[] = [];
  private listener: FlowListener = () => {};

  constructor(private eyes: EyesLike, backend?: Backend) {
    this.client = backend ?? (CONVEX_URL ? new ConvexHttpClient(CONVEX_URL) : null);
    this.loop = new GuideLoop(() => this.onFingerOnTarget());
    this.loop.start();
  }

  subscribe(l: FlowListener) {
    this.listener = l;
    this.emit();
  }

  private emit() {
    this.listener({ state: this.state, status: this.status, goal: this.goal, needPin: this.needPin });
  }

  private heartbeat: ReturnType<typeof setInterval> | null = null;

  private set(state: FlowState, status?: string) {
    this.state = state;
    // While Warmer is working (reading the screen), a soft pulse every second says "still working".
    // Haptics only, so it never talks over anything. After ~6 s, one spoken "Still loading."
    if (state === 'planning' && !this.heartbeat) {
      const started = Date.now();
      let toldStill = false;
      this.heartbeat = setInterval(() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
        if (!toldStill && Date.now() - started > 6000 && !isSpeaking()) {
          toldStill = true;
          say('Still loading.', { priority: 'low' });
        }
      }, 1000);
    } else if (state !== 'planning' && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (status !== undefined) this.status = status;
    this.emit();
  }

  // ---------- session log (Convex `sessions`, CLAUDE.md §5). Fire and forget: never blocks guidance. ----------
  private logSession(status: string) {
    if (!this.client || !this.sessionId) return;
    this.client
      .mutation(api.sessions.update, { id: this.sessionId, history: this.history, status })
      .catch((e: Error) => console.warn('session update failed', e));
  }

  // ---------- inputs ----------
  onFingertip(p: Point | null) {
    this.finger = p ? smooth(this.finger, p) : null;
    this.loop.set(this.finger, this.target?.box ?? null);
    this.watchForTap();
  }

  /** The camera page tracked the button as the phone moved: slide the target to match. */
  onTargetMoved(box: Box) {
    if (!this.target) return;
    // Update in place so the guide loop keeps its "on" state (it compares the box by reference).
    const b = this.target.box;
    b[0] = box[0];
    b[1] = box[1];
    b[2] = box[2];
    b[3] = box[3];
  }

  /**
   * Tap detection that doesn't depend on the camera noticing the screen change:
   * once the finger has reached the button ("Tap."), the hand leaving the button for ~0.9 s
   * counts as the tap. If the screen didn't really change, the next read just finds the same button.
   */
  private watchForTap() {
    const box = this.target?.box;
    const active = (this.state === 'guiding' || this.state === 'pin') && !!box && !this.planning;
    if (!active) return this.clearTapTimer();
    // Anywhere on the button (plus a little margin) counts as reaching it. Handheld tracking is noisy,
    // so don't require the exact "Tap" zone before we start watching for the tap.
    const onButton = !!this.finger && inBox(this.finger, grow(box!, 0.03));
    if (onButton || this.loop.wasOn) this.reached = true;
    if (!this.reached) return;
    if (onButton) return this.clearTapTimer();
    if (this.tapTimer) return;
    this.tapTimer = setTimeout(() => {
      this.tapTimer = null;
      if (this.reached && !this.planning) this.onScreenChanged();
    }, 600);
  }

  private clearTapTimer() {
    if (this.tapTimer) clearTimeout(this.tapTimer);
    this.tapTimer = null;
    if (this.pressWatch) clearInterval(this.pressWatch);
    this.pressWatch = null;
  }

  onScreenChanged() {
    this.clearTapTimer();
    if (this.state === 'pin') return this.onPinDigitEntered();
    if (this.planning) {
      this.changedWhilePlanning = true;
      return;
    }
    if (this.state !== 'guiding') return;
    if (this.target && (this.loop.wasOn || this.reached)) {
      // Clear confirmation so a blind user knows the tap landed and a new screen is coming.
      say(`Got it. ${this.target.label}. Loading.`);
      this.history.push(`Tapped "${this.target.label}"`);
    } else {
      this.history.push('The screen changed');
    }
    this.setTarget(null);
    this.plan();
  }

  async start(goal: string, prefetched?: { jpeg: string; hash: string }) {
    goal = goal.trim();
    if (!goal) {
      say("Sorry, I didn't catch that. Hold the button and try again.");
      return;
    }
    this.goal = goal;
    this.history = [];
    this.pin = [];
    this.needPin = false;
    (this.client as { reset?: () => void } | null)?.reset?.(); // MockBackend: restart the scripted kiosk
    this.sessionId = null;
    this.lastScreenId = null;
    this.screenRegion = null; // first read of a new order sees the whole view
    this.client
      ?.mutation(api.sessions.start, { goal })
      .then((id: string) => (this.sessionId = id))
      .catch((e: Error) => console.warn('session start failed', e));
    this.set('planning', `Goal: ${goal}`);
    clearSpeechQueue();
    say(`Okay. ${goal}.`); // speak while we read the screen, don't wait for it
    this.plan(0, false, prefetched);
  }

  /** Voice goal: audio recorded on the phone → Gemini transcription (via Convex) → start. */
  async startFromAudio(base64: string, mimeType = 'audio/mp4') {
    if (!this.client) return this.start('');
    this.set('planning', 'Listening…');
    // While Gemini transcribes the voice, grab a frame and map the screen at the same time.
    // That fills the screen cache, so the first step afterwards is a quick text-only call.
    const client = this.client!;
    const prefetch = this.eyes
      .captureFrame()
      .then(async (frame) => {
        await client.action(api.ai.mapScreen, frame);
        return frame;
      })
      .catch(() => undefined);
    try {
      const { goal } = await this.client.action(api.ai.transcribeGoal, { audio: base64, mimeType });
      const frame = goal ? await prefetch : undefined;
      await this.start(goal, frame);
    } catch (e) {
      this.set('error', `Couldn't hear that: ${(e as Error).message}`);
      say("Sorry, I couldn't hear that. Try again.");
    }
  }

  repeat() {
    if (this.lastInstruction) say(this.lastInstruction);
  }

  stop() {
    clearSpeechQueue();
    this.setTarget(null);
    this.goal = '';
    this.set('idle', 'Hold the button and say what you want.');
  }

  /** PIN typed on the phone. Kept in memory only; never spoken, logged or sent anywhere. */
  providePin(pin: string) {
    this.pin = pin.replace(/\D/g, '').split('');
    this.needPin = false;
    this.emit();
    if (this.pin.length) this.guideNextDigit();
  }

  // ---------- core ----------
  private setTarget(t: Target | null) {
    this.target = t;
    this.reached = false;
    this.clearTapTimer();
    this.loop.set(this.finger, t?.box ?? null);
    this.eyes.setTarget(t?.box ?? null, t?.label ?? '');
  }

  private onFingerOnTarget() {
    if (this.state !== 'guiding') return;
    say('Press.');
    this.watchAfterPress();
  }

  /**
   * After "Press", Warmer is silent until it knows the tap happened. Three ways to know, so it can
   * never get stuck in silence:
   *  1. the finger leaves the button (watchForTap),
   *  2. the finger rests on the button for ~1.5 s (people tap and keep their finger there),
   *  3. the camera picture of the screen clearly changed (checked every ~1.5 s).
   * And if none of that happens for 8 s, it reminds them out loud.
   */
  private watchAfterPress() {
    if (this.pressWatch) clearInterval(this.pressWatch);
    let restingTicks = 0;
    let tick = 0;
    let remindedAt = Date.now();
    this.pressWatch = setInterval(() => {
      const box = this.target?.box;
      if (this.state !== 'guiding' || this.planning || !box) return this.clearTapTimer();
      tick++;
      const onButton = !!this.finger && inBox(this.finger, grow(box, 0.03));
      restingTicks = onButton ? restingTicks + 1 : 0;
      if (restingTicks >= 2) return this.onScreenChanged();
      if (tick % 2 === 0 && this.frameHash) {
        this.eyes
          .captureFrame(2000)
          .then((f) => {
            if (this.pressWatch && this.state === 'guiding' && !this.planning && hamming(f.hash, this.frameHash) >= 10) {
              this.onScreenChanged();
            }
          })
          .catch(() => {});
      }
      if (Date.now() - remindedAt > 8000 && !isSpeaking()) {
        remindedAt = Date.now();
        say('Press the button, then lift your finger.');
      }
    }, 750);
  }

  private async plan(attempt = 0, internal = false, prefetched?: { jpeg: string; hash: string }): Promise<void> {
    // Only one screen read at a time. Pressing the button again or a new goal while we're reading
    // just marks the read as stale; it gets redone with the latest goal when the current one returns.
    // (Parallel reads were burning through the Gemini rate limit.)
    if (this.planning && !internal) {
      this.changedWhilePlanning = true;
      return;
    }
    if (!this.client) {
      this.set('error', 'Backend not connected (EXPO_PUBLIC_CONVEX_URL missing).');
      say('Warmer is not connected to its backend yet.');
      return;
    }
    this.planning = true;
    this.changedWhilePlanning = false;
    this.set('planning', 'Reading the screen…');
    try {
      const t0 = Date.now();
      // Once we know where the kiosk is, send only that (plus a margin) so the AI sees the buttons bigger.
      const crop = !prefetched && this.screenRegion ? padBox(this.screenRegion, 0.12) : undefined;
      const frame = prefetched ?? (await this.eyes.captureFrame(4000, crop));
      this.frameHash = frame.hash;
      // One round trip: maps the screen (or uses the cache) and picks the next button together.
      const step: Step & { cached?: boolean; screen?: number[] | null } = await withTimeout(
        this.client.action(api.ai.readAndPlan, {
          ...frame,
          goal: this.goal,
          history: this.history,
          ...(crop ? { crop } : {}),
          // Right after a tap the screen must be new: don't let the cache hand back the previous screen.
          ...(this.lastScreenId && this.history.length ? { avoidScreenId: this.lastScreenId } : {}),
        }),
        20000,
        'reading the screen',
      );
      if (step.screen && step.screen.length === 4) this.screenRegion = step.screen as Box;
      // Cropped too tight (phone moved)? Forget the region so the retry looks at the whole view.
      if (crop && !step.target && !step.done && !step.pin) {
        this.screenRegion = null;
        throw new Error('target not in the cropped view');
      }
      console.log(`plan: ${Date.now() - t0}ms (cached screen: ${step.cached})`);
      if ((step as { screenId?: string }).screenId) this.lastScreenId = (step as { screenId?: string }).screenId!;
      this.planning = false;
      // The screen moved on while we were thinking: read it again, but at most twice in a row.
      // Without the cap, glare or a shaky phone can keep "Reading the screen…" going for minutes.
      if (this.changedWhilePlanning && this.replans < 2) {
        this.replans++;
        this.planning = false;
        return this.plan(0, true);
      }
      this.replans = 0;

      if (step.done) {
        this.setTarget(null);
        const msg = step.doneSay || 'Done.';
        this.set('done', msg);
        this.logSession('done');
        this.lastInstruction = msg;
        await say(msg);
        return;
      }
      if (step.pin) {
        this.pinDigits = step.digits;
        this.set('pin', 'PIN pad. Type your PIN on your phone.');
        this.eyes.setSensitivity('high');
        if (this.pin.length) this.guideNextDigit();
        else {
          this.needPin = true;
          this.emit();
          await say('This is a PIN pad. Type your PIN on your phone. I will never say it out loud.');
        }
        return;
      }
      if (!step.target) throw new Error('no target');
      // After the first step, start with "Next:" so it's obvious this is a new screen, not the old one.
      const lead = this.history.length ? 'Next: ' : '';
      // Always say WHERE the button is, right away: "Fries, bottom left."
      const where = locate(step.target.box as Box, this.screenRegion);
      const words = lead + [step.warning, `${step.target.label}, ${where}.`].filter(Boolean).join(' ');
      this.lastInstruction = words;
      this.setTarget({ label: step.target.label, box: step.target.box as Box });
      this.set('guiding', words || `Find ${step.target.label}`);
      this.logSession('guiding');
      await say(words);
    } catch (e) {
      this.planning = false;
      console.warn('plan failed', e);
      if (attempt === 0) {
        await say("Sorry, let's try that again.");
        return this.plan(1, true);
      }
      this.set('error', `Couldn't read the screen: ${(e as Error).message}`);
      this.logSession('error');
      await say("I couldn't read the screen. Point the phone at it and press Retry.");
    }
  }

  retry() {
    if (this.goal) this.plan();
  }

  // ---------- PIN: digit by digit, haptics only ----------
  private guideNextDigit() {
    const d = this.pin[0];
    const key = this.pinDigits.find((k) => k.label.trim() === d);
    if (!key) {
      this.set('error', "Couldn't find the keypad numbers.");
      say("I can't find the keypad numbers. Try entering the PIN yourself.");
      return;
    }
    const box = [...key.box] as Box; // fresh array so a repeated digit still resets the "on" state
    this.target = { label: 'next digit', box };
    this.reached = false;
    this.clearTapTimer();
    this.loop.set(this.finger, box);
    this.eyes.setTarget(box, 'PIN', true); // private: the projector never sees PIN entry
    this.set('pin', `Guiding to the next PIN digit (${this.pin.length} left)`);
  }

  private onPinDigitEntered() {
    if (!(this.loop.wasOn || this.reached) || !this.pin.length) return;
    this.pin.shift();
    if (this.pin.length) {
      this.guideNextDigit();
    } else {
      this.eyes.setSensitivity('normal');
      this.history.push('PIN entered');
      this.setTarget(null);
      say('PIN entered.');
      this.set('guiding');
      this.plan();
    }
  }
}

/** Never wait forever on the network: after `ms`, give up so the retry path can kick in. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out ${what}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Differing bits between two hex hashes (0 if they can't be compared). */
function hamming(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

function inBox(p: Point, b: Box): boolean {
  return p.x >= b[0] && p.x <= b[2] && p.y >= b[1] && p.y <= b[3];
}

/** Where a button sits on the screen, in words: "top left", "middle", "bottom right"… */
function locate(b: Box, screen: Box | null): string {
  const [sx0, sy0, sx1, sy1] = screen ?? [0, 0, 1, 1];
  const fx = ((b[0] + b[2]) / 2 - sx0) / (sx1 - sx0 || 1);
  const fy = ((b[1] + b[3]) / 2 - sy0) / (sy1 - sy0 || 1);
  const v = fy < 0.36 ? 'top' : fy > 0.64 ? 'bottom' : '';
  const h = fx < 0.36 ? 'left' : fx > 0.64 ? 'right' : '';
  if (!v && !h) return 'in the middle';
  return [v, h].filter(Boolean).join(' ');
}

/** Box grown by `m` (fraction of its own size) on every side, clamped to the frame. */
function padBox(b: Box, m: number): Box {
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  return [
    Math.max(0, b[0] - w * m),
    Math.max(0, b[1] - h * m),
    Math.min(1, b[2] + w * m),
    Math.min(1, b[3] + h * m),
  ];
}

/** Box expanded by `m` on every side (a little forgiveness around the button). */
function grow(b: Box, m: number): Box {
  return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
}
