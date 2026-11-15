// Tiny Convex client over plain HTTP, so the web pages need no extra npm package.
// The deployment URL is public (it's also baked into the app builds). Override with VITE_CONVEX_URL on Vercel.
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
export const CONVEX_URL = env.VITE_CONVEX_URL || 'https://rugged-gerbil-90.convex.cloud';

async function call<T>(kind: 'query' | 'mutation', path: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${CONVEX_URL}/api/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, args, format: 'json' }),
  });
  const data = await res.json();
  if (data.status !== 'success') throw new Error(data.errorMessage || `Convex ${kind} ${path} failed`);
  return data.value as T;
}

export const convexQuery = <T>(path: string, args: Record<string, unknown> = {}) => call<T>('query', path, args);
export const convexMutation = <T>(path: string, args: Record<string, unknown> = {}) => call<T>('mutation', path, args);
