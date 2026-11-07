import { randomUUID } from 'crypto';
import {
  GeneratedBracket,
  GeneratedMatchNode,
  ParticipantToSeed,
  SeededParticipant,
} from './tournament-engine.types';

/**
 * Invalid bracket input (participant count / bracket size). The service maps
 * it to HTTP 400; any other Error stays a server error.
 */
export class BracketGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BracketGenerationError';
  }
}

/**
 * Calculates the next power of 2 greater than or equal to playerCount.
 * Bounds: minimum 2, maximum 32 (per 42 subject and DB constraints).
 */
export function getBracketSize(playerCount: number): number {
  if (playerCount < 2) return 2;
  const power = Math.pow(2, Math.ceil(Math.log2(playerCount)));
  return Math.min(Math.max(power, 2), 32);
}

/**
 * Seeds participants deterministically:
 * 1. By seedRating descending (higher ELO gets lower seed number, e.g. Seed 1).
 * 2. Tiebreaker: registeredAt ascending (earlier sign-up wins tie);
 *    a missing registeredAt sorts after any known date.
 * 3. Fallback: userId code-point comparison (locale-independent).
 * The comparator is a strict total order, so the result never depends on the
 * input order or the server locale.
 */
export function seedParticipants(
  participants: ParticipantToSeed[],
): SeededParticipant[] {
  const sorted = [...participants].sort((a, b) => {
    if (b.seedRating !== a.seedRating) {
      return b.seedRating - a.seedRating;
    }
    const aTime = a.registeredAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bTime = b.registeredAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (aTime !== bTime) {
      return aTime < bTime ? -1 : 1;
    }
    if (a.userId === b.userId) return 0;
    return a.userId < b.userId ? -1 : 1;
  });

  return sorted.map((p, idx) => ({
    ...p,
    seed: idx + 1,
  }));
}

export interface GenerateBracketOptions {
  tournamentId: string;
  participants: ParticipantToSeed[];
  bracketSize?: number;
}

/**
 * Generates a full single-elimination tournament bracket with balanced seed folding:
 * - Round 1 pairs: Seed (m + 1) vs Seed (bracketSize - m)
 * - Round linkage: Match i and Match (K - 1 - i) feed into next round Match i
 * - Automatic resolution of Round 1 Byes
 */
export function generateBracket(
  options: GenerateBracketOptions,
): GeneratedBracket {
  const { participants } = options;
  if (participants.length < 2) {
    throw new BracketGenerationError('A tournament requires at least 2 participants.');
  }

  const bracketSize = options.bracketSize ?? getBracketSize(participants.length);
  if (bracketSize < 2 || bracketSize > 32 || (bracketSize & (bracketSize - 1)) !== 0) {
    throw new BracketGenerationError(
      `Invalid bracket size: ${bracketSize}. Must be a power of 2 between 2 and 32.`,
    );
  }

  if (participants.length > bracketSize) {
    throw new BracketGenerationError(
      `Participants count (${participants.length}) exceeds bracket size (${bracketSize}).`,
    );
  }

  // More than half the slots empty would create a Round 1 match with no
  // players, which can never be played or resolved. Only the smallest power of
  // 2 that fits the participants is allowed (AI-filled slots are a future option).
  if (participants.length <= bracketSize / 2) {
    throw new BracketGenerationError(
      `Bracket size ${bracketSize} is too large for ${participants.length} participants ` +
        `(use ${getBracketSize(participants.length)}).`,
    );
  }

  const seededParticipants = seedParticipants(participants);
  const playerBySeed = new Map<number, SeededParticipant>();
  for (const sp of seededParticipants) {
    playerBySeed.set(sp.seed, sp);
  }

  const totalRounds = Math.log2(bracketSize);
  const rounds: GeneratedMatchNode[][] = [];

  // Step 1: Create skeleton matches for every round
  for (let r = 1; r <= totalRounds; r++) {
    const matchesInRound = bracketSize / Math.pow(2, r);
    const roundMatches: GeneratedMatchNode[] = [];

    for (let m = 0; m < matchesInRound; m++) {
      roundMatches.push({
        id: randomUUID(),
        round: r,
        matchIndex: m,
        identifier: `R${r}-M${m + 1}`,
        player1Id: null,
        player2Id: null,
        winnerId: null,
        status: 'PENDING',
        isBye: false,
        nextMatchId: null,
        nextMatchSlot: null,
      });
    }
    rounds.push(roundMatches);
  }

  // Step 2: Link rounds with balanced seed-fold logic
  // Top match i pairs with symmetric bottom match (K - 1 - i)
  for (let r = 0; r < totalRounds - 1; r++) {
    const currentRound = rounds[r];
    const nextRound = rounds[r + 1];
    const K = currentRound.length;

    for (let i = 0; i < K / 2; i++) {
      const topMatch = currentRound[i];
      const bottomMatch = currentRound[K - 1 - i];
      const targetMatch = nextRound[i];

      topMatch.nextMatchId = targetMatch.id;
      topMatch.nextMatchSlot = 'player1';

      bottomMatch.nextMatchId = targetMatch.id;
      bottomMatch.nextMatchSlot = 'player2';
    }
  }

  // Step 3: Populate Round 1 with seeded participants
  const round1 = rounds[0];
  for (let m = 0; m < round1.length; m++) {
    const seed1 = m + 1;
    const seed2 = bracketSize - m;

    const p1 = playerBySeed.get(seed1) ?? null;
    const p2 = playerBySeed.get(seed2) ?? null;

    const match = round1[m];
    match.player1Id = p1?.userId ?? null;
    match.player2Id = p2?.userId ?? null;

    if (p1 && !p2) {
      match.isBye = true;
      match.status = 'COMPLETED';
      match.winnerId = p1.userId;
    } else if (!p1 && p2) {
      match.isBye = true;
      match.status = 'COMPLETED';
      match.winnerId = p2.userId;
    } else if (p1 && p2) {
      match.isBye = false;
      match.status = 'SCHEDULED';
      match.winnerId = null;
    }
  }

  // Step 4: Advance Round 1 Bye winners directly into Round 2 slots
  if (totalRounds > 1) {
    const round2 = rounds[1];
    for (const match of round1) {
      if (match.isBye && match.winnerId && match.nextMatchId && match.nextMatchSlot) {
        const nextMatch = round2.find((m) => m.id === match.nextMatchId);
        if (nextMatch) {
          if (match.nextMatchSlot === 'player1') {
            nextMatch.player1Id = match.winnerId;
          } else {
            nextMatch.player2Id = match.winnerId;
          }
        }
      }
    }

    // If any Round 2 match now has both players present, transition it to SCHEDULED
    for (const match of round2) {
      if (match.player1Id && match.player2Id) {
        match.status = 'SCHEDULED';
      }
    }
  }

  // Flatten matches for convenient bulk insert operations
  const matches = rounds.flat();

  return {
    bracketSize,
    totalRounds,
    rounds,
    matches,
    seededParticipants,
  };
}
