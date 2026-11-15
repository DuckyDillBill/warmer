// Keeps following the fingertip by its appearance when MediaPipe loses the hand
// (usually because the palm left the frame while the fingertip is still visible).
// While the hand IS detected we keep refreshing a small picture of the fingertip.
// When it's lost, we search for that picture around the last position, frame by frame,
// for up to MAX_MS. A poor match ends it: better to report "no hand" than a wrong finger.
type P = { x: number; y: number };

const W = 320; // working resolution (16:9)
const H = 180;
const HALF = 10; // template is 21x21 px
const R = 14; // search radius per frame
const MAX_MS = 1500;
const MAX_ERR = 16; // mean abs difference (gray levels) to accept a match

export class FingertipTracker {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private template: Float32Array | null = null;
  private pos: { x: number; y: number } | null = null; // pixels, working res
  private lostAt = 0;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
  }

  /** Call (every few frames) while MediaPipe sees the hand. */
  learn(video: HTMLVideoElement, tip: P) {
    const x = Math.round(tip.x * W);
    const y = Math.round(tip.y * H);
    if (x - HALF < 0 || y - HALF < 0 || x + HALF >= W || y + HALF >= H) return;
    const g = this.gray(video);
    const t = new Float32Array((2 * HALF + 1) ** 2);
    let k = 0;
    for (let j = -HALF; j <= HALF; j++) for (let i = -HALF; i <= HALF; i++) t[k++] = g[(y + j) * W + x + i];
    this.template = t;
    this.pos = { x, y };
    this.lostAt = 0;
  }

  /** Call when MediaPipe has no hand. Returns the fingertip if we can still follow it. */
  track(video: HTMLVideoElement, now: number): P | null {
    if (!this.template || !this.pos) return null;
    if (!this.lostAt) this.lostAt = now;
    if (now - this.lostAt > MAX_MS) return this.forget();
    const g = this.gray(video);
    const tMean = this.template.reduce((a, b) => a + b, 0) / this.template.length;
    let best = Infinity;
    let bx = 0;
    let by = 0;
    for (let oy = -R; oy <= R; oy += 1) {
      for (let ox = -R; ox <= R; ox += 1) {
        const cx = this.pos.x + ox;
        const cy = this.pos.y + oy;
        if (cx - HALF < 0 || cy - HALF < 0 || cx + HALF >= W || cy + HALF >= H) continue;
        let m = 0;
        for (let j = -HALF; j <= HALF; j++) for (let i = -HALF; i <= HALF; i++) m += g[(cy + j) * W + cx + i];
        m /= this.template.length;
        let err = 0;
        let k = 0;
        for (let j = -HALF; j <= HALF && err < best; j++) {
          for (let i = -HALF; i <= HALF; i++) err += Math.abs(g[(cy + j) * W + cx + i] - m - (this.template[k++] - tMean));
        }
        if (err < best) {
          best = err;
          bx = cx;
          by = cy;
        }
      }
    }
    if (best / this.template.length > MAX_ERR) return this.forget();
    this.pos = { x: bx, y: by };
    return { x: bx / W, y: by / H };
  }

  forget(): null {
    this.template = null;
    this.pos = null;
    this.lostAt = 0;
    return null;
  }

  private gray(video: HTMLVideoElement): Float32Array {
    this.ctx.drawImage(video, 0, 0, W, H);
    const px = this.ctx.getImageData(0, 0, W, H).data;
    const g = new Float32Array(W * H);
    for (let k = 0, p = 0; k < g.length; k++, p += 4) g[k] = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
    return g;
  }
}
