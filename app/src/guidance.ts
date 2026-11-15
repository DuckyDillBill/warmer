// Pure function: where is the fingertip relative to the target → how strong the feedback is.
// This is the "feel" of Warmer. Tune constants here. See CLAUDE.md §6.
export type Box = [number, number, number, number]; // [x0, y0, x1, y1], normalized 0–1, top-left origin
export type Point = { x: number; y: number };
export type GuidanceState = 'none' | 'far' | 'near' | 'on';
export type Guidance = { state: GuidanceState; pulseMs: number; level: 0 | 1 | 2 | 3; distance: number };

const ON_ZONE = 0.6; // center 60% of the button counts as "on"
const FAR_MS = 600; // pulse interval when far
const NEAR_MS = 70; // pulse interval when almost there
const NEAR_DIST = 0.12; // below this distance we call it "near"

export function inOnZone(p: Point, b: Box): boolean {
  const [x0, y0, x1, y1] = b;
  const mx = ((1 - ON_ZONE) / 2) * (x1 - x0);
  const my = ((1 - ON_ZONE) / 2) * (y1 - y0);
  return p.x >= x0 + mx && p.x <= x1 - mx && p.y >= y0 + my && p.y <= y1 - my;
}

export function guide(p: Point | null, b: Box | null): Guidance {
  if (!p || !b) return { state: 'none', pulseMs: 0, level: 0, distance: 1 };
  if (inOnZone(p, b)) return { state: 'on', pulseMs: 0, level: 3, distance: 0 };
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  // Distance to the box center, scaled so the far corner of the frame ≈ 1.
  const d = Math.min(1, Math.hypot(p.x - cx, p.y - cy) / Math.SQRT2);
  // Ease so the change is most noticeable when you're getting close.
  const t = Math.pow(d, 0.6);
  const pulseMs = Math.round(NEAR_MS + (FAR_MS - NEAR_MS) * t);
  const level: 1 | 2 | 3 = d < 0.06 ? 3 : d < NEAR_DIST ? 2 : 1;
  return { state: d < NEAR_DIST ? 'near' : 'far', pulseMs, level, distance: d };
}

/** Exponential smoothing so the fingertip doesn't jitter. */
export function smooth(prev: Point | null, next: Point, alpha = 0.5): Point {
  if (!prev) return next;
  return { x: prev.x + alpha * (next.x - prev.x), y: prev.y + alpha * (next.y - prev.y) };
}
