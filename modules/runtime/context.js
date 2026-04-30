// modules/runtime/context.js — sandbox ctx builder
// Builds the `ctx` object injected into bot.js and routes.js handlers.
// Kept separate so both bots.js and routes.js can import it without
// duplicating the shape.

// (Currently the ctx is assembled inline in bots.js / routes.js.
// This file is the right place to centralise it in v0.3 once the shape
// stabilises.)

export const CONTEXT_VERSION = '0.2.0';
