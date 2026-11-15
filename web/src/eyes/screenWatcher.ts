// Detects when the touchscreen in front of the camera changes (e.g. after a tap),
// while ignoring the user's moving hand. Also produces a small perceptual hash of the
// screen so the backend can recognize screens it has already mapped.
type Box = [number, number, number, number];

const N = 24; // grid size (N x N cells)
const HAND_PAD = 0.08; // extra margin around the hand, normalized
const PIXEL_DIFF = 18; // luminance difference that counts a cell as changed (0–255)
const STABLE_MS = 600; // a change must settle this long before it counts

export class ScreenWatcher {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private background = new Float32Array(N * N); // latest view of the screen, hand cells keep old values
  private reference: Float32Array | null = null; // the screen as of the last accepted change
  private prev = new Float32Array(N * N);
  private hand: Box | null = null;
  private changeThreshold = 0.08; // fraction of cells that must change
  private candidateSince = 0;
  private hasBackground = false;
  private startedAt = 0;

  constructor() {
    this.canvas.width = N;
    this.canvas.height = N;
  }

  setHand(box: Box | null) {
    this.hand = box
      ? [box[0] - HAND_PAD, box[1] - HAND_PAD, box[2] + HAND_PAD, box[3] + HAND_PAD]
      : null;
  }

  /** 'high' catches small changes like a PIN dot filling in. */
  setSensitivity(v: 'normal' | 'high') {
    this.changeThreshold = v === 'high' ? 0.012 : 0.08;
  }

  private covered(i: number, j: number): boolean {
    if (!this.hand) return false;
    const x0 = i / N, y0 = j / N, x1 = (i + 1) / N, y1 = (j + 1) / N;
    const [hx0, hy0, hx1, hy1] = this.hand;
    // The arm extends below the hand, so also mask everything below the hand box.
    return x1 > hx0 && x0 < hx1 && y1 > hy0 && hy1 > hy0;
  }

  /** Returns true exactly once when a settled screen change is detected. */
  update(video: HTMLVideoElement, now: number): boolean {
    if (!this.startedAt) this.startedAt = now;
    this.ctx.drawImage(video, 0, 0, N, N);
    const px = this.ctx.getImageData(0, 0, N, N).data;
    this.prev.set(this.background);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        if (this.hasBackground && this.covered(i, j)) continue;
        const p = k * 4;
        this.background[k] = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
      }
    }
    this.hasBackground = true;

    // Wait a moment after start, then take the first reference.
    if (!this.reference) {
      if (now - this.startedAt > 800) this.reference = this.background.slice();
      return false;
    }

    const changed = this.fractionChanged(this.background, this.reference);
    const moving = this.fractionChanged(this.background, this.prev);

    if (changed > this.changeThreshold) {
      if (moving > 0.01) {
        this.candidateSince = now; // still animating / transitioning
      } else if (this.candidateSince && now - this.candidateSince > STABLE_MS) {
        this.reference = this.background.slice();
        this.candidateSince = 0;
        return true;
      } else if (!this.candidateSince) {
        this.candidateSince = now;
      }
    } else {
      this.candidateSince = 0;
    }
    return false;
  }

  private fractionChanged(a: Float32Array, b: Float32Array): number {
    let n = 0, total = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (this.covered(i, j)) continue;
        total++;
        if (Math.abs(a[j * N + i] - b[j * N + i]) > PIXEL_DIFF) n++;
      }
    }
    return total ? n / total : 0;
  }

  /** 64-bit difference hash (16 hex chars) of the current screen, hand excluded. */
  hash(): string {
    // Sample a 9x8 grid from the background and compare horizontal neighbours.
    const g = (x: number, y: number) =>
      this.background[Math.min(N - 1, Math.floor((y / 8) * N)) * N + Math.min(N - 1, Math.floor((x / 9) * N))];
    let bits = '';
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += g(x, y) > g(x + 1, y) ? '1' : '0';
    let hex = '';
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  }
}
