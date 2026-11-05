import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TournamentBracketService } from '../src/tournament/tournament-bracket.service';

function createMockPrisma() {
  const tournaments = new Map<string, any>();
  const participants = new Map<string, any>();
  const matches = new Map<string, any>();
  const games = new Map<string, any>();

  const tx: any = {
    tournament: {
      findUnique: async ({ where }: any) => {
        const t = tournaments.get(where.id);
        if (!t) return null;
        const pts = Array.from(participants.values()).filter(
          (p) => p.tournamentId === where.id,
        );
        return { ...t, participants: pts };
      },
      update: async ({ where, data }: any) => {
        const t = tournaments.get(where.id);
        const updated = { ...t, ...data };
        tournaments.set(where.id, updated);
        return updated;
      },
    },
    tournamentParticipant: {
      update: async ({ where, data }: any) => {
        const p = participants.get(where.id);
        const updated = { ...p, ...data };
        participants.set(where.id, updated);
        return updated;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const [id, p] of participants.entries()) {
          if (
            (!where.tournamentId || p.tournamentId === where.tournamentId) &&
            (!where.userId || p.userId === where.userId)
          ) {
            participants.set(id, { ...p, ...data });
            count++;
          }
        }
        return { count };
      },
      findMany: async ({ where }: any) => {
        return Array.from(participants.values()).filter((p) => {
          if (where.tournamentId && p.tournamentId !== where.tournamentId)
            return false;
          if (where.userId?.in && !where.userId.in.includes(p.userId))
            return false;
          return true;
        });
      },
    },
    tournamentMatch: {
      createMany: async ({ data }: any) => {
        for (const m of data) {
          matches.set(m.id, { ...m });
        }
        return { count: data.length };
      },
      findUnique: async ({ where }: any) => {
        return matches.get(where.id) ?? null;
      },
      findMany: async ({ where }: any) => {
        return Array.from(matches.values()).filter((m) => {
          if (where.tournamentId && m.tournamentId !== where.tournamentId)
            return false;
          if (where.round && m.round !== where.round) return false;
          return true;
        });
      },
      update: async ({ where, data }: any) => {
        const m = matches.get(where.id);
        const updated = { ...m, ...data };
        matches.set(where.id, updated);
        return updated;
      },
    },
    game: {
      count: async ({ where }: any) => {
        let count = 0;
        for (const g of games.values()) {
          if (
            where.tournamentMatchId &&
            g.tournamentMatchId === where.tournamentMatchId
          ) {
            count++;
          }
        }
        return count;
      },
    },
  };

  return {
    tx,
    tournaments,
    participants,
    matches,
    games,
  };
}

describe('TournamentBracketService (Database Service)', () => {
  it('generates and persists bracket, seeds participants, and resolves byes', async () => {
    const mock = createMockPrisma();
    const service = new TournamentBracketService({} as any);

    // Setup tournament with 3 participants (bracket size 4 -> 1 Bye for Seed 1)
    const tournamentId = 'tourney-1';
    mock.tournaments.set(tournamentId, {
      id: tournamentId,
      status: 'REGISTRATION_CLOSED',
    });

    mock.participants.set('tp-1', {
      id: 'tp-1',
      tournamentId,
      userId: 'user-alice',
      seed: null,
      seedRating: null,
      registeredAt: new Date(1000),
      user: { id: 'user-alice', rating: 1600 },
    });
    mock.participants.set('tp-2', {
      id: 'tp-2',
      tournamentId,
      userId: 'user-bob',
      seed: null,
      seedRating: null,
      registeredAt: new Date(2000),
      user: { id: 'user-bob', rating: 1400 },
    });
    mock.participants.set('tp-3', {
      id: 'tp-3',
      tournamentId,
      userId: 'user-charlie',
      seed: null,
      seedRating: null,
      registeredAt: new Date(3000),
      user: { id: 'user-charlie', rating: 1200 },
    });

    const bracket = await service.generateAndSaveBracket(
      mock.tx,
      tournamentId,
    );

    assert.equal(bracket.bracketSize, 4);
    assert.equal(bracket.matches.length, 3); // 2 SFs + 1 Final

    // Check participants were seeded and frozen
    const alice = mock.participants.get('tp-1');
    assert.equal(alice.seed, 1);
    assert.equal(alice.seedRating, 1600);

    const bob = mock.participants.get('tp-2');
    assert.equal(bob.seed, 2);
    assert.equal(bob.seedRating, 1400);

    // Check tournament status updated to IN_PROGRESS
    const tourney = mock.tournaments.get(tournamentId);
    assert.equal(tourney.status, 'IN_PROGRESS');

    // Check matches in DB
    const allMatches = Array.from(mock.matches.values());
    const r1m1 = allMatches.find((m) => m.identifier === 'R1-M1');
    const r1m2 = allMatches.find((m) => m.identifier === 'R1-M2');
    const r2m1 = allMatches.find((m) => m.identifier === 'R2-M1');

    assert.ok(r1m1);
    assert.ok(r1m2);
    assert.ok(r2m1);

    // R1-M1 was Alice vs BYE -> auto-completed
    assert.equal(r1m1.isBye, true);
    assert.equal(r1m1.status, 'COMPLETED');
    assert.equal(r1m1.winnerId, 'user-alice');

    // R1-M2 was Bob vs Charlie -> SCHEDULED
    assert.equal(r1m2.isBye, false);
    assert.equal(r1m2.status, 'SCHEDULED');

    // R2-M1 (Final) has Alice placed in player1 slot!
    assert.equal(r2m1.player1Id, 'user-alice');
    assert.equal(r2m1.player2Id, null);
    assert.equal(r2m1.status, 'PENDING');
  });

  it('advances winner through semifinals to Final, crowns champion, and records final rankings', async () => {
    const mock = createMockPrisma();
    const service = new TournamentBracketService({} as any);

    const tournamentId = 'tourney-4p';
    mock.tournaments.set(tournamentId, {
      id: tournamentId,
      status: 'REGISTRATION_CLOSED',
    });

    // 4 participants: Alice (1600), Bob (1400), Charlie (1200), David (1000)
    const userIds = ['alice', 'bob', 'charlie', 'david'];
    const ratings = [1600, 1400, 1200, 1000];
    userIds.forEach((u, i) => {
      mock.participants.set(`tp-${u}`, {
        id: `tp-${u}`,
        tournamentId,
        userId: u,
        user: { id: u, rating: ratings[i] },
      });
    });

    await service.generateAndSaveBracket(mock.tx, tournamentId);

    const allMatches = Array.from(mock.matches.values());
    const sf1 = allMatches.find((m) => m.identifier === 'R1-M1')!;
    const sf2 = allMatches.find((m) => m.identifier === 'R1-M2')!;
    const finalMatch = allMatches.find((m) => m.identifier === 'R2-M1')!;

    // Play SF1: Alice defeats David
    const sf1Result = await service.advanceWinner(
      mock.tx,
      tournamentId,
      sf1.id,
      'alice',
    );
    assert.equal(sf1Result.winnerId, 'alice');
    assert.equal(sf1Result.championId, null);

    // Final match should have Alice in player1 slot, status still PENDING
    const updatedFinal1 = mock.matches.get(finalMatch.id);
    assert.equal(updatedFinal1.player1Id, 'alice');
    assert.equal(updatedFinal1.player2Id, null);
    assert.equal(updatedFinal1.status, 'PENDING');

    // Play SF2: Bob defeats Charlie
    const sf2Result = await service.advanceWinner(
      mock.tx,
      tournamentId,
      sf2.id,
      'bob',
    );
    assert.equal(sf2Result.winnerId, 'bob');

    // Both players present in Final -> should transition to SCHEDULED!
    const updatedFinal2 = mock.matches.get(finalMatch.id);
    assert.equal(updatedFinal2.player1Id, 'alice');
    assert.equal(updatedFinal2.player2Id, 'bob');
    assert.equal(updatedFinal2.status, 'SCHEDULED');

    // Play Grand Final: Alice defeats Bob!
    const finalResult = await service.advanceWinner(
      mock.tx,
      tournamentId,
      finalMatch.id,
      'alice',
    );

    assert.equal(finalResult.championId, 'alice');

    // Check tournament completed
    const finishedTournament = mock.tournaments.get(tournamentId);
    assert.equal(finishedTournament.status, 'FINISHED');
    assert.equal(finishedTournament.championId, 'alice');

    // Check final rankings
    assert.equal(mock.participants.get('tp-alice').finalRank, 1);
    assert.equal(mock.participants.get('tp-bob').finalRank, 2);
    assert.equal(mock.participants.get('tp-charlie').finalRank, 3);
    assert.equal(mock.participants.get('tp-david').finalRank, 3);
  });

  it('handles knockout draw: replays first 2 draws, then advances better seed on 3rd draw', async () => {
    const mock = createMockPrisma();
    const service = new TournamentBracketService({} as any);

    const tournamentId = 'tourney-draw';
    mock.tournaments.set(tournamentId, { id: tournamentId, status: 'IN_PROGRESS' });

    mock.participants.set('tp-seed1', {
      id: 'tp-seed1',
      tournamentId,
      userId: 'user-seed1',
      seed: 1,
    });
    mock.participants.set('tp-seed4', {
      id: 'tp-seed4',
      tournamentId,
      userId: 'user-seed4',
      seed: 4,
    });

    const matchId = 'match-draw-1';
    mock.matches.set(matchId, {
      id: matchId,
      tournamentId,
      round: 1,
      matchIndex: 0,
      player1Id: 'user-seed1',
      player2Id: 'user-seed4',
      status: 'IN_PROGRESS',
      winnerId: null,
      nextMatchId: null, // Final round
    });

    // Draw 1: count = 1
    mock.games.set('g-1', { id: 'g-1', tournamentMatchId: matchId, result: 'DRAW' });
    const draw1 = await service.handleMatchDraw(mock.tx, tournamentId, matchId);
    assert.equal(draw1.action, 'REPLAY');
    assert.equal(draw1.replayCount, 1);

    // Draw 2: count = 2
    mock.games.set('g-2', { id: 'g-2', tournamentMatchId: matchId, result: 'DRAW' });
    const draw2 = await service.handleMatchDraw(mock.tx, tournamentId, matchId);
    assert.equal(draw2.action, 'REPLAY');
    assert.equal(draw2.replayCount, 2);

    // Draw 3: count = 3 -> Replay limit reached! Advance by better seed (Seed 1)
    mock.games.set('g-3', { id: 'g-3', tournamentMatchId: matchId, result: 'DRAW' });
    const draw3 = await service.handleMatchDraw(mock.tx, tournamentId, matchId);
    assert.equal(draw3.action, 'ADVANCED_BY_SEED');
    assert.equal(draw3.winnerId, 'user-seed1');
    assert.equal(draw3.advanceResult?.championId, 'user-seed1');

    const finished = mock.tournaments.get(tournamentId);
    assert.equal(finished.championId, 'user-seed1');
  });

  it('handles player walkover: awards victory to opponent and advances them', async () => {
    const mock = createMockPrisma();
    const service = new TournamentBracketService({} as any);

    const tournamentId = 'tourney-wo';
    mock.tournaments.set(tournamentId, { id: tournamentId, status: 'IN_PROGRESS' });

    mock.participants.set('tp-p1', { id: 'tp-p1', tournamentId, userId: 'p1' });
    mock.participants.set('tp-p2', { id: 'tp-p2', tournamentId, userId: 'p2' });

    const matchId = 'm-wo-1';
    mock.matches.set(matchId, {
      id: matchId,
      tournamentId,
      round: 1,
      matchIndex: 0,
      player1Id: 'p1',
      player2Id: 'p2',
      status: 'SCHEDULED',
      winnerId: null,
      nextMatchId: null, // Final
    });

    // p2 forfeits -> p1 wins by walkover!
    const woResult = await service.handleWalkover(
      mock.tx,
      tournamentId,
      matchId,
      'p2',
    );

    assert.equal(woResult.winnerId, 'p1');
    assert.equal(woResult.championId, 'p1');

    const match = mock.matches.get(matchId);
    assert.equal(match.status, 'WALKOVER');
    assert.equal(match.winnerId, 'p1');

    const tourney = mock.tournaments.get(tournamentId);
    assert.equal(tourney.championId, 'p1');
    assert.equal(mock.participants.get('tp-p1').finalRank, 1);
    assert.equal(mock.participants.get('tp-p2').finalRank, 2);
  });
});
