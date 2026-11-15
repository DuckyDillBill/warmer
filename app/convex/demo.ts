// Demo control: the app's Reset button restarts the kiosk on the iPad (it subscribes to `state`).
import { mutation, query } from './_generated/server';

export const resetKiosk = mutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query('demo').first();
    if (row) await ctx.db.patch(row._id, { resetAt: Date.now() });
    else await ctx.db.insert('demo', { resetAt: Date.now() });
  },
});

export const state = query({ args: {}, handler: async (ctx) => ctx.db.query('demo').first() });
