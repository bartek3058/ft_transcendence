import 'reflect-metadata'; // NestJS decorators (@Injectable) need this loaded before import
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { GameService } from '../src/game/game.service';
import { GameConclusionEvent } from '../src/game/types/chess.types';
import { TournamentGameService } from '../src/tournament/tournament-game.service';
import { TournamentEventsPublisher } from '../src/tournament/tournament-events.publisher';

/* Unit tests for the game -> tournament integration (#68). Control flow only;
SQL validity (partial unique index, conditional updates) needs a Postgres test. */

function makeGameService(rowResult = 'IN_PROGRESS') {
  const gameId = randomUUID();
  const rows: Record<string, { result: string }> = { [gameId]: { result: rowResult } };
  const prisma = {
    game: {
      async updateMany(args: any) {
        const row = rows[args.where.id];
        if (!row || row.result !== args.where.result) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
  };
  const rating = { async applyGameResult() { return null; } };
  const service = new GameService(prisma as any, rating as any);
  service.createGame({ gameId, whitePlayerId: 'white-user', blackPlayerId: 'black-user' });
  return { service, gameId };
}

describe('GameService.onGameConcluded', () => {
  it('notifies listeners once with the persisted result and players', async () => {
    const { service, gameId } = makeGameService();
    const events: GameConclusionEvent[] = [];
    service.onGameConcluded((e) => {
      events.push(e);
    });

    await service.removeGame(gameId, { winnerColor: 'b', gameOverReason: 'RESIGNATION' });

    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      gameId,
      result: 'BLACK_WON',
      endReason: 'RESIGNATION',
      whitePlayerId: 'white-user',
      blackPlayerId: 'black-user',
    });
  });

  it('does not notify when the result row was not written (already concluded)', async () => {
    const { service, gameId } = makeGameService('WHITE_WON');
    let calls = 0;
    service.onGameConcluded(() => {
      calls++;
    });
    await service.removeGame(gameId, { winnerColor: 'w', gameOverReason: 'TIMEOUT' });
    assert.equal(calls, 0);
  });

  it('a failing listener does not block the session purge', async () => {
    const { service, gameId } = makeGameService();
    service.onGameConcluded(() => {
      throw new Error('listener boom');
    });
    assert.equal(
      await service.removeGame(gameId, { winnerColor: 'w', gameOverReason: 'RESIGNATION' }),
      true,
    );
    assert.equal(service.hasActiveGame(gameId), false);
  });
});

// TournamentGameService orchestration
function makeTournamentGameService(opts: {
  gameRow?: { tournamentId: string | null; tournamentMatchId: string | null } | null;
  matchStatus?: string;
  drawAction?: 'REPLAY' | 'ADVANCED_BY_SEED';
  advanceError?: Error;
} = {}) {
  const calls = {
    advanceWinner: [] as any[],
    handleMatchDraw: [] as any[],
    handleWalkover: [] as any[],
    handleDoubleForfeit: [] as any[],
    gameCreate: [] as any[],
    matchUpdates: [] as any[],
    sessions: [] as any[],
  };
  const match = {
    id: 'match-1',
    tournamentId: 'tour-1',
    status: opts.matchStatus ?? 'IN_PROGRESS',
    player1Id: 'p1',
    player2Id: 'p2',
  };

  const tx: any = {
    tournamentMatch: {
      async findUnique() {
        return { ...match };
      },
      async updateMany(args: any) {
        calls.matchUpdates.push(args);
        if (!args.where.status.in.includes(match.status)) return { count: 0 };
        Object.assign(match, args.data);
        return { count: 1 };
      },
    },
    user: {
      async findUnique({ where }: any) {
        return { rating: where.id === 'p1' ? 1600 : 1500 };
      },
    },
    game: {
      async create(args: any) {
        calls.gameCreate.push(args.data);
        return args.data;
      },
    },
  };

  const prisma: any = {
    game: {
      async findUnique() {
        return opts.gameRow === undefined
          ? { tournamentId: 'tour-1', tournamentMatchId: 'match-1' }
          : opts.gameRow;
      },
    },
    async $transaction(fn: (t: any) => Promise<any>) {
      return fn(tx);
    },
  };

  let listener: ((e: GameConclusionEvent) => Promise<void> | void) | null = null;
  const gameService: any = {
    onGameConcluded(l: any) {
      listener = l;
    },
    createGame(o: any) {
      calls.sessions.push(o);
    },
  };

  const bracket: any = {
    async advanceWinner(_tx: any, tournamentId: string, matchId: string, winnerId: string) {
      calls.advanceWinner.push({ tournamentId, matchId, winnerId });
      if (opts.advanceError) throw opts.advanceError;
      return { completedMatchId: matchId, winnerId, nextMatchId: null, championId: null };
    },
    async handleWalkover(_tx: any, tournamentId: string, matchId: string, forfeitedUserId: string) {
      calls.handleWalkover.push({ tournamentId, matchId, forfeitedUserId });
      return { completedMatchId: matchId, winnerId: null, nextMatchId: null, championId: null };
    },
    async handleDoubleForfeit(_tx: any, tournamentId: string, matchId: string) {
      calls.handleDoubleForfeit.push({ tournamentId, matchId });
      return { completedMatchId: matchId, winnerId: null, nextMatchId: null, championId: null };
    },
    async handleMatchDraw(_tx: any, tournamentId: string, matchId: string) {
      calls.handleMatchDraw.push({ tournamentId, matchId });
      return { action: opts.drawAction ?? 'REPLAY', replayCount: 1 };
    },
  };

  const service = new TournamentGameService(prisma, gameService, bracket, new TournamentEventsPublisher());
  service.onModuleInit();
  return { service, calls, match, fire: (e: GameConclusionEvent) => listener!(e) };
}

const event = (result: GameConclusionEvent['result']): GameConclusionEvent => ({
  gameId: 'game-1',
  result,
  endReason: result === 'DRAW' ? 'STALEMATE' : 'CHECKMATE',
  whitePlayerId: 'p1',
  blackPlayerId: 'p2',
});

describe('TournamentGameService', () => {
  it('registers itself as a GameService conclusion listener', async () => {
    const { calls, fire } = makeTournamentGameService();
    await fire(event('WHITE_WON'));
    assert.equal(calls.advanceWinner.length, 1);
  });

  it('ignores games that are not linked to a tournament match', async () => {
    const { service, calls } = makeTournamentGameService({
      gameRow: { tournamentId: null, tournamentMatchId: null },
    });
    await service.handleGameConcluded(event('WHITE_WON'));
    assert.equal(calls.advanceWinner.length, 0);
    assert.equal(calls.handleMatchDraw.length, 0);
  });

  it('advances the winner on a decisive result', async () => {
    const { service, calls } = makeTournamentGameService();
    await service.handleGameConcluded(event('BLACK_WON'));
    assert.deepEqual(calls.advanceWinner, [
      { tournamentId: 'tour-1', matchId: 'match-1', winnerId: 'p2' },
    ]);
    assert.equal(calls.sessions.length, 0);
  });

  it('creates a replay with swapped colors on a draw', async () => {
    const { service, calls } = makeTournamentGameService({ drawAction: 'REPLAY' });
    await service.handleGameConcluded(event('DRAW'));

    assert.equal(calls.handleMatchDraw.length, 1);
    assert.equal(calls.gameCreate.length, 1);
    const row = calls.gameCreate[0];
    assert.equal(row.whiteId, 'p2'); // was Black
    assert.equal(row.blackId, 'p1'); // was White
    assert.equal(row.tournamentId, 'tour-1');
    assert.equal(row.tournamentMatchId, 'match-1');
    assert.equal(row.result, 'IN_PROGRESS');
    assert.equal(row.whiteRating, 1500);
    assert.equal(row.blackRating, 1600);

    assert.equal(calls.sessions.length, 1);
    assert.equal(calls.sessions[0].gameId, row.id);
    assert.equal(calls.sessions[0].whitePlayerId, 'p2');
  });

  it('does not create a replay once the seed tiebreak decided the match', async () => {
    const { service, calls } = makeTournamentGameService({ drawAction: 'ADVANCED_BY_SEED' });
    await service.handleGameConcluded(event('DRAW'));
    assert.equal(calls.gameCreate.length, 0);
    assert.equal(calls.sessions.length, 0);
  });

  it('leaves the bracket unchanged for an aborted game', async () => {
    const { service, calls } = makeTournamentGameService();
    await service.handleGameConcluded(event('ABORTED'));
    assert.equal(calls.advanceWinner.length, 0);
    assert.equal(calls.handleMatchDraw.length, 0);
  });

  it('treats a 409 from the bracket as already applied (no throw)', async () => {
    const { service } = makeTournamentGameService({
      advanceError: new ConflictException('already concluded'),
    });
    await service.handleGameConcluded(event('WHITE_WON'));
  });

  it('rethrows unexpected errors so GameService logs them', async () => {
    const { service } = makeTournamentGameService({ advanceError: new Error('db down') });
    await assert.rejects(service.handleGameConcluded(event('WHITE_WON')), /db down/);
  });

  it('startMatchGame: player1 plays White and the match moves to IN_PROGRESS', async () => {
    const { service, calls, match } = makeTournamentGameService({ matchStatus: 'SCHEDULED' });
    const created = await service.startMatchGame('tour-1', 'match-1');

    assert.equal(created.whitePlayerId, 'p1');
    assert.equal(created.blackPlayerId, 'p2');
    assert.equal(match.status, 'IN_PROGRESS');
    assert.equal(calls.sessions.length, 1);
  });

  it('startMatchGame: rejects a match that is not SCHEDULED', async () => {
    const { service, calls } = makeTournamentGameService({ matchStatus: 'COMPLETED' });
    await assert.rejects(
      service.startMatchGame('tour-1', 'match-1'),
      (err: any) => err.status === 409,
    );
    assert.equal(calls.gameCreate.length, 0);
    assert.equal(calls.sessions.length, 0);
  });

  it('ABANDONMENT with a winner is a walkover for the absent player', async () => {
    const { service, calls } = makeTournamentGameService();
    await service.handleGameConcluded({ ...event('WHITE_WON'), endReason: 'ABANDONMENT' });
    assert.deepEqual(calls.handleWalkover, [
      { tournamentId: 'tour-1', matchId: 'match-1', forfeitedUserId: 'p2' },
    ]);
    assert.equal(calls.advanceWinner.length, 0);
  });

  it('ABANDONMENT without a winner is a double forfeit (no replay)', async () => {
    const { service, calls } = makeTournamentGameService();
    await service.handleGameConcluded({ ...event('DRAW'), endReason: 'ABANDONMENT' });
    assert.deepEqual(calls.handleDoubleForfeit, [{ tournamentId: 'tour-1', matchId: 'match-1' }]);
    assert.equal(calls.handleMatchDraw.length, 0);
    assert.equal(calls.gameCreate.length, 0);
  });
});
