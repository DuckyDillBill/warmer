// Fingertip MARKER tracking: a small bright sticker (blue or pink) on the fingernail.
// Why: hand tracking finds the palm first, so with the palm out of view there is no finger.
// A colored marker can be found directly in every frame, palm or no palm. (Assistive camera
// systems like CamIO track a marked stylus for the same reason.)
//
// No setup: while the hand IS detected, we look at the color right at the fingertip. If it's
// clearly not skin (strongly saturated) for a run of frames, that's the marker: lock its hue.
// From then on we find that color every frame. Bare-hand tracking stays as the fallback.
type P = { x: number; y: number };

const W = 320; // working resolution (16:9)
const H = 180;
const HUE_TOL = 16; // degrees
const MIN_SAT = 0.38;
const MIN_VAL = 0.25;
const MIN_PIXELS = 5;
const LOCK_FRAMES = 6; // consecutive saturated samples at the fingertip to lock a marker color
const WINDOW = 40; // px search window around the last position
const LOST_FULL_SCAN_MS = 800; // after this long without a match, scan the whole frame

export class MarkerTracker {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  hue: number | null = null; // locked marker hue (degrees)
  private candidateHue: number[] = [];
  private notMarker = 0;
  private pos: { x: number; y: number } | null = null;
  private lastSeen = 0;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
  }

  get locked() {
    return this.hue !== null;
  }

  /** While MediaPipe sees the hand: sample the color at the fingertip to (re)learn the marker. */
  calibrate(video: HTMLVideoElement, tip: P, knuckle: P) {
    // Sample a little in from the very tip, toward the last knuckle (where a nail sticker sits).
    const sx = Math.round((tip.x * 0.7 + knuckle.x * 0.3) * W);
    const sy = Math.round((tip.y * 0.7 + knuckle.y * 0.3) * H);
    if (sx < 2 || sy < 2 || sx >= W - 2 || sy >= H - 2) return;
    // drawImage source coords are in video pixels: rescale from the working resolution.
    const vx = (sx / W) * video.videoWidth;
    const vy = (sy / H) * video.videoHeight;
    this.ctx.drawImage(video, vx - 3, vy - 3, 6, 6, 0, 0, 6, 6);
    const px = this.ctx.getImageData(0, 0, 6, 6).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < px.length; i += 4) {
      r += px[i];
      g += px[i + 1];
      b += px[i + 2];
    }
    const n = px.length / 4;
    const [h, s, v] = hsv(r / n, g / n, b / n);
    const markerLike = s > 0.45 && v > 0.3 && !(h < 45 || h > 340); // saturated and not skin/red-orange
    if (markerLike) {
      this.notMarker = 0;
      this.candidateHue.push(h);
      if (this.candidateHue.length > LOCK_FRAMES) this.candidateHue.shift();
      if (this.candidateHue.length === LOCK_FRAMES) {
        const sorted = [...this.candidateHue].sort((a, b) => a - b);
        const spread = hueDist(sorted[0], sorted[sorted.length - 1]);
        if (spread < 25) this.hue = sorted[sorted.length >> 1];
      }
    } else {
      this.candidateHue = [];
      // Marker taken off: the fingertip has looked like plain skin for a while.
      if (++this.notMarker > 45) this.hue = null;
    }
  }

  /** Find the marker in this frame. Returns its center (normalized) or null. */
  find(video: HTMLVideoElement, now: number): P | null {
    if (this.hue === null) return null;
    this.ctx.drawImage(video, 0, 0, W, H);
    const px = this.ctx.getImageData(0, 0, W, H).data;
    const full = !this.pos || now - this.lastSeen > LOST_FULL_SCAN_MS;
    const x0 = full ? 0 : Math.max(0, this.pos!.x - WINDOW);
    const x1 = full ? W - 1 : Math.min(W - 1, this.pos!.x + WINDOW);
    const y0 = full ? 0 : Math.max(0, this.pos!.y - WINDOW);
    const y1 = full ? H - 1 : Math.min(H - 1, this.pos!.y + WINDOW);

    // Vote matching pixels into 8x8 cells; take the busiest cell and average the matches around it.
    const CELL = 8;
    const cols = Math.ceil(W / CELL);
    const votes = new Uint16Array(cols * Math.ceil(H / CELL));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = (y * W + x) * 4;
        if (this.match(px[p], px[p + 1], px[p + 2])) votes[((y / CELL) | 0) * cols + ((x / CELL) | 0)]++;
      }
    }
    let best = -1, bestV = 0;
    for (let i = 0; i < votes.length; i++) if (votes[i] > bestV) { bestV = votes[i]; best = i; }
    if (bestV < MIN_PIXELS) return null;
    const cx = (best % cols) * CELL + CELL / 2;
    const cy = ((best / cols) | 0) * CELL + CELL / 2;
    let sx = 0, sy = 0, n = 0;
    for (let y = Math.max(0, cy - 12); y < Math.min(H, cy + 12); y++) {
      for (let x = Math.max(0, cx - 12); x < Math.min(W, cx + 12); x++) {
        const p = (y * W + x) * 4;
        if (this.match(px[p], px[p + 1], px[p + 2])) { sx += x; sy += y; n++; }
      }
    }
    if (n < MIN_PIXELS) return null;
    this.pos = { x: sx / n, y: sy / n };
    this.lastSeen = now;
    return { x: this.pos.x / W, y: this.pos.y / H };
  }

  private match(r: number, g: number, b: number): boolean {
    const [h, s, v] = hsv(r, g, b);
    return s >= MIN_SAT && v >= MIN_VAL && hueDist(h, this.hue!) <= HUE_TOL;
  }
}

function hsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
