// URLs come from app/.env (EXPO_PUBLIC_*). `npx convex dev` writes EXPO_PUBLIC_CONVEX_URL for you.
export const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL ?? '';
// Demo mode (EXPO_PUBLIC_DEMO=1 in app/.env.local): sends the live camera to the /watch page for a projector,
// and keeps the screen bright. Leave it off for real use and for App Store builds.
export const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';
const EYES_BASE = process.env.EXPO_PUBLIC_EYES_URL ?? 'https://warmer-lake.vercel.app/eyes';
export const EYES_URL = DEMO ? `${EYES_BASE}${EYES_BASE.includes('?') ? '&' : '?'}broadcast=1` : EYES_BASE;
// Whose memories (Supermemory namespace). No accounts in the hackathon build: one demo user per phone.
export const USER_ID = process.env.EXPO_PUBLIC_USER_ID ?? 'demo';
