// Sends what the phone sees to Convex so the projector's /watch page can show it live.
// Small and throttled: fingertip + target ~10/s, a low-res camera snapshot ~2/s.
import { ConvexClient } from 'convex/browser';
import { anyApi } from 'convex/server';

type Box = [number, number, number, number];
type Point = { x: number; y: number };

const STATE_MS = 100;
const FRAME_MS = 250; // ~4 fps on the TV
const FRAME_W = 540; // sharp enough for a big screen, still small

export class Broadcaster {
  private client: ConvexClient | null;
  private lastState = 0;
  private lastFrame = 0;
  private lastKey = '';
  private canvas = document.createElement('canvas');
  private sendingFrame = false;

  constructor(url: string | undefined) {
    this.client = url ? new ConvexClient(url) : null;
  }

  get enabled() {
    return !!this.client;
  }

  /** PIN entry: blank out the projector (no camera, no finger, no target). */
  hide(now: number) {
    if (!this.client || now - this.lastState < 500) return;
    this.lastState = now;
    this.lastKey = '';
    this.client.mutation(anyApi.live.setState, { finger: null, target: null, label: '🔒 PIN entry (hidden)' }).catch(() => {});
  }

  tick(now: number, video: HTMLVideoElement, finger: Point | null, target: Box | null, label: string) {
    if (!this.client) return;
    if (now - this.lastState > STATE_MS) {
      const f = finger ? { x: +finger.x.toFixed(3), y: +finger.y.toFixed(3) } : null;
      const key = JSON.stringify([f, target, label]);
      // Skip identical updates, but still refresh once a second so the watch page knows we're alive.
      if (key !== this.lastKey || now - this.lastState > 1000) {
        this.lastKey = key;
        this.lastState = now;
        this.client.mutation(anyApi.live.setState, { finger: f, target, label }).catch(() => {});
      }
    }
    if (!this.sendingFrame && now - this.lastFrame > FRAME_MS && video.videoWidth) {
      this.lastFrame = now;
      const s = FRAME_W / video.videoWidth;
      this.canvas.width = FRAME_W;
      this.canvas.height = Math.round(video.videoHeight * s);
      this.canvas.getContext('2d')!.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
      const jpeg = this.canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
      this.sendingFrame = true;
      this.client
        .mutation(anyApi.live.setFrame, { jpeg })
        .catch(() => {})
        .finally(() => (this.sendingFrame = false));
    }
  }
}
