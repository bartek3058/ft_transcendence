import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TournamentBracketService } from '../src/tournament/tournament-bracket.service';

/** Minimal Prisma `where` evaluator: equality, null, { in }, { not }, OR. */
function matchesWhere(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === 'OR') return (cond as any[]).some((c) => matchesWhere(row, c));
    const value = row[key] ?? null;
    if (cond === null) return value === null;
    if (typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(value);
      // Mirrors SQL: `{ not: X }` never matches NULL.
      if ('not' in cond) return cond.not === null ? value !== null : value !== null && value !== cond.not;
    }
    return value === cond;
  });
}

function updateManyIn(store: Map<string, any>, where: any, data: any) {
  let count = 0;
  for (const [id, row] of store.entries()) {
    if (matchesWhere(row, where)) {
      store.set(id, { ...row, ...data });
      count++;
    }
  }
  return { count };
}

function createMockPrisma() {
  const tournaments = new Map<string, any>();
  const participants = new Map<string, any>();
  const matches = new Map<string, any>();
  const games = new Map<string, any>();

  const tx: any = {
    // Row lock (SELECT ... FOR UPDATE) is a no-op in memory.
    $queryRaw: async () => [],
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
      updateMany: async ({ where, data }: any) =>
        updateManyIn(tournaments, where, data),
    },
    tournamentParticipant: {
      update: async ({ where, data }: any) => {
        const p = participants.get(where.id);
        const updated = { ...p, ...data };
        participants.set(where.id, updated);
        return updated;
      },
      updateMany: async ({ where, data }: any) =>
        updateManyIn(participants, where, data),
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
      findMany: async ({ where }: any) =>
        Array.from(matches.values()).filter((m) => matchesWhere(m, where)),
      update: async ({ where, data }: any) => {
        const m = matches.get(where.id);
        const updated = { ...m, ...data };
        matches.set(where.id, updated);
        return updated;
      },
      updateMany: async ({ where, data }: any) =>
        updateManyIn(matches, where, data),
      count: async ({ where }: any) =>
        Array.from(matches.values()).filter((m) => matchesWhere(m, where)).length,
    },
    game: {
      count: async ({ where }: any) =>
        Array.from(games.values()).filter((g) => matchesWhere(g, where)).length,
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

  // ---------------------------------------------------------------------------
  // State-machine guards (H3) and bracket start idempotency (M1)
  // ---------------------------------------------------------------------------

  async function setupBracket(playerCount: number, status = 'REGISTRATION_CLOSED') {
    const mock = createMockPrisma();
    const service = new TournamentBracketService({} as any);
    const tournamentId = `tourney-guard-${playerCount}`;
    mock.tournaments.set(tournamentId, { id: tournamentId, status });
    for (let i = 0; i < playerCount; i++) {
      const userId = `u${i + 1}`;
      mock.participants.set(`tp-${userId}`, {
        id: `tp-${userId}`,
        tournamentId,
        userId,
        seed: null,
        seedRating: null,
        registeredAt: new Date(1000 + i),
        user: { id: userId, rating: 2000 - i * 100 }, // u1 = seed 1, u2 = seed 2, ...
      });
    }
    const byId = (identifier: string) =>
      Array.from(mock.matches.values()).find((m) => m.identifier === identifier)!;
    return { mock, service, tournamentId, byId };
  }

  it('rejects starting a tournament twice (409, no duplicate matches)', async () => {
    const { mock, service, tournamentId } = await setupBracket(4);
    await service.generateAndSaveBracket(mock.tx, tournamentId);
    const matchCount = mock.matches.size;

    await assert.rejects(
      service.generateAndSaveBracket(mock.tx, tournamentId),
      (err: any) => err.status === 409,
    );
    assert.equal(mock.matches.size, matchCount);
  });

  it('rejects starting a tournament that is not REGISTRATION_CLOSED', async () => {
    for (const status of ['OPEN_FOR_SIGNUP', 'IN_PROGRESS', 'FINISHED', 'CANCELLED']) {
      const { mock, service, tournamentId } = await setupBracket(4, status);
      await assert.rejects(
        service.generateAndSaveBracket(mock.tx, tournamentId),
        (err: any) => err.status === 409,
        `status ${status} must be rejected`,
      );
      assert.equal(mock.matches.size, 0);
      assert.equal(mock.tournaments.get(tournamentId).status, status);
    }
  });

  it('returns 404 when starting an unknown tournament', async () => {
    const { mock, service } = await setupBracket(2);
    await assert.rejects(
      service.generateAndSaveBracket(mock.tx, 'missing'),
      (err: any) => err.status === 404,
    );
  });

  it('rejects advancing a PENDING match where only one player is known (bye side)', async () => {
    // 3 players -> u1 has a bye and already sits in the Final as player1.
    const { mock, service, tournamentId, byId } = await setupBracket(3);
    await service.generateAndSaveBracket(mock.tx, tournamentId);
    const final = byId('R2-M1');
    assert.equal(final.player1Id, 'u1');
    assert.equal(final.status, 'PENDING');

    await assert.rejects(
      service.advanceWinner(mock.tx, tournamentId, final.id, 'u1'),
      (err: any) => err.status === 409,
    );
    assert.equal(mock.tournaments.get(tournamentId).status, 'IN_PROGRESS');
    assert.equal(mock.matches.get(final.id).winnerId, null);
  });

  it('rejects advancing the same match twice', async () => {
    const { mock, service, tournamentId, byId } = await setupBracket(4);
    await service.generateAndSaveBracket(mock.tx, tournamentId);
    const sf1 = byId('R1-M1');

    await service.advanceWinner(mock.tx, tournamentId, sf1.id, 'u1');
    await assert.rejects(
      service.advanceWinner(mock.tx, tournamentId, sf1.id, 'u4'),
      (err: any) => err.status === 409,
    );
    assert.equal(mock.matches.get(sf1.id).winnerId, 'u1');
    assert.equal(mock.matches.get(byId('R2-M1').id).player1Id, 'u1');
  });

  it('rejects a walkover on an already completed match (winner is not overwritten)', async () => {
    const { mock, service, tournamentId, byId } = await setupBracket(4);
    await service.generateAndSaveBracket(mock.tx, tournamentId);
    const sf1 = byId('R1-M1');

    await service.advanceWinner(mock.tx, tournamentId, sf1.id, 'u1');
    await assert.rejects(
      service.handleWalkover(mock.tx, tournamentId, sf1.id, 'u1'),
      (err: any) => err.status === 409,
    );
    assert.equal(mock.matches.get(sf1.id).status, 'COMPLETED');
    assert.equal(mock.matches.get(sf1.id).winnerId, 'u1');
    assert.equal(mock.matches.get(byId('R2-M1').id).player1Id, 'u1');
  });

  it('rejects any result while the tournament is not IN_PROGRESS', async () => {
    const { mock, service, tournamentId, byId } = await setupBracket(4);
    await service.generateAndSaveBracket(mock.tx, tournamentId);
    const sf1 = byId('R1-M1');
    mock.tournaments.set(tournamentId, {
      ...mock.tournaments.get(tournamentId),
      status: 'CANCELLED',
    });

    await assert.rejects(
      service.advanceWinner(mock.tx, tournamentId, sf1.id, 'u1'),
      (err: any) => err.status === 409,
    );
    await assert.rejects(
      service.handleWalkover(mock.tx, tournamentId, sf1.id, 'u4'),
      (err: any) => err.status === 409,
    );
    await assert.rejects(
      service.handleMatchDraw(mock.tx, tournamentId, sf1.id),
      (err: any) => err.status === 409,
    );
    assert.equal(mock.matches.get(sf1.id).status, 'SCHEDULED');
  });

  it('rejects a draw on a match without both players (no crash on null ids)', async () => {
    const { mock, service, tournamentId, byId } = await setupBracket(3);
    await service.generateAndSaveBracket(mock.tx, tournamentId);
    await assert.rejects(
      service.handleMatchDraw(mock.tx, tournamentId, byId('R2-M1').id),
      (err: any) => err.status === 409,
    );
  });

  it('final won by walkover also assigns rank 3 to losing semifinalists', async () => {
    const { mock, service, tournamentId, byId } = await setupBracket(4);
    await service.generateAndSaveBracket(mock.tx, tournamentId);
    await service.advanceWinner(mock.tx, tournamentId, byId('R1-M1').id, 'u1');
    await service.advanceWinner(mock.tx, tournamentId, byId('R1-M2').id, 'u2');
    const result = await service.handleWalkover(
      mock.tx,
      tournamentId,
      byId('R2-M1').id,
      'u2',
    );

    assert.equal(result.championId, 'u1');
    assert.equal(mock.participants.get('tp-u1').finalRank, 1);
    assert.equal(mock.participants.get('tp-u2').finalRank, 2);
    assert.equal(mock.participants.get('tp-u3').finalRank, 3);
    assert.equal(mock.participants.get('tp-u4').finalRank, 3);
  });

  // ---------------------------------------------------------------------------
  // Double forfeit: both players absent -> both lose, nobody advances
  // ---------------------------------------------------------------------------

  it('double forfeit in a semifinal: the other finalist wins the Final by walkover', async () => {
    const { mock, service, tournamentId, byId } = await setupBracket(4);
    await service.generateAndSaveBracket(mock.tx, tournamentId);

    const df = await service.handleDoubleForfeit(mock.tx, tournamentId, byId('R1-M1').id);
    assert.equal(df.winnerId, null);
    assert.equal(df.championId, null);
    const sf1 = mock.matches.get(byId('R1-M1').id);
    assert.equal(sf1.status, 'WALKOVER');
    assert.equal(sf1.winnerId, null);
    // Final still waits for the other semifinal.
    assert.equal(mock.matches.get(byId('R2-M1').id).status, 'PENDING');

    const sf2 = await service.advanceWinner(mock.tx, tournamentId, byId('R1-M2').id, 'u2');
    assert.equal(sf2.championId, 'u2', 'cascade crowns the lone finalist');

    const final = mock.matches.get(byId('R2-M1').id);
    assert.equal(final.status, 'WALKOVER');
    assert.equal(final.winnerId, 'u2');
    assert.equal(final.player1Id, null);
    const tourney = mock.tournaments.get(tournamentId);
    assert.equal(tourney.status, 'FINISHED');
    assert.equal(tourney.championId, 'u2');
    assert.equal(mock.participants.get('tp-u2').finalRank, 1);
    assert.equal(mock.participants.get('tp-u1').finalRank, 3);
    assert.equal(mock.participants.get('tp-u4').finalRank, 3);
    assert.equal(mock.participants.get('tp-u3').finalRank, 3);
  });

  it('double forfeit after the other semifinal is done resolves the Final immediately', async () => {
    const { mock, service, tournamentId, byId } = await setupBracket(4);
    await service.generateAndSaveBracket(mock.tx, tournamentId);

    await service.advanceWinner(mock.tx, tournamentId, byId('R1-M2').id, 'u3');
    const df = await service.handleDoubleForfeit(mock.tx, tournamentId, byId('R1-M1').id);

    assert.equal(df.championId, 'u3');
    assert.equal(mock.tournaments.get(tournamentId).championId, 'u3');
    assert.equal(mock.matches.get(byId('R2-M1').id).status, 'WALKOVER');
  });

  it('double forfeit in the Final: tournament finishes without a champion', async () => {
    const { mock, service, tournamentId, byId } = await setupBracket(4);
    await service.generateAndSaveBracket(mock.tx, tournamentId);
    await service.advanceWinner(mock.tx, tournamentId, byId('R1-M1').id, 'u1');
    await service.advanceWinner(mock.tx, tournamentId, byId('R1-M2').id, 'u2');

    const df = await service.handleDoubleForfeit(mock.tx, tournamentId, byId('R2-M1').id);

    assert.equal(df.championId, null);
    const tourney = mock.tournaments.get(tournamentId);
    assert.equal(tourney.status, 'FINISHED');
    assert.equal(tourney.championId, null);
    assert.equal(mock.participants.get('tp-u1').finalRank, 2);
    assert.equal(mock.participants.get('tp-u2').finalRank, 2);
    assert.equal(mock.participants.get('tp-u3').finalRank, 3);
    assert.equal(mock.participants.get('tp-u4').finalRank, 3);
  });

  it('double forfeits in both semifinals cascade: Final has no players, no champion', async () => {
    const { mock, service, tournamentId, byId } = await setupBracket(4);
    await service.generateAndSaveBracket(mock.tx, tournamentId);

    await service.handleDoubleForfeit(mock.tx, tournamentId, byId('R1-M1').id);
    await service.handleDoubleForfeit(mock.tx, tournamentId, byId('R1-M2').id);

    const final = mock.matches.get(byId('R2-M1').id);
    assert.equal(final.status, 'WALKOVER');
    assert.equal(final.winnerId, null);
    const tourney = mock.tournaments.get(tournamentId);
    assert.equal(tourney.status, 'FINISHED');
    assert.equal(tourney.championId, null);
    for (const u of ['u1', 'u2', 'u3', 'u4']) {
      assert.equal(mock.participants.get(`tp-${u}`).finalRank, 3);
    }
  });

  it('8 players: an R1 double forfeit gives the waiting R2 player a walkover into the semifinal', async () => {
    const { mock, service, tournamentId, byId } = await setupBracket(8);
    await service.generateAndSaveBracket(mock.tx, tournamentId);
    // R1-M1 (1 v 8) and R1-M4 (4 v 5) feed R2-M1.
    await service.advanceWinner(mock.tx, tournamentId, byId('R1-M1').id, 'u1');
    await service.handleDoubleForfeit(mock.tx, tournamentId, byId('R1-M4').id);

    const r2m1 = mock.matches.get(byId('R2-M1').id);
    assert.equal(r2m1.status, 'WALKOVER');
    assert.equal(r2m1.winnerId, 'u1');
    const final = mock.matches.get(byId('R3-M1').id);
    assert.equal(final.player1Id, 'u1');
    assert.equal(final.status, 'PENDING');
    assert.equal(mock.tournaments.get(tournamentId).status, 'IN_PROGRESS');
  });

  it('rejects a double forfeit on a concluded match', async () => {
    const { mock, service, tournamentId, byId } = await setupBracket(4);
    await service.generateAndSaveBracket(mock.tx, tournamentId);
    await service.advanceWinner(mock.tx, tournamentId, byId('R1-M1').id, 'u1');
    await assert.rejects(
      service.handleDoubleForfeit(mock.tx, tournamentId, byId('R1-M1').id),
      (err: any) => err.status === 409,
    );
    assert.equal(mock.matches.get(byId('R1-M1').id).winnerId, 'u1');
  });

  // ---------------------------------------------------------------------------
  // M9: draw resolution counts only played draws
  // ---------------------------------------------------------------------------

  async function drawSetup() {
    const { mock, service, tournamentId, byId } = await setupBracket(2);
    await service.generateAndSaveBracket(mock.tx, tournamentId);
    const matchId = byId('R1-M1').id;
    return { mock, service, tournamentId, matchId };
  }

  it('draw resolution ignores decisive, aborted and abandoned games', async () => {
    const { mock, service, tournamentId, matchId } = await drawSetup();
    mock.games.set('g-a', { id: 'g-a', tournamentMatchId: matchId, result: 'ABORTED' });
    mock.games.set('g-b', { id: 'g-b', tournamentMatchId: matchId, result: 'DRAW', endReason: 'ABANDONMENT' });
    mock.games.set('g-c', { id: 'g-c', tournamentMatchId: matchId, result: 'WHITE_WON', endReason: 'CHECKMATE' });
    mock.games.set('g-1', { id: 'g-1', tournamentMatchId: matchId, result: 'DRAW', endReason: 'STALEMATE' });

    const draw = await service.handleMatchDraw(mock.tx, tournamentId, matchId);
    assert.equal(draw.action, 'REPLAY');
    assert.equal(draw.replayCount, 1, 'only the stalemate counts');
  });

  it('draw resolution rejects a match whose game is still in progress', async () => {
    const { mock, service, tournamentId, matchId } = await drawSetup();
    mock.games.set('g-1', { id: 'g-1', tournamentMatchId: matchId, result: 'DRAW', endReason: 'STALEMATE' });
    mock.games.set('g-2', { id: 'g-2', tournamentMatchId: matchId, result: 'IN_PROGRESS' });
    await assert.rejects(
      service.handleMatchDraw(mock.tx, tournamentId, matchId),
      (err: any) => err.status === 409,
    );
  });

  it('draw resolution rejects a match without any drawn game', async () => {
    const { mock, service, tournamentId, matchId } = await drawSetup();
    await assert.rejects(
      service.handleMatchDraw(mock.tx, tournamentId, matchId),
      (err: any) => err.status === 409,
    );
  });

  // ---------------------------------------------------------------------------
  // M2 / M5: invalid bracket input is a 400 and changes nothing
  // ---------------------------------------------------------------------------

  it('rejects a custom bracket size that would leave empty Round 1 matches (400)', async () => {
    const { mock, service, tournamentId } = await setupBracket(3);
    await assert.rejects(
      service.generateAndSaveBracket(mock.tx, tournamentId, 8),
      (err: any) => err.status === 400 && err.getResponse().error.code === 'INVALID_BRACKET',
    );
    assert.equal(mock.matches.size, 0);
  });

  it('rejects an invalid custom bracket size (400, not 500)', async () => {
    for (const size of [3, 64]) {
      const { mock, service, tournamentId } = await setupBracket(2);
      await assert.rejects(
        service.generateAndSaveBracket(mock.tx, tournamentId, size),
        (err: any) => err.status === 400,
        `size ${size}`,
      );
    }
  });

  it('rejects more than 32 participants (400, not 500)', async () => {
    const { mock, service, tournamentId } = await setupBracket(33);
    await assert.rejects(
      service.generateAndSaveBracket(mock.tx, tournamentId),
      (err: any) => err.status === 400 && err.getResponse().error.code === 'INVALID_BRACKET',
    );
    assert.equal(mock.matches.size, 0);
  });
});
