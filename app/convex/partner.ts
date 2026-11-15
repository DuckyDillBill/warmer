// Partner kiosk mode (honest fallback, clearly labeled in the app as "Partner kiosk").
// A partner kiosk publishes its own screen + button layout here. Warmer still finds the kiosk with the
// camera and guides the finger exactly as usual; the only difference is that button positions come from
// the kiosk itself instead of being read from the photo, and taps are confirmed by the kiosk.
import { action, mutation, query } from './_generated/server';
import { v } from 'convex/values';

declare const process: { env: Record<string, string | undefined> };

const button = v.object({ label: v.string(), rect: v.array(v.number()), kind: v.string() });

/** Called by the kiosk after every render. */
export const publish = mutation({
  args: { screen: v.string(), title: v.string(), buttons: v.array(button) },
  handler: async (ctx, args) => {
    const row = await ctx.db.query('kioskLayout').first();
    const data = { ...args, seq: (row?.seq ?? 0) + 1, updatedAt: Date.now() };
    if (row) await ctx.db.patch(row._id, data);
    else await ctx.db.insert('kioskLayout', data);
  },
});

/** The kiosk's current screen (Warmer subscribes to this for instant tap confirmation). */
export const current = query({ args: {}, handler: async (ctx) => ctx.db.query('kioskLayout').first() });

const MODELS = () => [process.env.GEMINI_STEP_MODEL || 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const VISION = () => [process.env.GEMINI_MODEL || 'gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-3.5-flash-lite'];

async function gemini(parts: unknown[], models: string[]): Promise<any> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const errors: string[] = [];
  for (const model of models) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 },
        }),
      });
      if (!res.ok) throw new Error(`${model} ${res.status}`);
      const data = await res.json();
      const text: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
      return JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
    } catch (e) {
      errors.push((e as Error).message);
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error(`All models failed: ${errors.join(' | ')}`);
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** Where is the kiosk's display in this camera photo? Returns [x0,y0,x1,y1] 0–1, or null. */
export const locateScreen = action({
  args: { jpeg: v.string() },
  handler: async (_ctx, { jpeg }): Promise<number[] | null> => {
    const out = await gemini(
      [
        {
          text:
            'This photo was taken by a phone camera pointed at a touchscreen (a tablet used as a kiosk). ' +
            'Return the lit display area of that touchscreen (the screen content only, not the bezel or case) as ' +
            'JSON {"screen_2d": [ymin, xmin, ymax, xmax]} normalized 0–1000. If there is no screen, return {"screen_2d": null}.',
        },
        { inline_data: { mime_type: 'image/jpeg', data: jpeg } },
      ],
      VISION(),
    );
    const s = out?.screen_2d;
    if (!Array.isArray(s) || s.length !== 4) return null;
    const [ymin, xmin, ymax, xmax] = s.map((n: number) => clamp(n / 1000));
    if (xmax - xmin < 0.1 || ymax - ymin < 0.1) return null;
    return [xmin, ymin, xmax, ymax];
  },
});

/** Text-only: pick the next button from the kiosk's own layout. */
export const planPartner = action({
  args: { goal: v.string(), history: v.array(v.string()), screen: v.string(), labels: v.array(v.string()) },
  handler: async (_ctx, { goal, history, screen, labels }) => {
    const out = await gemini(
      [
        {
          text: `You are guiding a blind person through a touchscreen kiosk, one tap at a time.
Their goal: "${goal}"
What has happened so far: ${history.length ? history.map((h, i) => `${i + 1}. ${h}`).join(' ') : 'nothing yet'}
Current screen: ${screen}
Buttons on this screen (index: label):
${labels.map((l, i) => `${i}: ${l}`).join('\n')}

Pick the ONE button to tap next that moves them toward their goal.
Rules:
- If this screen is a PIN pad and the PIN has not been entered yet (history doesn't say "PIN entered"), set "pin": true and "targetIndex": null. If the PIN was entered, pick OK.
- If the screen is an upsell, add-on, donation, round-up, tip or subscription the goal didn't ask for, set "warning" to one short sentence explaining it and pick the decline button.
- If the goal's items are all added, go to checkout and pay.
- If this is the order confirmation / thank-you screen, set "done": true, "targetIndex": null and "doneSay" to a short sentence including the order number.
Return JSON: {"targetIndex": number|null, "warning": string|null, "pin": boolean, "done": boolean, "doneSay": string|null}`,
        },
      ],
      MODELS(),
    );
    return {
      targetIndex: typeof out.targetIndex === 'number' ? out.targetIndex : null,
      warning: out.warning ? String(out.warning) : null,
      pin: !!out.pin,
      done: !!out.done,
      doneSay: out.doneSay ? String(out.doneSay) : null,
    };
  },
});
