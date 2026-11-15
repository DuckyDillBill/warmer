// Hover correction. The camera looks at the screen from the front, so a finger hovering a few cm
// in front of the screen lines up with a spot farther from the image center than where it would
// actually touch. A closer hand also looks bigger. So: learn how big the palm looks AT the screen
// (the smallest it's been recently, since people touch the screen to tap) and pull the fingertip
// toward the image center by how much bigger it looks now.
//   touch point ≈ center + (tip − center) / r,   r = palmSize / palmSizeAtScreen
// Assumes the camera faces the screen roughly head-on (chest mount or stand).
type P = { x: number; y: number };

const WINDOW_MS = 20000;
const MAX_R = 1.5; // never correct more than this
const CENTER: P = { x: 0.5, y: 0.5 };

export class HoverCorrector {
  private samples: { t: number; size: number }[] = [];
  enabled = true;

  /** landmarks: MediaPipe hand (21 points). Returns the estimated touch point under the fingertip. */
  correct(hand: { x: number; y: number }[], now: number): P {
    const tip = { x: hand[8].x, y: hand[8].y };
    const size = palmSize(hand);
    if (!size) return tip;
    this.samples.push({ t: now, size });
    while (this.samples.length && now - this.samples[0].t > WINDOW_MS) this.samples.shift();
    if (!this.enabled || this.samples.length < 30) return tip; // still learning

    // "At the screen" size = 10th percentile of recent sizes (robust to a few bad detections).
    const sorted = this.samples.map((s) => s.size).sort((a, b) => a - b);
    const atScreen = sorted[Math.floor(sorted.length * 0.1)];
    const r = Math.min(MAX_R, Math.max(1, size / atScreen));
    if (r < 1.03) return tip; // basically touching
    return { x: CENTER.x + (tip.x - CENTER.x) / r, y: CENTER.y + (tip.y - CENTER.y) / r };
  }
}

/** Palm size: average of wrist→middle knuckle and index knuckle→pinky knuckle. Stable as fingers move. */
function palmSize(h: { x: number; y: number }[]): number {
  const d = (a: number, b: number) => Math.hypot(h[a].x - h[b].x, h[a].y - h[b].y);
  return (d(0, 9) + d(5, 17)) / 2;
}
