import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateBracket,
  getBracketSize,
  seedParticipants,
} from './bracket-generator';
import { ParticipantToSeed } from './tournament-engine.types';

describe('BracketGenerator (Unit)', () => {
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
        { userId: 'p1', seedRating: 1600 },
        { userId: 'p2', seedRating: 1400 },
        { userId: 'p3', seedRating: 1200 },
        { userId: 'p4', seedRating: 1000 },
      ];

      const bracket = generateBracket({
        tournamentId: 't-4p',
        participants,
      });

      assert.equal(bracket.bracketSize, 4);
      assert.equal(bracket.totalRounds, 2);
      assert.equal(bracket.rounds[0].length, 2);
      assert.equal(bracket.rounds[1].length, 1);

      const [sf1, sf2] = bracket.rounds[0];
      const [finalMatch] = bracket.rounds[1];

      assert.equal(sf1.identifier, 'R1-M1');
      assert.equal(sf1.player1Id, 'p1');
      assert.equal(sf1.player2Id, 'p4');
      assert.equal(sf1.status, 'SCHEDULED');
      assert.equal(sf1.nextMatchId, finalMatch.id);
      assert.equal(sf1.nextMatchSlot, 'player1');

      assert.equal(sf2.identifier, 'R1-M2');
      assert.equal(sf2.player1Id, 'p2');
      assert.equal(sf2.player2Id, 'p3');
      assert.equal(sf2.status, 'SCHEDULED');
      assert.equal(sf2.nextMatchId, finalMatch.id);
      assert.equal(sf2.nextMatchSlot, 'player2');

      assert.equal(finalMatch.identifier, 'R2-M1');
      assert.equal(finalMatch.player1Id, null);
      assert.equal(finalMatch.player2Id, null);
      assert.equal(finalMatch.status, 'PENDING');
      assert.equal(finalMatch.nextMatchId, null);
    });
  });
});
