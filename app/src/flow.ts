// The key loop as a small state machine. See CLAUDE.md §1 and §6.
// goal → read screen → guide finger → tap detected → say what was tapped → read next screen → … → done
import { ConvexClient, ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { CONVEX_URL, USER_ID } from './config';
import type { Eyes } from './bridge';
import { clearSpeechQueue, GuideLoop, isSpeaking, say } from './feedback';
import * as Haptics from 'expo-haptics';
import type { Box, Point } from './guidance';
import { inOnZone, smooth } from './guidance';

const api = anyApi as any;

export type FlowState = 'idle' | 'planning' | 'guiding' | 'asking' | 'pin' | 'done' | 'error';
type Target = { label: string; box: Box };
type Step = {
  target: Target | null;
  say: string;
  warning: string | null;
  ask?: string | null;
  cart?: string | null;
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
  private steadyAnchor: Point | null = null;
  private steadySince = 0;
  private leftAt = 0;
  private pendingTapLabel = ''; // label of the button just pressed, until the next screen is confirmed // when the finger left the button after reaching it
  private screenSummary = ''; // what the AI said the current screen is
  private pressWatch: ReturnType<typeof setInterval> | null = null;
  private frameHash = ''; // camera hash of the screen we're guiding on (hand excluded) // finger got onto (or right next to) the current button at least once
  private screenRegion: Box | null = null; // where the kiosk screen is in the camera frame (from the AI)
  private lastScreenId: string | null = null; // screen used for the current step; after a tap we skip it in the cache
  private replans = 0; // restarts caused by the screen moving mid-read; capped so camera noise can't loop forever
  private lastInstruction = '';
  private pendingAsk = '';
  private askIsCart = false; // the open question is "fix the cart, or pay?"
  private cartChecked = false; // the AI already compared the cart to the order
  private said = ''; // what they actually said, before the AI turned it into a checklist
  private refreshing = false; // a quiet 2-second re-read is in flight
  private guidingSince = 0; // when the current target was set
  private pin: string[] = [];
  private pinDigits: { label: string; box: Box }[] = [];
  private listener: FlowListener = () => {};

  // ---------- Partner kiosk mode (honest fallback; labeled "Partner" in the app) ----------
  // A partner kiosk publishes its own screen + button layout to Convex (partner.ts). Warmer still finds
  // the kiosk with the camera and guides the finger as usual; button positions come from the kiosk and
  // the kiosk confirms each tap the instant it lands.
  partner = false;
  private kioskLayout: { screen: string; title: string; seq: number; buttons: { label: string; rect: number[]; kind: string }[] } | null = null;
  private kioskSeq = 0;
  private live: ConvexClient | null = null;

  constructor(private eyes: EyesLike, backend?: Backend) {
    this.client = backend ?? (CONVEX_URL ? new ConvexHttpClient(CONVEX_URL) : null);
    this.loop = new GuideLoop(() => this.onFingerOnTarget());
    this.loop.start();
    setInterval(() => this.refresh(), REFRESH_MS);
    // Partner kiosk mode (kiosk publishes its own layout) is switched off: camera-only is the product.
  }

  setPartner(on: boolean) {
    this.partner = on;
    this.screenRegion = null;
    this.emit();
    say(on ? 'Partner kiosk mode on.' : 'Partner kiosk mode off.');
  }

  /** The partner kiosk's screen changed (it publishes after every render). */
  private onKioskLayout(row: any) {
    if (!row) return;
    const changed = this.kioskSeq !== 0 && row.seq !== this.kioskSeq;
    this.kioskLayout = row;
    this.kioskSeq = row.seq;
    if (!this.partner || !changed) return;
    if (this.state === 'pin') return this.onScreenChanged(); // a PIN digit landed
    if (this.planning) {
      this.changedWhilePlanning = true;
      return;
    }
    if (this.state === 'guiding' && this.target) this.confirmTap();
  }

  /** Partner mode: the kiosk says where its buttons are; the camera says where the kiosk is. */
  private async partnerStep() {
    const client = this.client!;
    const layout = this.kioskLayout ?? (await (client as any).query?.(api.partner.current, {}));
    if (!layout) throw new Error('no partner kiosk is publishing its layout');
    const frame = await this.eyes.captureFrame(4000);
    this.frameHash = frame.hash;
    const summary = `${layout.screen}: ${layout.title}`;
    const [found, pick] = await Promise.all([
      client.action(api.partner.locateScreen, { jpeg: frame.jpeg }).catch(() => null),
      client.action(api.partner.planPartner, {
        goal: this.goal,
        history: this.history,
        screen: summary,
        labels: layout.buttons.map((b: { label: string }) => b.label),
      }),
    ]);
    const region = (found as Box | null) ?? this.screenRegion;
    if (!region) throw new Error("couldn't find the kiosk screen in the camera");
    this.screenRegion = region;
    const map = (r: number[]): Box => {
      const w = region[2] - region[0];
      const h = region[3] - region[1];
      return [region[0] + r[0] * w, region[1] + r[1] * h, region[0] + r[2] * w, region[1] + r[3] * h];
    };
    const b = pick.targetIndex != null ? layout.buttons[pick.targetIndex] : null;
    return {
      target: b ? { label: b.label, box: map(b.rect) } : null,
      say: '',
      warning: pick.warning,
      ask: pick.ask ?? null,
      cart: pick.cart ?? null,
      pin: pick.pin,
      done: pick.done,
      doneSay: pick.doneSay,
      digits: layout.buttons
        .filter((k: { kind: string }) => k.kind === 'digit')
        .map((k: { label: string; rect: number[] }) => ({ label: k.label, box: map(k.rect) })),
      screen: region as number[],
      summary,
      sameScreen: false,
      cached: false,
    };
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
    if (!active) return this.resetSteady();
    const onButton = !!this.finger && inBox(this.finger, grow(box!, 0.03));
    if (onButton) {
      this.reached = true;
      this.leftAt = 0;
    } else if (this.reached && !this.leftAt) {
      this.leftAt = Date.now(); // finger lifted / moved off after reaching the button
    }
    // PIN digits barely change the screen, so there a steady 1 s hold on the digit counts as the press.
    if (this.partner || this.state !== 'pin' || !onButton || !this.finger) return this.resetSteady();
    const now = Date.now();
    const a = this.steadyAnchor;
    if (!a || Math.hypot(this.finger.x - a.x, this.finger.y - a.y) > STEADY_RADIUS) {
      this.steadyAnchor = { ...this.finger };
      this.steadySince = now;
      return;
    }
    if (now - this.steadySince >= STEADY_MS) {
      this.resetSteady();
      this.onScreenChanged();
    }
  }

  private resetSteady() {
    this.steadyAnchor = null;
    this.steadySince = 0;
  }


  private clearTapTimer() {
    this.resetSteady();
    if (this.tapTimer) clearTimeout(this.tapTimer);
    this.tapTimer = null;
    if (this.pressWatch) clearInterval(this.pressWatch);
    this.pressWatch = null;
  }

  /** The camera noticed the screen change (or a PIN digit was held). */
  onScreenChanged() {
    if (this.state === 'pin') {
      this.clearTapTimer();
      return this.onPinDigitEntered();
    }
    if (this.planning) {
      this.changedWhilePlanning = true;
      return;
    }
    if (this.state === 'guiding' && this.reached) this.confirmTap();
  }

  /**
   * The press happened (screen changed, or finger reached the button and then lifted).
   * Say ONE short word, give a firm buzz, then read the new screen. The kiosk changes when the
   * finger lifts, so give it a moment before taking the picture.
   */
  private confirmTap() {
    if (!this.target) return;
    this.clearTapTimer();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    say('Loading.');
    this.history.push(`Tapped "${this.target.label}"`);
    this.pendingTapLabel = this.target.label;
    this.setTarget(null);
    this.set('planning', 'Reading the screen…');
    setTimeout(() => this.plan(), 500);
  }

  async start(goal: string) {
    goal = goal.trim();
    if (this.state === 'asking' && this.pendingAsk) return this.answer(goal); // they're answering our question
    if (!goal) {
      say("Sorry, I didn't catch that. Hold the button and try again.");
      return;
    }
    this.said = goal;
    this.goal = goal;
    this.history = [];
    this.pendingAsk = '';
    this.askIsCart = false;
    this.cartChecked = false;
    this.pin = [];
    this.needPin = false;
    (this.client as { reset?: () => void } | null)?.reset?.(); // MockBackend: restart the scripted kiosk
    this.sessionId = null;
    this.lastScreenId = null;
    this.screenRegion = null; // first read of a new order sees the whole view
    this.screenSummary = '';
    this.pendingTapLabel = '';
    this.client
      ?.mutation(api.sessions.start, { goal })
      .then((id: string) => (this.sessionId = id))
      .catch((e: Error) => console.warn('session start failed', e));
    this.set('planning', `Goal: ${goal}`);
    // The AI + Supermemory turn what they said into a clear order ("the usual" works). If that's slow or
    // down, we just use their own words.
    const order = this.client
      ? await withTimeout(this.client.action(api.brain.planOrder, { said: goal, userId: USER_ID }), 9000, 'planning the order').catch(
          (e: Error) => (console.warn('planOrder failed', e), null),
        )
      : null;
    if (order?.goal) this.goal = order.goal;
    this.set('planning', `Order: ${this.goal}`);
    say(`Okay. ${order?.say || goal}.`); // speak while we read the screen, don't wait for it
    this.plan();
  }

  /** Voice goal: audio recorded on the phone → Gemini transcription (via Convex) → start. */
  async startFromAudio(base64: string, mimeType = 'audio/mp4') {
    if (!this.client) return this.start('');
    // Answering our question? Stay in 'asking' so start() routes the words to answer().
    if (this.state === 'asking' && this.pendingAsk) this.set('asking', 'Listening…');
    else this.set('planning', 'Listening…');
    try {
      const { goal } = await this.client.action(api.ai.transcribeGoal, { audio: base64, mimeType });
      await this.start(goal);
    } catch (e) {
      this.set('error', `Couldn't hear that: ${(e as Error).message}`);
      say("Sorry, I couldn't hear that. Try again.");
    }
  }

  /** Their spoken (or typed) answer to our question ("Make it a meal?", "Fix it, or pay?"). The AI reads it. */
  private async answer(text: string) {
    const question = this.pendingAsk;
    const retryWords = this.askIsCart ? 'Say fix it, or pay.' : 'Say yes or no.';
    if (!text) {
      say(`Sorry. ${retryWords}`);
      return;
    }
    let choice = text;
    if (this.client) {
      const r = await withTimeout(this.client.action(api.brain.interpretAnswer, { question, heard: text }), 6000, 'reading the answer').catch(
        () => null,
      );
      if (r && !r.answer) {
        say(`Sorry. ${question} ${retryWords}`);
        return;
      }
      if (r?.answer) choice = r.answer;
    }
    if (this.state !== 'asking' || this.pendingAsk !== question) return; // something else happened meanwhile
    this.history.push(`They answered "${choice}" to "${question}"`);
    // Want the cart fixed? Check it again next time we reach the cart.
    if (this.askIsCart && !/pay/i.test(choice)) this.cartChecked = false;
    this.pendingAsk = '';
    this.askIsCart = false;
    say('Okay.');
    this.plan();
  }

  repeat() {
    if (this.lastInstruction) say(this.lastInstruction);
  }

  stop() {
    clearSpeechQueue();
    this.setTarget(null);
    this.goal = '';
    this.pendingAsk = '';
    this.askIsCart = false;
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
    this.guidingSince = Date.now();
    this.reached = false;
    this.leftAt = 0;
    this.clearTapTimer();
    this.loop.set(this.finger, t?.box ?? null);
    this.eyes.setTarget(t?.box ?? null, t?.label ?? '');
  }

  /**
   * Every ~2 s while guiding: quietly read the screen again.
   * - Same page, same button: snap the box to where the button really is now (silent).
   * - Page changed (the AI says so AND the camera picture changed): carry on to the next step, even if
   *   we never saw the press. Keeps running after the finger reached the button (that's when presses
   *   get missed); only the box update is skipped then, because the hand hides the button.
   * Never speaks on its own.
   */
  private async refresh() {
    if (this.partner || this.refreshing || this.planning || this.state !== 'guiding') return;
    const target = this.target;
    if (!target || !this.client || !this.screenSummary || !this.frameHash) return;
    if (Date.now() - this.guidingSince < REFRESH_MS) return; // just read it
    this.refreshing = true;
    try {
      const crop = this.screenRegion ? padBox(this.screenRegion, 0.12) : undefined;
      const frame = await this.eyes.captureFrame(3000, crop);
      const step = await withTimeout(
        this.client.action(api.ai.readAndPlan, {
          ...frame,
          goal: this.goal,
          history: this.history,
          ...(crop ? { crop } : {}),
          previousSummary: this.screenSummary,
        }),
        10000,
        'refreshing the screen',
      );
      // Anything happen meanwhile? Then this read is stale: drop it.
      if (this.state !== 'guiding' || this.planning || this.target !== target) return;
      const pictureChanged = hamming(frame.hash, this.frameHash) >= 5;
      if (!step.sameScreen && pictureChanged) {
        console.log('refresh: page changed without a detected press');
        this.confirmTap();
        return;
      }
      const t = step.target;
      const handAtButton = this.reached || this.loop.wasOn;
      if (step.sameScreen && t && !handAtButton && sameLabel(t.label, target.label)) {
        const b = target.box;
        const moved = Math.hypot((t.box[0] + t.box[2]) / 2 - (b[0] + b[2]) / 2, (t.box[1] + t.box[3]) / 2 - (b[1] + b[3]) / 2);
        if (moved > 0.02) {
          // Update in place so the guide loop keeps its timing (it compares the box by reference).
          b[0] = t.box[0];
          b[1] = t.box[1];
          b[2] = t.box[2];
          b[3] = t.box[3];
          this.eyes.setTarget(b, target.label);
        }
        this.guidingSince = Date.now();
      }
    } catch (e) {
      console.warn('refresh failed', e);
    } finally {
      this.refreshing = false;
    }
  }

  private onFingerOnTarget() {
    if (this.state !== 'guiding') return;
    say('Press.');
    this.watchAfterPress();
  }

  /**
   * After "Press": quiet until the press really happened. It counts when either
   *  - the screen picture clearly changed (checked twice in a row, so a shaky hand doesn't fool it), or
   *  - the finger reached the button and then lifted / moved off for ~0.8 s (kiosks act on lift).
   * One reminder after 10 s. If we guessed wrong, the next read notices it's the same screen.
   */
  private watchAfterPress() {
    if (this.pressWatch) clearInterval(this.pressWatch);
    let changedTicks = 0;
    let reminded = false;
    const started = Date.now();
    this.pressWatch = setInterval(() => {
      const box = this.target?.box;
      if (this.state !== 'guiding' || this.planning || !box) return this.clearTapTimer();
      if (!this.partner && this.reached && this.leftAt && Date.now() - this.leftAt > 800) return this.confirmTap();
      if (!this.partner && this.frameHash) {
        this.eyes
          .captureFrame(2000)
          .then((f) => {
            if (!this.pressWatch) return;
            changedTicks = hamming(f.hash, this.frameHash) >= 8 ? changedTicks + 1 : 0;
            if (changedTicks >= 2 && this.state === 'guiding' && !this.planning) this.confirmTap();
          })
          .catch(() => {});
      }
      if (!reminded && Date.now() - started > 10000 && !isSpeaking()) {
        reminded = true;
        say('Press the button.');
      }
    }, 500);
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
      type PlanStep = Step & { cached?: boolean; screen?: number[] | null; sameScreen?: boolean; summary?: string };
      let step: PlanStep;
      if (this.partner) {
        step = (await withTimeout(this.partnerStep(), 20000, 'reading the partner kiosk')) as PlanStep;
      } else {
        // Once we know where the kiosk is, send only that (plus a margin) so the AI sees the buttons bigger.
        const crop = this.screenRegion ? padBox(this.screenRegion, 0.12) : undefined;
        const frame = await this.eyes.captureFrame(4000, crop);
        this.frameHash = frame.hash;
        // One round trip: maps the screen (or uses the cache) and picks the next button together.
        step = await withTimeout(
          this.client.action(api.ai.readAndPlan, {
            ...frame,
            goal: this.goal,
            history: this.history,
            ...(crop ? { crop } : {}),
            ...(this.pendingTapLabel && this.screenSummary ? { previousSummary: this.screenSummary } : {}),
            // Right after a tap the screen must be new: don't let the cache hand back the previous screen.
            ...(this.lastScreenId && this.history.length ? { avoidScreenId: this.lastScreenId } : {}),
          }),
          20000,
          'reading the screen',
        );
        if (step.screen && step.screen.length === 4) this.screenRegion = step.screen as Box;
        // Cropped too tight (phone moved)? Forget the region so the retry looks at the whole view.
        if (crop && !step.target && !step.done && !step.pin && !step.ask) {
          this.screenRegion = null;
          throw new Error('target not in the cropped view');
        }
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

      // The press didn't take effect (still the same screen): don't pretend it did.
      const pressedLabel = this.pendingTapLabel;
      this.pendingTapLabel = '';
      const missed = !!pressedLabel && !!step.sameScreen;
      if (missed && this.history[this.history.length - 1] === `Tapped "${pressedLabel}"`) this.history.pop();
      if (step.summary) this.screenSummary = step.summary;

      if (step.done) {
        this.setTarget(null);
        const msg = step.doneSay || 'Done.';
        this.set('done', msg);
        this.logSession('done');
        // Supermemory: remember what they ordered and the choices they made, for "the usual" next time.
        this.client
          ?.action(api.brain.rememberOrder, { userId: USER_ID, said: this.said, goal: this.goal, history: this.history, place: this.screenSummary || undefined })
          .catch((e: Error) => console.warn('rememberOrder failed', e));
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
      // Cart: the AI compares it to what they asked for, before they pay. A blind person can't see the cart.
      let cartLine = '';
      if (step.cart && step.target && !missed) {
        cartLine = step.cart;
        if (!this.cartChecked && this.client) {
          this.cartChecked = true;
          const check = await withTimeout(this.client.action(api.brain.checkCart, { goal: this.goal, cart: step.cart }), 8000, 'checking the cart').catch(
            () => null,
          );
          if (check && !check.ok) {
            this.setTarget(null);
            this.pendingAsk = `${check.say || "Your cart doesn't match your order."} Fix it, or pay anyway?`;
            this.askIsCart = true;
            const words = `${this.pendingAsk} Hold the button and answer.`;
            this.lastInstruction = words;
            this.set('asking', this.pendingAsk);
            await say(words);
            return;
          }
        }
      }
      if (step.ask && !step.target) {
        // Meal upgrade, donation, tip…: their choice, not ours. Ask, then wait for them to hold and answer.
        this.setTarget(null);
        this.pendingAsk = step.ask;
        const words = `${step.ask} Hold the button and say yes or no.`;
        this.lastInstruction = words;
        this.set('asking', step.ask);
        this.logSession('guiding');
        await say(words);
        return;
      }
      if (!step.target) throw new Error('no target');
      // Short and always the same shape: "Next: Fries, bottom left." / "Press again. Fries, bottom left."
      const where = locate(step.target.box as Box, this.screenRegion);
      const lead = missed ? "That didn't press. " : this.history.length ? 'Next: ' : '';
      const words = lead + [missed ? null : step.warning, cartLine || null, `${step.target.label}, ${where}.`].filter(Boolean).join(' ');
      this.lastInstruction = words;
      this.setTarget({ label: step.target.label, box: step.target.box as Box });
      this.set('guiding', words || `Find ${step.target.label}`);
      this.logSession('guiding');
      await say(words);
    } catch (e) {
      this.planning = false;
      console.warn('plan failed', e);
      if (attempt === 0) return this.plan(1, true); // retry once, quietly
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
    if (!(this.partner || this.loop.wasOn || this.reached) || !this.pin.length) return; // partner kiosk confirms each digit itself
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

const STEADY_MS = 1000; // finger held still on the button this long = tap
const REFRESH_MS = 2000; // quiet re-read of the screen while guiding
const STEADY_RADIUS = 0.03; // "still" = stays within 3% of the camera frame

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

/** "Fries" vs "fries" vs "Fries $2.49": the same button. */
function sameLabel(a: string, b: string): boolean {
  const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const x = n(a);
  const y = n(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}
