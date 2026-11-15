// Session log for each guided visit (CLAUDE.md §5). The app writes here fire-and-forget.
// History only ever holds button labels like 'Tapped "Burgers"' and "PIN entered": never the PIN itself.
import { mutation, query } from './_generated/server';
import { v } from 'convex/values';

export const start = mutation({
  args: { goal: v.string() },
  handler: async (ctx, { goal }) =>
    ctx.db.insert('sessions', { goal, history: [], status: 'planning', createdAt: Date.now() }),
});

export const update = mutation({
  args: { id: v.id('sessions'), history: v.array(v.string()), status: v.string() },
  handler: async (ctx, { id, history, status }) => {
    await ctx.db.patch(id, { history, status, updatedAt: Date.now() });
  },
});

// Recent sessions, newest first (handy for a live dashboard during the demo).
export const recent = query({
  args: {},
  handler: async (ctx) => ctx.db.query('sessions').order('desc').take(10),
});
