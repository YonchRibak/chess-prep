/**
 * Timing constants for the rehearsal session (Study S5). One place so the
 * feel of the session — how fast a line replays, how long a miss is shown —
 * is tuned here and nowhere else.
 */

/** Glide of one replayed ply while moving to the next card's position. */
export const PLY_MS = 180;
/** Glide of the final ply of a transition — the opponent's move the card asks about. */
export const LAST_PLY_MS = 350;
/** Glide of one undone ply while rewinding to a common ancestor. */
export const UNDO_PLY_MS = 120;
/** Fade shown instead of a long rewind when the next line shares nothing useful. */
export const NEW_LINE_FADE_MS = 220;
/** Pause after a correct answer before the next card starts moving. */
export const CORRECT_PAUSE_MS = 350;
/** How long the correct move stays on the board after a miss before retry. */
export const WRONG_REVEAL_MS = 1200;
// Deliberately no idle timer: a card never times out or hints by itself.
