// Haptics, sounds and speech. All the "output" of Warmer lives here.
import * as Haptics from 'expo-haptics';
import * as Speech from 'expo-speech';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { guide, type Box, type Point } from './guidance';

let ding: AudioPlayer | null = null;
let tick: AudioPlayer | null = null;

export async function initAudio() {
  await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
  ding = createAudioPlayer(require('../assets/ding.wav'));
  tick = createAudioPlayer(require('../assets/tick.wav'));
}

function play(p: AudioPlayer | null) {
  if (!p) return;
  try {
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

/**
 * Runs the warmer… warmer… loop. Call update() with the latest fingertip and target;
 * onOn fires once when the fingertip settles on the button.
 */
export class GuideLoop {
  private finger: Point | null = null;
  private target: Box | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onSince = 0;
  private announcedOn = false;
  sound = true; // also play a soft tick with each pulse

  constructor(private onOn: () => void) {}

  set(finger: Point | null, target: Box | null) {
    if (target !== this.target) {
      this.announcedOn = false;
      this.onSince = 0;
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
      const g = guide(this.finger, this.target);
      let next = 120;
      if (g.state === 'on') {
        if (!this.onSince) this.onSince = Date.now();
        if (!this.announcedOn && Date.now() - this.onSince > 150) {
          this.announcedOn = true;
          playDing();
          this.onOn();
        }
        next = 100;
      } else {
        this.onSince = 0;
        if (g.state !== 'none') {
          Haptics.impactAsync(STYLES[g.level]);
          if (this.sound && !speaking) play(tick);
          next = g.pulseMs;
        }
      }
      this.timer = setTimeout(step, next);
    };
    step();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
