// AI actions for Warmer. The Gemini key lives in Convex env vars (GEMINI_API_KEY), never in the app.
// Contract: see CLAUDE.md §5. All boxes returned are [x0, y0, x1, y1], normalized 0–1, top-left origin.
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';

// Convex actions run on Node-like runtime; declare process.env so tsc doesn't need @types/node.
declare const process: { env: Record<string, string | undefined> };

type Button = { label: string; box: number[]; kind: string };

// Speed matters more than depth: thinking is turned down to the minimum.
// Each model has its own rate limit and its own outages, so if one is overloaded (503),
// out of quota (429), slow, or unavailable, we move straight on to the next one.
// Override the first choice with Convex env vars GEMINI_MODEL / GEMINI_STEP_MODEL.
const VISION_MODELS = () => [process.env.GEMINI_MODEL || 'gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-3.5-flash-lite'];
const STEP_MODELS = () => [process.env.GEMINI_STEP_MODEL || 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-3.6-flash'];
const PER_MODEL_TIMEOUT_MS = 12000;
const HASH_MATCH_BITS = 6; // mapScreen: screens within this many differing bits count as "the same screen"
const READ_MATCH_BITS = 2; // readAndPlan: stricter (kiosk screens share a layout, so 8x8 hashes look alike)

async function callModel(parts: unknown[], model: string, key: string): Promise<any> {
  const started = Date.now();
  const send = async (minimalThinking: boolean) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PER_MODEL_TIMEOUT_MS);
    try {
      return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0,
            // Gemini 3.x uses thinkingLevel; 2.5 uses thinkingBudget (0 = off).
            ...(minimalThinking
              ? { thinkingConfig: model.startsWith('gemini-2.5') ? { thinkingBudget: 0 } : { thinkingLevel: 'minimal' } }
              : {}),
          },
        }),
      });
    } finally {
      clearTimeout(timer);
    }
  };
  let res = await send(true);
  if (res.status === 400) res = await send(false); // model doesn't accept that thinking setting
  if (!res.ok) throw new Error(`${model} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  console.log(`gemini ${model} took ${Date.now() - started}ms`);
  const text: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
  return JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
}

async function gemini(parts: unknown[], models: string[]): Promise<any> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set in the Convex dashboard (Settings → Environment Variables).');
  const errors: string[] = [];
  for (const model of models) {
    try {
      return await callModel(parts, model, key);
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? `${model} timed out` : (e as Error).message;
      console.warn(`gemini fallback: ${msg}`);
      errors.push(msg);
    }
  }
  throw new Error(`All Gemini models failed. ${errors.join(' | ')}`);
}

function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));

const MAP_PROMPT = `This photo was taken by a phone camera pointed at a touchscreen (a restaurant kiosk, card reader, self-checkout or appliance panel).
List every tappable control that is visible ON THE SCREEN (ignore anything outside the screen and ignore any hand or finger).
For each control return:
- "label": the visible text on it, or a 1–3 word description if it is only an icon/picture
- "kind": "digit" for single number keys on a keypad, otherwise "button"
- "box_2d": [ymin, xmin, ymax, xmax] normalized to 0–1000 relative to the WHOLE photo, tightly around the tappable area.
Also return "summary": one short line saying what this screen is (e.g. "Menu categories", "PIN pad", "Order confirmation").
Return JSON: {"summary": string, "buttons": [{"label": string, "kind": string, "box_2d": [number, number, number, number]}]}`;

export const mapScreen = action({
  args: { jpeg: v.string(), hash: v.string() },
  handler: async (ctx, { jpeg, hash }): Promise<{ screenId: Id<'screens'>; summary: string; buttons: Button[]; cached: boolean }> => {
    // 1) Screen memory: same screen seen before → instant.
    const recent: Doc<'screens'>[] = await ctx.runQuery(internal.screens.recent, {});
    const hit = recent.find((s: Doc<'screens'>) => hamming(s.hash, hash) <= HASH_MATCH_BITS);
    if (hit) return { screenId: hit._id, summary: hit.summary, buttons: hit.buttons, cached: true };

    // 2) New screen → ask Gemini once.
    const out = await gemini([{ text: MAP_PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: jpeg } }], VISION_MODELS());
    const buttons = toButtons(out);
    const summary = String(out.summary ?? 'Screen');
    const screenId = await ctx.runMutation(internal.screens.insert, { hash, summary, buttons });
    return { screenId, summary, buttons, cached: false };
  },
});

// Gemini's box_2d is [ymin, xmin, ymax, xmax] in 0–1000; the app only ever sees [x0, y0, x1, y1] in 0–1.
function toButtons(out: any): Button[] {
  return (out.buttons ?? [])
    .filter((b: any) => Array.isArray(b.box_2d) && b.box_2d.length === 4)
    .map((b: any) => {
      const [ymin, xmin, ymax, xmax] = b.box_2d.map((n: number) => n / 1000);
      return { label: String(b.label ?? ''), kind: b.kind === 'digit' ? 'digit' : 'button', box: [clamp(xmin), clamp(ymin), clamp(xmax), clamp(ymax)] };
    });
}

const STEP_RULES = `Rules:
- If this screen is a PIN pad and the PIN has not been entered yet (history doesn't say "PIN entered"), set "pin": true and "targetIndex": null. If the PIN was entered, pick OK/Enter.
- If the screen is an upsell, add-on, donation, round-up, tip or subscription the goal didn't ask for, set "warning" to a short sentence that explains it and pick the decline button (e.g. "No thanks").
- If the goal is complete (order confirmation / thank-you / done screen), set "done": true, "targetIndex": null and "doneSay" to a short sentence including any order number shown.
- "say": what to tell them before guiding, max 8 words, e.g. "Burgers. Find it." Never read prices unless useful.`;

const STEP_PROMPT = (goal: string, history: string[], summary: string, buttons: Button[]) => `You are guiding a blind person through a touchscreen, one tap at a time.
Their goal: "${goal}"
What has happened so far: ${history.length ? history.map((h, i) => `${i + 1}. ${h}`).join(' ') : 'nothing yet'}
Current screen: ${summary}
Buttons on this screen (index: label):
${buttons.map((b, i) => `${i}: ${b.label}`).join('\n')}

Pick the ONE button to tap next that moves them toward their goal.
Rules:
- If this screen is a PIN pad and the PIN has not been entered yet (history doesn't say "PIN entered"), set "pin": true and "targetIndex": null. If the PIN was entered, pick OK/Enter.
- If the screen is an upsell, add-on, donation, round-up, tip or subscription the goal didn't ask for, set "warning" to a short sentence that explains it and pick the decline button (e.g. "No thanks").
- If the goal is complete (order confirmation / thank-you / done screen), set "done": true, "targetIndex": null and "doneSay" to a short sentence including any order number shown.
- "say": what to tell them before guiding, max 8 words, e.g. "Burgers. Find it." Never read prices unless useful.
Return JSON: {"targetIndex": number|null, "say": string, "warning": string|null, "pin": boolean, "done": boolean, "doneSay": string|null}`;

type Target = { label: string; box: number[] };
type StepResult = {
  target: Target | null;
  say: string;
  warning: string | null;
  pin: boolean;
  done: boolean;
  doneSay: string | null;
  digits: Target[];
};

export const nextStep = action({
  args: { goal: v.string(), history: v.array(v.string()), screenId: v.id('screens') },
  handler: async (ctx, { goal, history, screenId }): Promise<StepResult> => {
    const screen: Doc<'screens'> | null = await ctx.runQuery(internal.screens.get, { id: screenId });
    if (!screen) throw new Error('Unknown screen');
    const out = await gemini([{ text: STEP_PROMPT(goal, history, screen.summary, screen.buttons) }], STEP_MODELS());
    const idx = typeof out.targetIndex === 'number' ? out.targetIndex : null;
    const b: Button | undefined = idx !== null ? screen.buttons[idx] : undefined;
    return {
      target: b ? { label: b.label, box: b.box } : null,
      say: String(out.say ?? ''),
      warning: out.warning ? String(out.warning) : null,
      pin: !!out.pin,
      done: !!out.done,
      doneSay: out.doneSay ? String(out.doneSay) : null,
      digits: screen.buttons.filter((x: Button) => x.kind === 'digit').map((x: Button) => ({ label: x.label, box: x.box })),
    };
  },
});

export const transcribeGoal = action({
  args: { audio: v.string(), mimeType: v.optional(v.string()) },
  handler: async (_ctx, { audio, mimeType }): Promise<{ goal: string }> => {
    const out = await gemini([
      { text: 'A person said what they want to do on a touchscreen (usually ordering food). Return JSON {"goal": string} with what they want, as a short phrase in their words. If nothing intelligible was said, return {"goal": ""}.' },
      { inline_data: { mime_type: mimeType ?? 'audio/mp4', data: audio } },
    ], STEP_MODELS());
    return { goal: String(out.goal ?? '').trim() };
  },
});

// ---------- readAndPlan: the fast path ----------
// One round trip instead of two. Seen this screen before (cache hit)? Only a quick text call to pick
// the button. New screen? ONE vision call that both maps the buttons and picks the next one.
// mapScreen + nextStep above stay as-is (the contract in CLAUDE.md §5); this is an extra, faster entry point.
const READ_AND_PLAN_PROMPT = (goal: string, history: string[]) => `This photo was taken by a phone camera pointed at a touchscreen (a restaurant kiosk, card reader, self-checkout or appliance panel).
You are guiding a blind person through it, one tap at a time.
Their goal: "${goal}"
What has happened so far: ${history.length ? history.map((h, i) => `${i + 1}. ${h}`).join(' ') : 'nothing yet'}

1) List every tappable control visible ON THE SCREEN (ignore anything outside the screen and any hand or finger).
For each: "label" (visible text, or 1–3 words if it's only an icon/picture), "kind" ("digit" for single number keys on a keypad, otherwise "button"),
"box_2d": [ymin, xmin, ymax, xmax] normalized 0–1000 relative to the WHOLE photo, tight around the tappable area.
Also "summary": one short line saying what this screen is.
2) Pick the ONE button (by its index in your list) to tap next that moves them toward their goal.
${STEP_RULES}
Return JSON: {"summary": string, "buttons": [{"label": string, "kind": string, "box_2d": [number, number, number, number]}], "targetIndex": number|null, "say": string, "warning": string|null, "pin": boolean, "done": boolean, "doneSay": string|null}`;

function toStep(out: any, buttons: Button[]): StepResult {
  const idx = typeof out.targetIndex === 'number' ? out.targetIndex : null;
  const b: Button | undefined = idx !== null ? buttons[idx] : undefined;
  return {
    target: b ? { label: b.label, box: b.box } : null,
    say: String(out.say ?? ''),
    warning: out.warning ? String(out.warning) : null,
    pin: !!out.pin,
    done: !!out.done,
    doneSay: out.doneSay ? String(out.doneSay) : null,
    digits: buttons.filter((x: Button) => x.kind === 'digit').map((x: Button) => ({ label: x.label, box: x.box })),
  };
}

export const readAndPlan = action({
  args: {
    jpeg: v.string(),
    hash: v.string(),
    goal: v.string(),
    history: v.array(v.string()),
    avoidScreenId: v.optional(v.id('screens')), // the screen we were just on: never reuse it right after a tap
  },
  handler: async (ctx, { jpeg, hash, goal, history, avoidScreenId }): Promise<StepResult & { screenId: Id<'screens'>; cached: boolean }> => {
    const recent: Doc<'screens'>[] = await ctx.runQuery(internal.screens.recent, {});
    // Kiosk screens share a layout, so their coarse hashes can be close. Match strictly, and skip the
    // screen we just left, otherwise the old buttons come back and the target box never moves.
    const hit = recent.find(
      (s: Doc<'screens'>) => s._id !== avoidScreenId && hamming(s.hash, hash) <= READ_MATCH_BITS,
    );
    if (hit) {
      const out = await gemini([{ text: STEP_PROMPT(goal, history, hit.summary, hit.buttons) }], STEP_MODELS());
      return { ...toStep(out, hit.buttons), screenId: hit._id, cached: true };
    }
    const out = await gemini(
      [{ text: READ_AND_PLAN_PROMPT(goal, history) }, { inline_data: { mime_type: 'image/jpeg', data: jpeg } }],
      VISION_MODELS(),
    );
    const buttons = toButtons(out);
    const screenId = await ctx.runMutation(internal.screens.insert, { hash, summary: String(out.summary ?? 'Screen'), buttons });
    return { ...toStep(out, buttons), screenId, cached: false };
  },
});
