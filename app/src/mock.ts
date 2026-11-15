// MOCK_CAMERA mode: lets the app run the full guidance loop with no camera and no Gemini,
// so Revyl can test it on the iOS simulator (the simulator has no camera). See CLAUDE.md §9.
// Turn on with EXPO_PUBLIC_MOCK_CAMERA=1 (set in the `simulator` EAS profile).
import { getFunctionName } from 'convex/server';
import type { Box, Point } from './guidance';
import { inOnZone } from './guidance';

export const MOCK_CAMERA = process.env.EXPO_PUBLIC_MOCK_CAMERA === '1';

type MockScreen = {
  summary: string;
  buttons: { label: string; box: Box; kind: string }[];
  target: string | null;
  say: string;
  warning?: string;
  doneSay?: string;
};

// A short scripted visit to the fake "Bun & Done" kiosk.
const SCRIPT: MockScreen[] = [
  {
    summary: 'Start screen',
    buttons: [{ label: 'Start order', box: [0.3, 0.7, 0.7, 0.85], kind: 'button' }],
    target: 'Start order',
    say: 'Start order. Find it.',
  },
  {
    summary: 'Menu categories',
    buttons: [
      { label: 'Burgers', box: [0.08, 0.3, 0.46, 0.5], kind: 'button' },
      { label: 'Sides', box: [0.54, 0.3, 0.92, 0.5], kind: 'button' },
      { label: 'Drinks', box: [0.08, 0.55, 0.46, 0.75], kind: 'button' },
    ],
    target: 'Burgers',
    say: 'Burgers. Find it.',
  },
  {
    summary: 'Burgers',
    buttons: [
      { label: 'Classic Burger', box: [0.08, 0.3, 0.46, 0.5], kind: 'button' },
      { label: 'Cheeseburger', box: [0.54, 0.3, 0.92, 0.5], kind: 'button' },
    ],
    target: 'Cheeseburger',
    say: 'Cheeseburger. Find it.',
  },
  {
    summary: 'Make it a meal?',
    buttons: [
      { label: 'Make it a meal', box: [0.54, 0.65, 0.92, 0.82], kind: 'button' },
      { label: 'No thanks', box: [0.08, 0.65, 0.46, 0.82], kind: 'button' },
    ],
    target: 'No thanks',
    say: 'No thanks. Find it.',
    warning: 'This asks you to make it a meal. No thanks is bottom left.',
  },
  {
    summary: 'Order confirmation',
    buttons: [],
    target: null,
    say: '',
    doneSay: 'Order placed. Order number 42.',
  },
];

/** Stands in for the Convex client. Returns scripted answers instead of calling Gemini. */
export class MockBackend {
  private screen = 0;

  async action(fn: unknown, args: any): Promise<any> {
    const name = getFunctionName(fn as any);
    await wait(400); // feel like a network call
    if (name === 'ai:transcribeGoal') return { goal: 'a cheeseburger' };
    if (name === 'ai:mapScreen') {
      const s = SCRIPT[Math.min(this.screen, SCRIPT.length - 1)];
      return { screenId: String(this.screen), summary: s.summary, buttons: s.buttons, cached: true };
    }
    if (name === 'ai:nextStep' || name === 'ai:readAndPlan') {
      const s = SCRIPT[Math.min(name === 'ai:readAndPlan' ? this.screen : Number(args.screenId), SCRIPT.length - 1)];
      const b = s.buttons.find((x) => x.label === s.target);
      return {
        target: b ? { label: b.label, box: b.box } : null,
        say: s.say,
        warning: s.warning ?? null,
        pin: false,
        done: !!s.doneSay,
        doneSay: s.doneSay ?? null,
        digits: [],
      };
    }
    throw new Error(`MockBackend: unknown action ${name}`);
  }

  async mutation(fn: unknown, _args: any): Promise<any> {
    const name = getFunctionName(fn as any);
    if (name === 'sessions:start') return 'mock-session';
    return null;
  }

  /** Called when the mock screen "changes" after a tap. */
  advance() {
    this.screen++;
  }

  reset() {
    this.screen = 0;
  }
}

type Events = {
  onReady?: () => void;
  onFingertip?: (p: Point | null) => void;
  onScreenChanged?: (hash: string) => void;
  onError?: (message: string) => void;
};

/**
 * Stands in for the camera (Eyes). A fake fingertip drifts toward whatever target the app sets.
 * Once it has been on the target for a moment, it "taps": the mock screen changes.
 */
export class MockEyes {
  ready = false;
  events: Events = {};
  finger: Point | null = null;
  target: Box | null = null;
  debug = false;
  private onSince = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private backend: MockBackend) {
    // Let App attach its event handlers first, then report ready.
    setTimeout(() => {
      this.ready = true;
      this.events.onReady?.();
      this.timer = setInterval(() => this.tick(), 33);
    }, 500);
  }

  // Same surface as Eyes (src/bridge.ts) so App and Flow don't care which one they get.
  handle = () => {};

  async captureFrame(): Promise<{ jpeg: string; hash: string }> {
    return { jpeg: '', hash: 'mock' };
  }

  setTarget(box: Box | null) {
    this.target = box;
    this.onSince = 0;
    if (box && !this.finger) this.finger = { x: 0.1, y: 0.1 };
  }

  setDebug(on: boolean) {
    this.debug = on;
  }

  setSensitivity(_value: 'normal' | 'high') {}

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private tick() {
    if (!this.target || !this.finger) return;
    const [x0, y0, x1, y1] = this.target;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    // Move a small step toward the target center each frame.
    this.finger = { x: this.finger.x + (cx - this.finger.x) * 0.04, y: this.finger.y + (cy - this.finger.y) * 0.04 };
    this.events.onFingertip?.(this.finger);

    if (inOnZone(this.finger, this.target)) {
      if (!this.onSince) this.onSince = Date.now();
      else if (Date.now() - this.onSince > 1200) {
        // "Tap": the kiosk moves to its next screen.
        this.target = null;
        this.onSince = 0;
        this.backend.advance();
        this.events.onScreenChanged?.('mock');
      }
    }
  }
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
