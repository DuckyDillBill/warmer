// Warmer's brain and memory.
//   Gemini vision (ai.ts) = the eyes: reads each screen and finds the button.
//   Gemini text (here)    = the brain: understands the person (their order, their answers) and checks the cart.
//   Supermemory           = the memory: past orders and choices, so "the usual" works.
// Keys live in Convex env vars (GEMINI_API_KEY, SUPERMEMORY_API_KEY), never in the app.
// Supermemory fails soft: if it's down, Warmer still works without memory.
// PINs, passwords and card numbers are never sent here: the PIN stays on the phone (CLAUDE.md §6).
import { action } from './_generated/server';
import { v } from 'convex/values';
import { gemini, STEP_MODELS } from './ai';

declare const process: { env: Record<string, string | undefined> };

const SM_URL = 'https://api.supermemory.ai';
const SM_TIMEOUT_MS = 4000;

// ---------- The brain: a short text-only Gemini call (the cheap, fast Flash-Lite chain) ----------
async function think(system: string, user: string): Promise<any> {
  return gemini([{ text: `${system}\n\n${user}\n\nReply in JSON.` }], STEP_MODELS());
}

// ---------- Supermemory (v5 REST: namespaces) ----------
const ns = (userId?: string) => `warmer_${(userId || 'demo').replace(/[^a-zA-Z0-9_-]/g, '')}`;

async function sm(path: string, body: unknown): Promise<any> {
  const key = process.env.SUPERMEMORY_API_KEY;
  if (!key) throw new Error('SUPERMEMORY_API_KEY not set');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SM_TIMEOUT_MS);
  try {
    const res = await fetch(`${SM_URL}${path}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`supermemory ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function recall(userId: string | undefined, query: string): Promise<string[]> {
  try {
    const out = await sm(`/ns/${ns(userId)}/search`, { query, searchMode: 'hybrid', limit: 6 });
    const memories: string[] = (out.results ?? [])
      .map((r: any) => r.memory ?? r.chunk ?? r.content ?? '')
      .filter((t: unknown) => typeof t === 'string' && t.trim())
      .slice(0, 6);
    console.log(`supermemory recalled ${memories.length} memories from ${ns(userId)}`);
    return memories;
  } catch (e) {
    console.warn(`supermemory search failed: ${(e as Error).message}`);
    return [];
  }
}

// Never store anything that looks like a secret, even by accident.
const scrub = (s: string) => s.replace(/\d{4,}/g, '[number]');

// ---------- actions ----------

/** What they said ("the usual but with a Sprite") + what we remember → a clear order checklist. */
export const planOrder = action({
  args: { said: v.string(), userId: v.optional(v.string()) },
  handler: async (_ctx, { said, userId }): Promise<{ goal: string; say: string; remembered: boolean }> => {
    const memories = await recall(userId, `${said}. Usual order, favorite items, and choices about meals, donations and tips.`);
    const out = await think(
      `You help a blind person order on a touchscreen kiosk. Turn what they said into one clear order checklist for another AI that taps through the kiosk.
- Resolve "the usual", "same as last time", "my favorite" from their memories. Apply changes they asked for ("but with a Sprite").
- Add a remembered choice (e.g. "skip donation", "make it a meal") ONLY if the memories show they always choose it. Never invent items.
- If they only said one item and no memories apply, keep it as they said.
Return JSON {"goal": string, "say": string}. "goal": the checklist, e.g. "Cheeseburger meal with a Sprite. Skip donation." "say": max 8 words to read back to them, e.g. "Cheeseburger meal and a Sprite."`,
      `They said: "${said}"\nTheir memories:\n${memories.length ? memories.map((m) => `- ${m}`).join('\n') : '(none)'}`,
    );
    const goal = String(out.goal ?? '').trim() || said;
    return { goal, say: String(out.say ?? '').trim() || said, remembered: memories.length > 0 };
  },
});

/** Their spoken reply to our question ("Make it a meal for $3?") → a clear short answer, or '' if unclear. */
export const interpretAnswer = action({
  args: { question: v.string(), heard: v.string() },
  handler: async (_ctx, { question, heard }): Promise<{ answer: string }> => {
    const out = await think(
      `A blind person was asked a question on a kiosk and answered out loud. Say what they chose, in 1 to 4 plain words (e.g. "yes", "no", "pay", "fix it", "yes, large").
If the reply doesn't answer the question (unclear, or they asked something back), return an empty answer.
Return JSON {"answer": string}.`,
      `Question: "${question}"\nThey said: "${heard}"`,
    );
    return { answer: String(out.answer ?? '').trim() };
  },
});

/** Before paying: does the cart match what they asked for? */
export const checkCart = action({
  args: { goal: v.string(), cart: v.string() },
  handler: async (_ctx, { goal, cart }): Promise<{ ok: boolean; say: string }> => {
    const out = await think(
      `A blind person can't see their cart before paying. Compare their order to the cart read from the screen.
Extras they agreed to along the way (a meal upgrade, a donation) are fine. Flag only real problems: a missing item, a wrong item, a wrong size, a wrong quantity.
Return JSON {"ok": boolean, "say": string}. If not ok, "say" is one short sentence naming the problem, e.g. "Your cart has a Coke, but you asked for a Sprite."`,
      `Their order: "${goal}"\nCart on screen: "${cart}"`,
    );
    return { ok: out.ok !== false, say: String(out.say ?? '').trim() };
  },
});

/** After the order: remember what they got and the choices they made. */
export const rememberOrder = action({
  args: { userId: v.optional(v.string()), said: v.string(), goal: v.string(), history: v.array(v.string()), place: v.optional(v.string()) },
  handler: async (_ctx, { userId, said, goal, history, place }): Promise<{ ok: boolean }> => {
    const choices = history.filter((h) => h.startsWith('They answered')).map(scrub);
    const tapped = history.filter((h) => h.startsWith('Tapped')).map(scrub);
    const content = [
      `Order${place ? ` at ${place}` : ''} on ${new Date().toISOString().slice(0, 10)}.`,
      `They asked for: "${scrub(said)}".`,
      `Final order: ${scrub(goal)}.`,
      choices.length ? `Their choices: ${choices.join('; ')}.` : '',
      tapped.length ? `Buttons pressed: ${tapped.join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
    try {
      const out = await sm(`/ns/${ns(userId)}/document`, { content, dreaming: 'instant', metadata: { type: 'order' } });
      console.log(`supermemory saved order to ${ns(userId)} (${out?.status ?? 'ok'}): ${content.slice(0, 120)}`);
      return { ok: true };
    } catch (e) {
      console.warn(`supermemory add failed: ${(e as Error).message}`);
      return { ok: false };
    }
  },
});
