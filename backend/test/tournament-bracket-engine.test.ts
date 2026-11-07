import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BracketGenerationError,
  generateBracket,
  getBracketSize,
  seedParticipants,
} from '../src/tournament/engine/bracket-generator';
import { ParticipantToSeed } from '../src/tournament/engine/tournament-engine.types';

describe('Tournament Bracket Generation Engine (Pure)', () => {
  describe('getBracketSize', () => {
    it('returns 2 for fewer than 2 players', () => {
      assert.equal(getBracketSize(0), 2);
      assert.equal(getBracketSize(1), 2);
      assert.equal(getBracketSize(2), 2);
    });

    it('rounds up to the next power of 2', () => {
      assert.equal(getBracketSize(3), 4);
      assert.equal(getBracketSize(4), 4);
      assert.equal(getBracketSize(5), 8);
      assert.equal(getBracketSize(6), 8);
      assert.equal(getBracketSize(8), 8);
      assert.equal(getBracketSize(9), 16);
      assert.equal(getBracketSize(16), 16);
      assert.equal(getBracketSize(17), 32);
      assert.equal(getBracketSize(32), 32);
    });
  });

  describe('seedParticipants', () => {
    it('sorts participants by seedRating in descending order', () => {
      const participants: ParticipantToSeed[] = [
        { userId: 'u-1200', seedRating: 1200 },
        { userId: 'u-1600', seedRating: 1600 },
        { userId: 'u-1400', seedRating: 1400 },
      ];

      const seeded = seedParticipants(participants);
      assert.deepEqual(
        seeded.map((s) => s.userId),
        ['u-1600', 'u-1400', 'u-1200'],
      );
      assert.deepEqual(
        seeded.map((s) => s.seed),
        [1, 2, 3],
      );
    });

    it('breaks ties using registeredAt date ascending', () => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 10000);
      const participants: ParticipantToSeed[] = [
        { userId: 'u-later', seedRating: 1500, registeredAt: now },
        { userId: 'u-earlier', seedRating: 1500, registeredAt: earlier },
      ];

      const seeded = seedParticipants(participants);
      assert.equal(seeded[0].userId, 'u-earlier');
      assert.equal(seeded[0].seed, 1);
      assert.equal(seeded[1].userId, 'u-later');
      assert.equal(seeded[1].seed, 2);
    });

    it('sorts a missing registeredAt after known dates, regardless of input order', () => {
      const date = new Date('2026-01-01T00:00:00Z');
      const players: ParticipantToSeed[] = [
        { userId: 'u-b', seedRating: 1500 },
        { userId: 'u-dated', seedRating: 1500, registeredAt: date },
        { userId: 'u-a', seedRating: 1500 },
      ];
      const expected = ['u-dated', 'u-a', 'u-b'];
      const permutations = [
        [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
      ];
      for (const order of permutations) {
        const seeded = seedParticipants(order.map((i) => players[i]));
        assert.deepEqual(seeded.map((p) => p.userId), expected, `input order ${order}`);
      }
    });

    it('falls back to a locale-independent userId comparison', () => {
      const seeded = seedParticipants([
        { userId: 'b', seedRating: 1500 },
        { userId: 'B', seedRating: 1500 },
        { userId: 'a', seedRating: 1500 },
      ]);
      // Code-point order: uppercase before lowercase.
      assert.deepEqual(seeded.map((p) => p.userId), ['B', 'a', 'b']);
    });
  });

  describe('generateBracket', () => {
    it('throws when fewer than 2 participants are provided', () => {
      assert.throws(
        () =>
          generateBracket({
            tournamentId: 't1',
            participants: [{ userId: 'u1', seedRating: 1200 }],
          }),
        /A tournament requires at least 2 participants/,
      );
    });

    it('throws when bracketSize is not a valid power of 2', () => {
      const participants = [
        { userId: 'u1', seedRating: 1200 },
        { userId: 'u2', seedRating: 1100 },
      ];
      assert.throws(
        () =>
          generateBracket({
            tournamentId: 't1',
            participants,
            bracketSize: 6,
          }),
        /Invalid bracket size: 6/,
      );
    });

    it('rejects a bracket size that would leave a Round 1 match without players', () => {
      const participants = [
        { userId: 'u1', seedRating: 1300 },
        { userId: 'u2', seedRating: 1200 },
        { userId: 'u3', seedRating: 1100 },
      ];
      assert.throws(
        () => generateBracket({ tournamentId: 't1', participants, bracketSize: 8 }),
        (err: unknown) =>
          err instanceof BracketGenerationError && /too large for 3 participants/.test(err.message),
      );
      // Exactly half the slots filled is also rejected (would be all byes).
      assert.throws(
        () =>
          generateBracket({
            tournamentId: 't1',
            participants: participants.slice(0, 2),
            bracketSize: 4,
          }),
        BracketGenerationError,
      );
    });

    it('throws BracketGenerationError for every invalid input', () => {
      const two = [
        { userId: 'u1', seedRating: 1200 },
        { userId: 'u2', seedRating: 1100 },
      ];
      assert.throws(
        () => generateBracket({ tournamentId: 't1', participants: two.slice(0, 1) }),
        BracketGenerationError,
      );
      assert.throws(
        () => generateBracket({ tournamentId: 't1', participants: two, bracketSize: 6 }),
        BracketGenerationError,
      );
      const many = Array.from({ length: 33 }, (_, i) => ({ userId: `u${i}`, seedRating: 1000 + i }));
      assert.throws(
        () => generateBracket({ tournamentId: 't1', participants: many }),
        BracketGenerationError,
      );
    });

    it('generates a 2-player bracket (1 round, Grand Final only)', () => {
      const participants: ParticipantToSeed[] = [
        { userId: 'p1', seedRating: 1500 },
        { userId: 'p2', seedRating: 1200 },
      ];

      const bracket = generateBracket({
        tournamentId: 't-2p',
        participants,
      });

      assert.equal(bracket.bracketSize, 2);
      assert.equal(bracket.totalRounds, 1);
      assert.equal(bracket.rounds.length, 1);
      assert.equal(bracket.matches.length, 1);

      const finalMatch = bracket.matches[0];
      assert.equal(finalMatch.identifier, 'R1-M1');
      assert.equal(finalMatch.player1Id, 'p1');
      assert.equal(finalMatch.player2Id, 'p2');
      assert.equal(finalMatch.status, 'SCHEDULED');
      assert.equal(finalMatch.isBye, false);
      assert.equal(finalMatch.nextMatchId, null);
      assert.equal(finalMatch.nextMatchSlot, null);
    });

    it('generates a 4-player bracket (2 rounds, Semifinals -> Final)', () => {
      const participants: ParticipantToSeed[] = [
        { userId: 'p1', seedRating: 1600 }, // Seed 1
        { userId: 'p2', seedRating: 1400 }, // Seed 2
        { userId: 'p3', seedRating: 1200 }, // Seed 3
        { userId: 'p4', seedRating: 1000 }, // Seed 4
      ];

      const bracket = generateBracket({
        tournamentId: 't-4p',
        participants,
      });

      assert.equal(bracket.bracketSize, 4);
      assert.equal(bracket.totalRounds, 2);
      assert.equal(bracket.rounds[0].length, 2); // 2 SFs
      assert.equal(bracket.rounds[1].length, 1); // 1 Final

      const [sf1, sf2] = bracket.rounds[0];
      const [finalMatch] = bracket.rounds[1];

      // SF1: Seed 1 (p1) vs Seed 4 (p4)
      assert.equal(sf1.identifier, 'R1-M1');
      assert.equal(sf1.player1Id, 'p1');
      assert.equal(sf1.player2Id, 'p4');
      assert.equal(sf1.status, 'SCHEDULED');
      assert.equal(sf1.nextMatchId, finalMatch.id);
      assert.equal(sf1.nextMatchSlot, 'player1');

      // SF2: Seed 2 (p2) vs Seed 3 (p3)
      assert.equal(sf2.identifier, 'R1-M2');
      assert.equal(sf2.player1Id, 'p2');
      assert.equal(sf2.player2Id, 'p3');
      assert.equal(sf2.status, 'SCHEDULED');
      assert.equal(sf2.nextMatchId, finalMatch.id);
      assert.equal(sf2.nextMatchSlot, 'player2');

      // Final: pending both winners
      assert.equal(finalMatch.identifier, 'R2-M1');
      assert.equal(finalMatch.player1Id, null);
      assert.equal(finalMatch.player2Id, null);
      assert.equal(finalMatch.status, 'PENDING');
      assert.equal(finalMatch.nextMatchId, null);
    });

    it('handles 3 players in a 4-slot bracket with 1 Bye for Seed 1', () => {
      const participants: ParticipantToSeed[] = [
        { userId: 'p1', seedRating: 1600 }, // Seed 1
        { userId: 'p2', seedRating: 1400 }, // Seed 2
        { userId: 'p3', seedRating: 1200 }, // Seed 3
      ];

      const bracket = generateBracket({
        tournamentId: 't-3p',
        participants,
      });

      assert.equal(bracket.bracketSize, 4);
      assert.equal(bracket.totalRounds, 2);

      const [m1, m2] = bracket.rounds[0];
      const [finalMatch] = bracket.rounds[1];

      // Match 1: Seed 1 vs BYE (Seed 4 absent) -> auto-wins
      assert.equal(m1.isBye, true);
      assert.equal(m1.player1Id, 'p1');
      assert.equal(m1.player2Id, null);
      assert.equal(m1.status, 'COMPLETED');
      assert.equal(m1.winnerId, 'p1');

      // Match 2: Seed 2 vs Seed 3 (active game)
      assert.equal(m2.isBye, false);
      assert.equal(m2.player1Id, 'p2');
      assert.equal(m2.player2Id, 'p3');
      assert.equal(m2.status, 'SCHEDULED');

      // Final: Seed 1 automatically advanced into player1 slot!
      assert.equal(finalMatch.player1Id, 'p1');
      assert.equal(finalMatch.player2Id, null);
      assert.equal(finalMatch.status, 'PENDING');
    });

    it('handles 6 players in an 8-slot bracket with 2 Byes for Seeds 1 & 2', () => {
      const participants: ParticipantToSeed[] = [
        { userId: 'p1', seedRating: 1600 }, // Seed 1
        { userId: 'p2', seedRating: 1500 }, // Seed 2
        { userId: 'p3', seedRating: 1400 }, // Seed 3
        { userId: 'p4', seedRating: 1300 }, // Seed 4
        { userId: 'p5', seedRating: 1200 }, // Seed 5
        { userId: 'p6', seedRating: 1100 }, // Seed 6
      ];

      const bracket = generateBracket({
        tournamentId: 't-6p',
        participants,
      });

      assert.equal(bracket.bracketSize, 8);
      assert.equal(bracket.totalRounds, 3);

      const [qf1, qf2, qf3, qf4] = bracket.rounds[0];
      const [sf1, sf2] = bracket.rounds[1];
      const [finalMatch] = bracket.rounds[2];

      // QF1: Seed 1 vs Seed 8 (BYE) -> Seed 1 auto-wins
      assert.equal(qf1.isBye, true);
      assert.equal(qf1.winnerId, 'p1');
      assert.equal(qf1.nextMatchId, sf1.id);
      assert.equal(qf1.nextMatchSlot, 'player1');

      // QF2: Seed 2 vs Seed 7 (BYE) -> Seed 2 auto-wins
      assert.equal(qf2.isBye, true);
      assert.equal(qf2.winnerId, 'p2');
      assert.equal(qf2.nextMatchId, sf2.id);
      assert.equal(qf2.nextMatchSlot, 'player1');

      // QF3: Seed 3 vs Seed 6 (Active) -> feeds SF2 player2
      assert.equal(qf3.isBye, false);
      assert.equal(qf3.player1Id, 'p3');
      assert.equal(qf3.player2Id, 'p6');
      assert.equal(qf3.status, 'SCHEDULED');
      assert.equal(qf3.nextMatchId, sf2.id);
      assert.equal(qf3.nextMatchSlot, 'player2');

      // QF4: Seed 4 vs Seed 5 (Active) -> feeds SF1 player2
      assert.equal(qf4.isBye, false);
      assert.equal(qf4.player1Id, 'p4');
      assert.equal(qf4.player2Id, 'p5');
      assert.equal(qf4.status, 'SCHEDULED');
      assert.equal(qf4.nextMatchId, sf1.id);
      assert.equal(qf4.nextMatchSlot, 'player2');

      // Semifinals:
      // SF1: Seed 1 (p1) is present waiting for winner of QF4
      assert.equal(sf1.player1Id, 'p1');
      assert.equal(sf1.player2Id, null);
      assert.equal(sf1.status, 'PENDING');

      // SF2: Seed 2 (p2) is present waiting for winner of QF3
      assert.equal(sf2.player1Id, 'p2');
      assert.equal(sf2.player2Id, null);
      assert.equal(sf2.status, 'PENDING');

      // Both SFs feed the Final
      assert.equal(sf1.nextMatchId, finalMatch.id);
      assert.equal(sf1.nextMatchSlot, 'player1');
      assert.equal(sf2.nextMatchId, finalMatch.id);
      assert.equal(sf2.nextMatchSlot, 'player2');
    });
  });
});
