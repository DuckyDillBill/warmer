// Haptics, sounds and speech. All the "output" of Warmer lives here.
import * as Haptics from 'expo-haptics';
import { Vibration } from 'react-native';
import * as Speech from 'expo-speech';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { guide, type Box, type Point } from './guidance';

let ding: AudioPlayer | null = null;
let onTone: AudioPlayer | null = null;
let noHand: AudioPlayer | null = null;
const beeps: AudioPlayer[] = []; // 8 pitches, low = far, high = close

export async function initAudio() {
  await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
  ding = createAudioPlayer(require('../assets/ding.wav'));
  onTone = createAudioPlayer(require('../assets/ontone.wav'));
  noHand = createAudioPlayer(require('../assets/nohand.wav'));
  const files = [
    require('../assets/beep0.wav'),
    require('../assets/beep1.wav'),
    require('../assets/beep2.wav'),
    require('../assets/beep3.wav'),
    require('../assets/beep4.wav'),
    require('../assets/beep5.wav'),
    require('../assets/beep6.wav'),
    require('../assets/beep7.wav'),
  ];
  beeps.length = 0;
  for (const f of files) beeps.push(createAudioPlayer(f));
}

function play(p: AudioPlayer | null | undefined, volume = 1) {
  if (!p) return;
  try {
    p.volume = volume;
    p.seekTo(0);
    p.play();
  } catch {}
}

export function playDing() {
  play(ding);
  // The full vibration motor (phone-call buzz) is far stronger than haptic taps when held in a hand.
  Vibration.vibrate();
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

/** A burst of `n` heavy taps, 30 ms apart: feels much stronger than a single tap. */
function burst(style: Haptics.ImpactFeedbackStyle, n: number) {
  for (let i = 0; i < n; i++) setTimeout(() => Haptics.impactAsync(style), i * 30);
}

// ---------- speech: a queue, so a sentence is never cut off ----------
// Blind users rely on every word. Normal messages wait their turn and play in order.
// 'low' messages (hints like "left") are simply skipped if anything else is being said or queued.
type Utterance = { text: string; rate: number; resolve: () => void; low?: boolean; retried?: boolean };
const queue: Utterance[] = [];
let speaking = false;

export function isSpeaking() {
  return speaking || queue.length > 0;
}

let watchdog: ReturnType<typeof setTimeout> | null = null;

function next() {
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
  const u = queue.shift();
  if (!u) {
    speaking = false;
    return;
  }
  speaking = true;
  let finished = false;
  const started = Date.now();
  const done = () => {
    if (finished) return;
    finished = true;
    u.resolve();
    next();
  };
  // iOS can cut speech off mid-sentence (e.g. someone presses the volume buttons, or another sound
  // grabs the audio). We never stop speech ourselves, so a "stopped" or a finish far too early means
  // the sentence was cut. Say it again once, unless a newer instruction is already waiting.
  const cut = () => {
    if (finished) return;
    if (!u.low && !u.retried && queue.length === 0) {
      finished = true;
      queue.unshift({ ...u, retried: true });
      setTimeout(next, 250);
      return;
    }
    done();
  };
  const onDone = () => (Date.now() - started < u.text.length * 25 ? cut() : done());
  // Watchdog: iOS sometimes never reports that speech finished (e.g. right after recording audio).
  // Without this, the queue waits forever and Warmer goes silent. Move on after a generous estimate.
  // Set BEFORE speaking, so even if speak() throws, the queue keeps moving.
  watchdog = setTimeout(done, 1500 + u.text.length * 90);
  try {
    Speech.speak(u.text, { rate: u.rate, onDone, onStopped: cut, onError: cut });
  } catch (e) {
    console.warn('speech failed', e);
    done();
  }
}

/**
 * Speak and resolve when finished. Rules that keep it understandable:
 * - Whatever is being said right now always finishes (never cut off).
 * - A new normal message REPLACES anything still waiting, so you only ever hear the latest
 *   instruction, never a backlog of stale ones.
 * - 'low' messages (direction words) are dropped if anything is being said or waiting.
 */
export function say(text: string, opts: { rate?: number; priority?: 'normal' | 'low' } = {}): Promise<void> {
  if (!text) return Promise.resolve();
  if (opts.priority === 'low' && isSpeaking()) return Promise.resolve();
  if (opts.priority !== 'low') clearSpeechQueue();
  return new Promise((resolve) => {
    queue.push({ text, rate: opts.rate ?? 1.0, resolve, low: opts.priority === 'low' });
    if (!speaking) next();
  });
}

/** Drop anything not yet said (used when starting over). The current sentence still finishes. */
export function clearSpeechQueue() {
  while (queue.length) queue.shift()!.resolve();
}

// Concentric rings around the button. Bigger ring = gentle and slow; smaller = stronger and faster,
// until it's almost violent right at the edge of the button. Each ring has one fixed rhythm, so the
// change is easy to feel as you cross into the next ring.
// Strength is turned way up: haptic taps alone are too weak to feel in a hand, so every ring uses
// bursts of heavy taps, and the two innermost rings add the full vibration motor.
type Ring = { maxDist: number; pulseMs: number; style: Haptics.ImpactFeedbackStyle; taps: number; motor: boolean };
const RINGS: Ring[] = [
  { maxDist: 0.05, pulseMs: 420, style: Haptics.ImpactFeedbackStyle.Heavy, taps: 4, motor: true }, // almost violent
  { maxDist: 0.1, pulseMs: 450, style: Haptics.ImpactFeedbackStyle.Heavy, taps: 3, motor: true },
  { maxDist: 0.17, pulseMs: 220, style: Haptics.ImpactFeedbackStyle.Heavy, taps: 3, motor: false },
  { maxDist: 0.26, pulseMs: 340, style: Haptics.ImpactFeedbackStyle.Heavy, taps: 2, motor: false },
  { maxDist: 0.38, pulseMs: 500, style: Haptics.ImpactFeedbackStyle.Heavy, taps: 1, motor: false },
  { maxDist: Infinity, pulseMs: 750, style: Haptics.ImpactFeedbackStyle.Medium, taps: 1, motor: false },
];
function ringFor(distance: number): number {
  return RINGS.findIndex((r) => distance <= r.maxDist);
}

const HINT_EVERY_MS = 3000; // spoken direction cadence while searching (only when nothing else is being said)

/**
 * The guidance loop, designed for blind users (see CLAUDE.md §6). Quiet by design:
 * - Searching: haptic rings (above). A soft beep rides along with each pulse, but only while
 *   nothing is being said, so sounds never pile on top of speech.
 * - Words (one syllable where possible): "up left", "slight down", "close" when right there.
 * - On the button: ding + big buzz + "Press", then SILENCE until the next screen.
 * - Hand not in view: a soft blip now and then. No talking over instructions.
 * onOn fires once per target, when the fingertip first settles on the button.
 */
export class GuideLoop {
  private finger: Point | null = null;
  private target: Box | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onSince = 0;
  private announcedOn = false;
  private bestDist = 1;
  private bestAt = 0;
  private lastHint = 0;
  private lastNoHandBlip = 0;
  private noHandSince = 0;
  // Beeps off: on iOS a sound effect ending can cut off speech that started while it played.
  // The haptic rings carry the distance on their own.
  sound = false;

  constructor(private onOn: () => void) {}

  set(finger: Point | null, target: Box | null) {
    if (target !== this.target) {
      this.announcedOn = false;
      this.onSince = 0;
      this.lastHint = 0; // first direction as soon as the instruction has been said
      this.bestDist = 1;
      this.bestAt = Date.now();
    }
    this.finger = finger;
    this.target = target;
  }

  get wasOn() {
    return this.announcedOn;
  }

  start() {
    if (this.timer) return;
    const step = () => {
      this.timer = setTimeout(step, this.tick());
    };
    step();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One beat of the loop. Returns how long to wait before the next one. */
  private tick(): number {
    const now = Date.now();
    const target = this.target;
    // No target, or already told them "Tap": stay completely quiet until the next screen.
    if (!target || this.announcedOn) return 150;

    if (!this.finger) {
      // Never leave them guessing why the directions stopped: say it, every few seconds.
      if (!this.noHandSince) this.noHandSince = now;
      if (now - this.noHandSince > 2000 && now - this.lastNoHandBlip > 8000 && !isSpeaking()) {
        this.lastNoHandBlip = now;
        say('No hand.', { priority: 'low' });
      }
      this.onSince = 0;
      return 150;
    }
    this.noHandSince = 0;

    const g = guide(this.finger, target);
    if (g.state === 'on') {
      if (!this.onSince) this.onSince = now;
      if (now - this.onSince > 150) {
        this.announcedOn = true;
        playDing(); // success buzz + ding
        setTimeout(this.onOn, 750); // "Press and hold" only after the 0.6 s ding has fully finished
      }
      return 80;
    }
    this.onSince = 0;

    const ring = RINGS[ringFor(g.distance)];
    // The motor buzz lasts ~0.4 s on iPhone, so the inner rings pulse at that rate with taps on top.
    if (ring.motor && !isSpeaking()) Vibration.vibrate(); // the motor can interrupt speech on iOS
    burst(ring.style, ring.taps);
    if (this.sound && !isSpeaking()) {
      const closeness = 1 - Math.min(1, g.distance / 0.55);
      play(beeps[Math.round(closeness * (beeps.length - 1))], 0.45);
    }

    // Words: a general direction every ~2 s ("up left", "a little down"), never over other speech.
    // When they're right at the button but not quite on it, a calm "almost".
    if (now - this.lastHint > HINT_EVERY_MS && !isSpeaking()) {
      this.lastHint = now;
      const word = g.distance < 0.05 ? 'close' : direction(this.finger, target, g.distance);
      say(word, { rate: 1.15, priority: 'low' });
    }
    return ring.pulseMs;
  }
}

/**
 * Plain-word direction with diagonals: "up", "up left", "a little down right"…
 * (Like a compass's 8 directions, but in words that need no translation on a screen.)
 * Camera frame, not mirrored. A component only counts if it's at least half the bigger one.
 */
function direction(p: Point, b: Box, distance: number): string {
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  const dx = cx - p.x;
  const dy = cy - p.y;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const vertical = ay >= ax * 0.5 ? (dy > 0 ? 'down' : 'up') : '';
  const horizontal = ax >= ay * 0.5 ? (dx > 0 ? 'right' : 'left') : '';
  const word = [vertical, horizontal].filter(Boolean).join(' ');
  return distance < 0.12 ? `slight ${word}` : word;
}
