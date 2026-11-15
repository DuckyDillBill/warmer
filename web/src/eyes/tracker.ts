// Keeps the target box glued to its button when the phone (or the kiosk) moves.
// When a target is set we remember a small grayscale copy of the frame. Every few frames we find how
// far a grid of textured patches has shifted since then (ignoring the hand) and take the median shift.
// The box is drawn and reported at target + shift. Pure translation: good enough for a handheld phone.
type Box = [number, number, number, number];

const W = 128; // working resolution (16:9)
const H = 72;
const HALF = 7; // patch half-size in px (patches are 15x15)
const R = 10; // search radius in px per update, around the last known shift (kept small: this runs on the phone)
const GX = 4; // anchor grid (12 patches: light enough not to slow hand tracking)
const GY = 3;
const MIN_TEXTURE = 8; // skip flat patches (mean abs deviation in gray levels)
const MAX_ERR = 14; // reject matches worse than this (mean abs difference)

export class ShiftTracker {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private ref: Float32Array | null = null;
  private snap: Float32Array | null = null; // frame Gemini was shown (taken at captureFrame time)
  private dx = 0; // px at working resolution
  private dy = 0;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
  }

  /** Call when a frame is sent to Gemini: that frame is what the box coordinates refer to. */
  snapshot(video: HTMLVideoElement) {
    this.snap = this.gray(video);
  }

  /** Call when a new target is set. The reference is the frame Gemini saw (so any movement during the
   *  AI call is corrected straight away), falling back to the current frame. */
  reset(video: HTMLVideoElement) {
    this.ref = this.snap ?? this.gray(video);
    this.snap = null;
    this.dx = 0;
    this.dy = 0;
  }

  clear() {
    this.ref = null;
    this.dx = 0;
    this.dy = 0;
  }

  /** Normalized shift (0–1 of the frame) of the scene since reset(). */
  get shift() {
    return { x: this.dx / W, y: this.dy / H };
  }

  /** Box moved by the current shift. */
  apply(b: Box): Box {
    const { x, y } = this.shift;
    return [b[0] + x, b[1] + y, b[2] + x, b[3] + y];
  }

  update(video: HTMLVideoElement, hand: Box | null) {
    if (!this.ref) return;
    const cur = this.gray(video);
    const ref = this.ref;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let gy = 0; gy < GY; gy++) {
      for (let gx = 0; gx < GX; gx++) {
        const cx = Math.round(((gx + 0.5) / GX) * W);
        const cy = Math.round(((gy + 0.5) / GY) * H);
        // Ignore patches under (or near) the hand: the finger moving isn't the scene moving.
        if (hand && overlaps(cx, cy, hand)) continue;
        if (texture(ref, cx, cy) < MIN_TEXTURE) continue;
        const m = this.match(ref, cur, cx, cy);
        if (m) {
          xs.push(m.dx);
          ys.push(m.dy);
        }
      }
    }
    if (xs.length < 3) return; // not enough agreement (e.g. the screen just changed): keep the last shift
    const mx = median(xs);
    const my = median(ys);
    // Light smoothing so the box doesn't shimmer.
    this.dx += (mx - this.dx) * 0.6;
    this.dy += (my - this.dy) * 0.6;
  }

  private match(ref: Float32Array, cur: Float32Array, cx: number, cy: number) {
    const refMean = mean(ref, cx, cy);
    let best = Infinity;
    let bx = 0;
    let by = 0;
    const sx = Math.round(this.dx);
    const sy = Math.round(this.dy);
    for (let oy = sy - R; oy <= sy + R; oy++) {
      for (let ox = sx - R; ox <= sx + R; ox++) {
        const qx = cx + ox;
        const qy = cy + oy;
        if (qx - HALF < 0 || qy - HALF < 0 || qx + HALF >= W || qy + HALF >= H) continue;
        const curMean = mean(cur, qx, qy);
        let err = 0;
        for (let j = -HALF; j <= HALF; j++) {
          const r0 = (cy + j) * W + cx;
          const c0 = (qy + j) * W + qx;
          for (let i = -HALF; i <= HALF; i++) {
            err += Math.abs(ref[r0 + i] - refMean - (cur[c0 + i] - curMean));
          }
          if (err >= best) break;
        }
        if (err < best) {
          best = err;
          bx = ox;
          by = oy;
        }
      }
    }
    const n = (2 * HALF + 1) ** 2;
    return best / n <= MAX_ERR ? { dx: bx, dy: by } : null;
  }

  private gray(video: HTMLVideoElement): Float32Array {
    this.ctx.drawImage(video, 0, 0, W, H);
    const px = this.ctx.getImageData(0, 0, W, H).data;
    const g = new Float32Array(W * H);
    for (let k = 0, p = 0; k < g.length; k++, p += 4) g[k] = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
    return g;
  }
}

function overlaps(cx: number, cy: number, hand: Box): boolean {
  const pad = 0.06;
  const x0 = (cx - HALF - R) / W, x1 = (cx + HALF + R) / W;
  const y0 = (cy - HALF - R) / H, y1 = (cy + HALF + R) / H;
  // The arm extends below the hand, so treat everything below the hand's top as covered too.
  return x1 > hand[0] - pad && x0 < hand[2] + pad && y1 > hand[1] - pad;
}

function mean(a: Float32Array, cx: number, cy: number): number {
  let s = 0;
  for (let j = -HALF; j <= HALF; j++) for (let i = -HALF; i <= HALF; i++) s += a[(cy + j) * W + cx + i];
  return s / (2 * HALF + 1) ** 2;
}

function texture(a: Float32Array, cx: number, cy: number): number {
  if (cx - HALF < 0 || cy - HALF < 0 || cx + HALF >= W || cy + HALF >= H) return 0;
  const m = mean(a, cx, cy);
  let s = 0;
  for (let j = -HALF; j <= HALF; j++) for (let i = -HALF; i <= HALF; i++) s += Math.abs(a[(cy + j) * W + cx + i] - m);
  return s / (2 * HALF + 1) ** 2;
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}
