import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

const box = v.array(v.number()); // [x0, y0, x1, y1], normalized 0–1, top-left origin

export default defineSchema({
  // Shared screen memory: once any user's phone maps a screen, it's instant for everyone.
  screens: defineTable({
    hash: v.string(), // 64-bit dHash, 16 hex chars
    summary: v.string(),
    buttons: v.array(v.object({ label: v.string(), box, kind: v.string() })),
    createdAt: v.number(),
  }).index('by_hash', ['hash']),

  // One row per guided visit (goal → steps → done). History holds tap labels only; never PINs.
  sessions: defineTable({
    goal: v.string(),
    history: v.array(v.string()),
    status: v.string(), // 'planning' | 'guiding' | 'done' | 'error'
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  }),

  // Spectator view (/watch): one row each, overwritten by the phone while guiding.
  liveState: defineTable({
    finger: v.union(v.object({ x: v.number(), y: v.number() }), v.null()),
    target: v.union(box, v.null()),
    label: v.string(),
    updatedAt: v.number(),
  }),
  // Demo control: the app's Reset button bumps resetAt; the kiosk restarts when it changes.
  demo: defineTable({ resetAt: v.number() }),

  // Partner kiosk mode: a partner kiosk publishes its current screen and button layout (rects are
  // 0–1 of the kiosk's own display). seq goes up on every change, so Warmer knows the instant a tap lands.
  kioskLayout: defineTable({
    screen: v.string(),
    title: v.string(),
    buttons: v.array(v.object({ label: v.string(), rect: v.array(v.number()), kind: v.string() })),
    seq: v.number(),
    updatedAt: v.number(),
  }),

  liveFrame: defineTable({
    jpeg: v.string(), // small base64 camera snapshot, ~2 per second
    updatedAt: v.number(),
  }),

  // Orders placed on the demo kiosk, shown live on /live.
  orders: defineTable({
    items: v.array(v.object({ name: v.string(), price: v.number() })),
    total: v.number(),
    number: v.number(),
    createdAt: v.number(),
  }),
});
