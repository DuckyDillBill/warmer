// URLs come from app/.env (EXPO_PUBLIC_*). `npx convex dev` writes EXPO_PUBLIC_CONVEX_URL for you.
export const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL ?? '';
// Demo mode (the toggle in the app's top right): the hackathon screen with camera view and extra buttons, the
// live camera sent to the /watch page for a projector, and the screen kept bright. Off = one big button.
// EXPO_PUBLIC_DEMO=1 only sets what the toggle starts on the very first launch.
export const DEMO_DEFAULT = process.env.EXPO_PUBLIC_DEMO === '1';
const EYES_BASE = process.env.EXPO_PUBLIC_EYES_URL ?? 'https://warmer-lake.vercel.app/eyes';
/** The camera page. In demo mode it also broadcasts to /watch. */
export const eyesUrl = (demo: boolean) => (demo ? `${EYES_BASE}${EYES_BASE.includes('?') ? '&' : '?'}broadcast=1` : EYES_BASE);
// Public pages Apple asks for (hosted with the camera page on Vercel).
export const PRIVACY_URL = 'https://warmer-lake.vercel.app/privacy';
export const SUPPORT_URL = 'https://warmer-lake.vercel.app/support';
