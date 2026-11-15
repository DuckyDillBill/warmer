// URLs come from app/.env (EXPO_PUBLIC_*). `npx convex dev` writes EXPO_PUBLIC_CONVEX_URL for you.
export const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL ?? '';
export const EYES_URL = process.env.EXPO_PUBLIC_EYES_URL ?? 'https://warmer-lake.vercel.app/eyes';
