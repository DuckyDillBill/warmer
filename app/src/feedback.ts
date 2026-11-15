// Haptics, sounds and speech. All the "output" of Warmer lives here.
import * as Haptics from 'expo-haptics';
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
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

let speaking = false;
export function isSpeaking() {
  return speaking;
}

/** Speak and resolve when finished. Interrupts whatever was being said. */
export function say(text: string, opts: { rate?: number } = {}): Promise<void> {
  if (!text) return Promise.resolve();
  Speech.stop();
  speaking = true;
  return new Promise((resolve) => {
    const done = () => {
      speaking = false;
      resolve();
    };
    Speech.speak(text, { rate: opts.rate ?? 1.05, onDone: done, onStopped: done, onError: done });
  });
}

const STYLES = [
  Haptics.ImpactFeedbackStyle.Light,
  Haptics.ImpactFeedbackStyle.Light,
  Haptics.ImpactFeedbackStyle.Medium,
  Haptics.ImpactFeedbackStyle.Heavy,
];

const DIRECTION_EVERY_MS = 1600; // spoken correction cadence while searching
const NO_HAND_BLIP_MS = 1200; // soft blip while the hand is out of view
const NO_HAND_SPEAK_AFTER_MS = 2500; // then say so, at most every 8 s

/**
 * The guidance loop, designed for blind users (see CLAUDE.md §6):
 * - Searching: a constant beep, like a parking sensor. Closer = faster AND higher pitch, with a matching
 *   vibration on every beep that gets stronger as you get close.
 * - Every ~1.6 s, a short spoken correction for direction: "left", "up", "a little right".
 *   (Research: verbal corrections give precision, sound gives magnitude; use both.)
 * - On the button: a bright steady tone and a strong continuous buzz, plus "Tap" the first time.
 * - Hand not visible: a soft low blip, and after a moment "I can't see your hand".
 * onOn fires once per target, when the fingertip first settles on the button.
 */
export class GuideLoop {
  private finger: Point | null = null;
  private target: Box | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onSince = 0;
  private inZone = false;
  private announcedOn = false;
  private lastDirection = 0;
  private lastDirectionWord = '';
  private noHandSince = 0;
  private lastNoHandBlip = 0;
  private lastNoHandSpeech = 0;
  private lastOnTone = 0;
  sound = true;

  constructor(private onOn: () => void) {}

  set(finger: Point | null, target: Box | null) {
    if (target !== this.target) {
      this.announcedOn = false;
      this.inZone = false;
      this.onSince = 0;
      this.lastDirectionWord = '';
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
    if (!target) return 150;

    // Hand out of view: keep the user oriented instead of going silent.
    if (!this.finger) {
      if (!this.noHandSince) this.noHandSince = now;
      if (now - this.lastNoHandBlip > NO_HAND_BLIP_MS) {
        this.lastNoHandBlip = now;
        if (this.sound) play(noHand, speaking ? 0.3 : 0.8);
      }
      if (now - this.noHandSince > NO_HAND_SPEAK_AFTER_MS && now - this.lastNoHandSpeech > 8000 && !speaking) {
        this.lastNoHandSpeech = now;
        say("I can't see your hand. Reach toward the screen.");
      }
      this.inZone = false;
      this.onSince = 0;
      return 150;
    }
    this.noHandSince = 0;

    const g = guide(this.finger, target);
    if (g.state === 'on') {
      if (!this.onSince) this.onSince = now;
      if (now - this.onSince > 150) {
        if (!this.inZone) {
          this.inZone = true;
          playDing();
          if (!this.announcedOn) {
            this.announcedOn = true;
            this.onOn(); // says "Tap."
          }
        }
        // Steady confirmation while the finger stays on: strong buzz + bright tone.
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        if (this.sound && now - this.lastOnTone > 380) {
          this.lastOnTone = now;
          play(onTone, speaking ? 0.35 : 0.9);
        }
      }
      return 120;
    }

    // Searching: constant beep, faster and higher as you get closer.
    this.onSince = 0;
    this.inZone = false;
    const closeness = 1 - Math.min(1, g.distance / 0.55); // 0 far … 1 touching
    const pitch = Math.round(closeness * (beeps.length - 1));
    Haptics.impactAsync(STYLES[g.level]);
    if (this.sound) play(beeps[pitch], speaking ? 0.35 : 1);

    // Spoken direction, short and not too often.
    if (!speaking && now - this.lastDirection > DIRECTION_EVERY_MS) {
      const word = direction(this.finger, target, g.distance);
      if (word) {
        this.lastDirection = now;
        // Don't nag with the exact same word every time once they're close.
        if (word !== this.lastDirectionWord || g.state === 'far') say(word, { rate: 1.25 });
        this.lastDirectionWord = word;
      }
    }
    return g.pulseMs;
  }
}

/** "left" / "right" / "up" / "down", with "a little" when close. Camera frame, not mirrored. */
function direction(p: Point, b: Box, distance: number): string {
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  const dx = cx - p.x;
  const dy = cy - p.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const word = horizontal ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
  return distance < 0.12 ? `a little ${word}` : word;
}
