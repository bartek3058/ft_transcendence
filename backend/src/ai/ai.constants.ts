/**
 * Identity of the built-in Stockfish opponent.
 *
 * It is a normal row in the `users` table (seeded by prisma/seed.ts) so that
 * games against it can reference it through the usual white_id/black_id foreign
 * keys and show up in match history. The id is fixed rather than random so the
 * AI game flow and the seed agree on it without a lookup.
 */

// Must be a valid UUID (it lands in a @db.Uuid column and the game id regex).
export const AI_BOT_USER_ID = '00000000-0000-4000-8000-000000000001';
export const AI_BOT_USERNAME = 'stockfish';
export const AI_BOT_EMAIL = 'stockfish@transcendence.local';
export const AI_BOT_DISPLAY_RATING = 1500;

// User.role value that marks an account as the AI. RatingService uses it to keep
// games against the AI out of the ELO system.
export const AI_BOT_ROLE = 'bot';
