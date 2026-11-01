import { PendingMoveRecord } from './types/chess.types';

/**
 * Pure helpers for the Cold-Path move persistence worker (Issue #140, part of #118).
 * Nothing here performs I/O, so every function is unit-testable without a database.
 */

export const MOVE_PERSISTENCE_CONFIG = {
  /** Maximum number of plies written in a single createMany() call. */
  batchSize: 50,
  /** Debounce window that lets several plies share one INSERT. */
  flushDelayMs: 50,
  /** Exponential backoff after a transient database failure. */
  retryBaseMs: 250,
  retryMaxMs: 10_000,
  /** Soft cap for the in-RAM buffer. Exceeding it only logs: plies are never dropped. */
  maxQueueSize: 10_000,
  /** Maximum number of poison records kept for inspection. */
  maxDeadLetters: 1_000,
  /** How long removeGame() waits for the game's plies to reach the database. */
  removeGameWaitMs: 5_000,
  /** How long onModuleDestroy() waits for the buffer to drain. */
  shutdownWaitMs: 5_000,
} as const;

export type PersistenceErrorKind = 'transient' | 'permanent';

/**
 * Prisma error codes that mean "the database is (temporarily) unreachable or
 * busy": retrying the identical write later can succeed.
 */
const TRANSIENT_PRISMA_CODES = new Set([
  'P1001', // Can't reach database server
  'P1002', // Database server timed out
  'P1008', // Operation timed out
  'P1017', // Server closed the connection
  'P2024', // Connection pool timeout
  'P2028', // Transaction API error
  'P2034', // Write conflict / deadlock
]);

/** Node-level socket errors that indicate a dropped connection. */
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

/**
 * Decides whether a failed write is worth retrying as-is.
 *
 * Anything not recognised as a connectivity problem is treated as PERMANENT
 * (bad data, FK/CHECK violation, programming error). The worker then isolates
 * the offending record instead of retrying it forever.
 */
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

/** Exponential backoff: base * 2^(attempt-1), capped. `attempt` starts at 1. */
export function computeBackoffMs(
  attempt: number,
  baseMs: number = MOVE_PERSISTENCE_CONFIG.retryBaseMs,
  maxMs: number = MOVE_PERSISTENCE_CONFIG.retryMaxMs,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  // Cap the exponent so 2 ** n can never overflow to Infinity.
  const exponent = Math.min(safeAttempt - 1, 30);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

/** Shape accepted by prisma.gameMove.createMany({ data }). */
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

/**
 * Maps the in-RAM record to the Prisma input. Fields are copied explicitly
 * (no spread) so a future extra property on PendingMoveRecord can never leak
 * into the INSERT and break it.
 */
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

/** A ply that the database rejected permanently and that was removed from the buffer. */
export interface DeadLetterMove {
  record: PendingMoveRecord;
  /** Prisma/system error code when available, otherwise the error name. */
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
    // Prisma messages can span many lines; the first line is enough for logs.
    const firstLine =
      typeof message === 'string' ? message.split('\n').find((l) => l.trim()) ?? '' : '';
    return firstLine ? `${label}: ${firstLine.trim()}` : label;
  }
  return String(error);
}
