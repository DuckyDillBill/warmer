// AI actions for Warmer. The Gemini key lives in Convex env vars (GEMINI_API_KEY), never in the app.
// Contract: see CLAUDE.md §5. All boxes returned are [x0, y0, x1, y1], normalized 0–1, top-left origin.
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';

// Convex actions run on Node-like runtime; declare process.env so tsc doesn't need @types/node.
declare const process: { env: Record<string, string | undefined> };

type Button = { label: string; box: number[]; kind: string };

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-flash-latest';
const HASH_MATCH_BITS = 6; // screens within this many differing bits count as "the same screen"

async function gemini(parts: unknown[]): Promise<any> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set in the Convex dashboard (Settings → Environment Variables).');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
  return JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
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
    const out = await gemini([{ text: MAP_PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: jpeg } }]);
    const buttons: Button[] = (out.buttons ?? [])
      .filter((b: any) => Array.isArray(b.box_2d) && b.box_2d.length === 4)
      .map((b: any) => {
        const [ymin, xmin, ymax, xmax] = b.box_2d.map((n: number) => n / 1000);
        return { label: String(b.label ?? ''), kind: b.kind === 'digit' ? 'digit' : 'button', box: [clamp(xmin), clamp(ymin), clamp(xmax), clamp(ymax)] };
      });
    const summary = String(out.summary ?? 'Screen');
    const screenId = await ctx.runMutation(internal.screens.insert, { hash, summary, buttons });
    return { screenId, summary, buttons, cached: false };
  },
});

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
    const out = await gemini([{ text: STEP_PROMPT(goal, history, screen.summary, screen.buttons) }]);
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
    ]);
    return { goal: String(out.goal ?? '').trim() };
  },
});
