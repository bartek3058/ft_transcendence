import { PendingMoveRecord } from './types/chess.types';

// Pure helpers for move persistence (#140), no I/O so they're easy to test.

export const MOVE_PERSISTENCE_CONFIG = {
  batchSize: 50,
  flushDelayMs: 50,
  retryBaseMs: 250,
  retryMaxMs: 10_000,
  // only logs when exceeded, moves are never dropped
  maxQueueSize: 10_000,
  maxDeadLetters: 1_000,
  removeGameWaitMs: 5_000,
  shutdownWaitMs: 5_000,
} as const;

export type PersistenceErrorKind = 'transient' | 'permanent';

// DB unreachable or busy, the same write can succeed later
const TRANSIENT_PRISMA_CODES = new Set([
  'P1001', // Can't reach database server
  'P1002', // Database server timed out
  'P1008', // Operation timed out
  'P1017', // Server closed the connection
  'P2024', // Connection pool timeout
  'P2028', // Transaction API error
  'P2034', // Write conflict / deadlock
]);

const TRANSIENT_SYSTEM_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
]);

const TRANSIENT_ERROR_NAMES = new Set([
  'PrismaClientInitializationError',
  'PrismaClientRustPanicError',
]);

// Anything that isn't a connection problem counts as permanent, so a bad row gets
// isolated instead of retried forever.
export function classifyPersistenceError(error: unknown): PersistenceErrorKind {
  if (typeof error !== 'object' || error === null) {
    return 'permanent';
  }
  const { code, name } = error as { code?: unknown; name?: unknown };
  if (typeof code === 'string' &&
    (TRANSIENT_PRISMA_CODES.has(code) || TRANSIENT_SYSTEM_CODES.has(code))) {
    return 'transient';
  }
  if (typeof name === 'string' && TRANSIENT_ERROR_NAMES.has(name)) {
    return 'transient';
  }
  return 'permanent';
}

export function computeBackoffMs(
  attempt: number,
  baseMs: number = MOVE_PERSISTENCE_CONFIG.retryBaseMs,
  maxMs: number = MOVE_PERSISTENCE_CONFIG.retryMaxMs,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  // cap the exponent so 2 ** n can't overflow
  const exponent = Math.min(safeAttempt - 1, 30);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

export interface GameMoveCreateInput {
  gameId: string;
  ply: number;
  moveNumber: number;
  color: string;
  playedById: string;
  san: string;
  uci: string;
  fenAfter: string;
  timeSpentMs: number;
  timeRemainingMs: number;
  createdAt: Date;
}

// Copy fields one by one so a new field on PendingMoveRecord can't leak into the INSERT.
export function toGameMoveCreateInput(record: PendingMoveRecord): GameMoveCreateInput {
  return {
    gameId: record.gameId,
    ply: record.ply,
    moveNumber: record.moveNumber,
    color: record.color,
    playedById: record.playedById,
    san: record.san,
    uci: record.uci,
    fenAfter: record.fenAfter,
    timeSpentMs: record.timeSpentMs,
    timeRemainingMs: record.timeRemainingMs,
    createdAt: record.createdAt,
  };
}

export interface DeadLetterMove {
  record: PendingMoveRecord;
  reason: string;
  failedAt: Date;
}

export function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, name, message } = error as {
      code?: unknown;
      name?: unknown;
      message?: unknown;
    };
    const label =
      typeof code === 'string' ? code : typeof name === 'string' ? name : 'UnknownError';
    // Prisma errors can be multi-line, the first line is enough
    const firstLine =
      typeof message === 'string' ? message.split('\n').find((l) => l.trim()) ?? '' : '';
    return firstLine ? `${label}: ${firstLine.trim()}` : label;
  }
  return String(error);
}
