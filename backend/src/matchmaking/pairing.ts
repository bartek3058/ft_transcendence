// Pure matchmaking/pairing logic.

export interface QueueEntry {
  userId: string;
  rating: number;
  joinedAt: number;
  timeControl?: string;
}

export interface MatchmakingConfig {
  baseTolerance: number;
  tolerancePerSecond: number;
  maxTolerance: number;
}

export const DEFAULT_MATCHMAKING_CONFIG: MatchmakingConfig = {
  baseTolerance: 100,
  tolerancePerSecond: 10,
  maxTolerance: 1000,
};

export function toleranceFor(entry: QueueEntry, now: number, config: MatchmakingConfig): number {
  const secondsWaited = Math.max(0, (now - entry.joinedAt) / 1000);
  const widened = config.baseTolerance + secondsWaited * config.tolerancePerSecond;
  return Math.min(widened, config.maxTolerance);
}

export function areCompatible(
  a: QueueEntry,
  b: QueueEntry,
  now: number,
  config: MatchmakingConfig,
): boolean {
  if (a.userId === b.userId) return false;
  if (a.timeControl !== b.timeControl) return false;
  const gap = Math.abs(a.rating - b.rating);
  // The longer-waiting player's tolerance governs, so nobody waits forever.
  return gap <= Math.max(toleranceFor(a, now, config), toleranceFor(b, now, config));
}

/**
 * Pick the best pair to match right now, or null if none is compatible.
 *
 * "Best" = smallest rating gap; ties broken toward the pair that has waited longest
 * in total, so patient players are served first.
 */
export function selectPair(
  entries: readonly QueueEntry[],
  now: number,
  config: MatchmakingConfig = DEFAULT_MATCHMAKING_CONFIG,
): [QueueEntry, QueueEntry] | null {
  let best: [QueueEntry, QueueEntry] | null = null;
  let bestGap = Infinity;
  let bestWait = -Infinity;

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (!areCompatible(a, b, now, config)) continue;

      const gap = Math.abs(a.rating - b.rating);
      const totalWait = now - a.joinedAt + (now - b.joinedAt);

      if (gap < bestGap || (gap === bestGap && totalWait > bestWait)) {
        best = [a, b];
        bestGap = gap;
        bestWait = totalWait;
      }
    }
  }

  return best;
}
