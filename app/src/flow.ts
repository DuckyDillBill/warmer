// The key loop as a small state machine. See CLAUDE.md §1 and §6.
// goal → read screen → guide finger → tap detected → say what was tapped → read next screen → … → done
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { CONVEX_URL } from './config';
import type { Eyes } from './bridge';
import { GuideLoop, say } from './feedback';
import type { Box, Point } from './guidance';
import { smooth } from './guidance';

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

  private set(state: FlowState, status?: string) {
    this.state = state;
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
  }

  onScreenChanged() {
    if (this.state === 'pin') return this.onPinDigitEntered();
    if (this.planning) {
      this.changedWhilePlanning = true;
      return;
    }
    if (this.state !== 'guiding') return;
    if (this.target && this.loop.wasOn) {
      say(this.target.label);
      this.history.push(`Tapped "${this.target.label}"`);
    } else {
      this.history.push('The screen changed');
    }
    this.setTarget(null);
    this.plan();
  }

  async start(goal: string) {
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
    this.client
      ?.mutation(api.sessions.start, { goal })
      .then((id: string) => (this.sessionId = id))
      .catch((e: Error) => console.warn('session start failed', e));
    this.set('planning', `Goal: ${goal}`);
    await say(`Got it. ${goal}.`);
    this.plan();
  }

  /** Voice goal: audio recorded on the phone → Gemini transcription (via Convex) → start. */
  async startFromAudio(base64: string, mimeType = 'audio/mp4') {
    if (!this.client) return this.start('');
    this.set('planning', 'Listening…');
    try {
      const { goal } = await this.client.action(api.ai.transcribeGoal, { audio: base64, mimeType });
      await this.start(goal);
    } catch (e) {
      this.set('error', `Couldn't hear that: ${(e as Error).message}`);
      say("Sorry, I couldn't hear that. Try again.");
    }
  }

  repeat() {
    if (this.lastInstruction) say(this.lastInstruction);
  }

  stop() {
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
    this.loop.set(this.finger, t?.box ?? null);
    this.eyes.setTarget(t?.box ?? null, t?.label ?? '');
  }

  private onFingerOnTarget() {
    if (this.state === 'guiding') say('Tap.');
  }

  private async plan(attempt = 0, internal = false): Promise<void> {
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
      const frame = await this.eyes.captureFrame();
      const map = await withTimeout(this.client.action(api.ai.mapScreen, frame), 15000, 'reading the screen');
      const t1 = Date.now();
      const step: Step = await withTimeout(
        this.client.action(api.ai.nextStep, { goal: this.goal, history: this.history, screenId: map.screenId }),
        10000,
        'choosing the next button',
      );
      console.log(`plan: frame+map ${t1 - t0}ms (cached: ${map.cached}), step ${Date.now() - t1}ms`);
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
      const words = [step.warning, step.say].filter(Boolean).join(' ');
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
    this.loop.set(this.finger, box);
    this.eyes.setTarget(box, 'PIN', true); // private: the projector never sees PIN entry
    this.set('pin', `Guiding to the next PIN digit (${this.pin.length} left)`);
  }

  private onPinDigitEntered() {
    if (!this.loop.wasOn || !this.pin.length) return;
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
