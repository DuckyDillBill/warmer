// Snaps the AI's rough box to the button's real edges, on the phone, in a few milliseconds.
// Kiosk buttons are solid-colored shapes. We sample the button's background color at a few points
// inside the AI box, flood-fill outward over pixels of that color (within a margin around the box),
// and take the bounding box of that region. If the result looks wrong, we keep the AI box.
type Box = [number, number, number, number];

const W = 256; // working resolution (16:9)
const H = 144;
const COLOR_TOL = 38; // max RGB distance from the button color
const MARGIN = 0.6; // search up to 60% of the box size beyond each edge

export class BoxRefiner {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private snap: Uint8ClampedArray | null = null;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
  }

  /** Remember the frame the AI was shown, so the box is snapped against the same picture. */
  snapshot(video: HTMLVideoElement) {
    this.ctx.drawImage(video, 0, 0, W, H);
    this.snap = this.ctx.getImageData(0, 0, W, H).data;
  }

  refine(box: Box, video: HTMLVideoElement): Box {
    const px = this.snap ?? (this.snapshot(video), this.snap!);
    this.snap = null;
    const [bx0, by0, bx1, by1] = box;
    const bw = bx1 - bx0;
    const bh = by1 - by0;
    if (bw <= 0 || bh <= 0) return box;

    // Search window: the box plus a margin, in pixels.
    const wx0 = Math.max(0, Math.floor((bx0 - bw * MARGIN) * W));
    const wy0 = Math.max(0, Math.floor((by0 - bh * MARGIN) * H));
    const wx1 = Math.min(W - 1, Math.ceil((bx1 + bw * MARGIN) * W));
    const wy1 = Math.min(H - 1, Math.ceil((by1 + bh * MARGIN) * H));

    // Button color: the most common of 8 samples taken just inside the box edges (the middle often
    // holds a picture or text, the edges hold the button's fill).
    const samples: [number, number][] = [];
    for (const fx of [0.15, 0.5, 0.85]) for (const fy of [0.15, 0.5, 0.85]) if (!(fx === 0.5 && fy === 0.5)) samples.push([fx, fy]);
    const colors = samples.map(([fx, fy]) => rgb(px, Math.round((bx0 + bw * fx) * W), Math.round((by0 + bh * fy) * H)));
    let base = colors[0];
    let bestVotes = -1;
    for (const c of colors) {
      const votes = colors.filter((d) => dist(c, d) < COLOR_TOL).length;
      if (votes > bestVotes) {
        bestVotes = votes;
        base = c;
      }
    }
    if (bestVotes < 4) return box; // no clear button color (e.g. a photo-only tile)

    // Flood fill from every sample that matches the button color.
    const seen = new Uint8Array(W * H);
    const stack: number[] = [];
    samples.forEach(([fx, fy], i) => {
      if (dist(colors[i], base) < COLOR_TOL) {
        const x = Math.round((bx0 + bw * fx) * W);
        const y = Math.round((by0 + bh * fy) * H);
        stack.push(y * W + x);
      }
    });
    let minX = W, minY = H, maxX = -1, maxY = -1, count = 0;
    while (stack.length) {
      const k = stack.pop()!;
      if (seen[k]) continue;
      seen[k] = 1;
      const x = k % W;
      const y = (k / W) | 0;
      if (x < wx0 || x > wx1 || y < wy0 || y > wy1) continue;
      if (dist(rgb(px, x, y), base) >= COLOR_TOL) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      stack.push(k - 1, k + 1, k - W, k + W);
    }
    if (count < 20) return box;

    const r: Box = [minX / W, minY / H, (maxX + 1) / W, (maxY + 1) / H];
    const area = (r[2] - r[0]) * (r[3] - r[1]);
    const aiArea = bw * bh;
    const cx = (r[0] + r[2]) / 2;
    const cy = (r[1] + r[3]) / 2;
    // Sanity checks: similar size, and its center inside the AI box. Otherwise the fill leaked into
    // the background (same color as the button) or got stuck on a small detail.
    const sizeOk = area > aiArea * 0.45 && area < aiArea * 1.8;
    const centerOk = cx > bx0 && cx < bx1 && cy > by0 && cy < by1;
    const touchesWindow = minX <= wx0 || minY <= wy0 || maxX >= wx1 || maxY >= wy1; // leaked to the edge
    return sizeOk && centerOk && !touchesWindow ? r : box;
  }
}

function rgb(px: Uint8ClampedArray, x: number, y: number): [number, number, number] {
  const p = (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4;
  return [px[p], px[p + 1], px[p + 2]];
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
