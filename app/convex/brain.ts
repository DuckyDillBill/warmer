// Warmer's brain.
//   Gemini vision (ai.ts) = the eyes: reads each screen and finds the button.
//   Gemini text (here)    = the brain: understands the person (their order, their answers) and checks the cart.
// The key lives in a Convex env var (GEMINI_API_KEY), never in the app.
// PINs, passwords and card numbers are never sent here: the PIN stays on the phone (CLAUDE.md §6).
import { action } from './_generated/server';
import { v } from 'convex/values';
import { gemini, STEP_MODELS } from './ai';

declare const process: { env: Record<string, string | undefined> };


// ---------- The brain: a short text-only Gemini call (the cheap, fast Flash-Lite chain) ----------
async function think(system: string, user: string): Promise<any> {
  return gemini([{ text: `${system}\n\n${user}\n\nReply in JSON.` }], STEP_MODELS());
}

// ---------- actions ----------

/** What they said ("a cheeseburger, and make it a meal") → a clear order checklist. */
export const planOrder = action({
  args: { said: v.string() },
  handler: async (_ctx, { said }): Promise<{ goal: string; say: string }> => {
    const out = await think(
      `You help a blind person order on a touchscreen kiosk. Turn what they said into one clear order checklist for another AI that taps through the kiosk.
- Keep exactly what they asked for, including sizes, extras and choices they named ("make it a meal", "no donation"). Never invent items.
Return JSON {"goal": string, "say": string}. "goal": the checklist, e.g. "Cheeseburger meal with a Sprite. Skip donation." "say": max 8 words to read back to them, e.g. "Cheeseburger meal and a Sprite."`,
      `They said: "${said}"`,
    );
    const goal = String(out.goal ?? '').trim() || said;
    return { goal, say: String(out.say ?? '').trim() || said };
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
