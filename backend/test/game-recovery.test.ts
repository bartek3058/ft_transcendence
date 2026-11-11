import 'reflect-metadata'; // NestJS decorators (@Injectable) need this loaded before import
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Chess } from 'chess.js';
import { GameService } from '../src/game/game.service';
import { AI_BOT_USER_ID } from '../src/ai/ai.constants';
import { SERVER_RESTART_REASON } from '../src/game/types/chess.types';

/* Unit tests for GameService.recoverInterruptedGames (#76): startup recovery of games
whose in-memory session was lost by a backend restart. Control flow only. */

const WHITE = randomUUID();
const BLACK = randomUUID();

interface Row {
  id: string;
  whiteId: string | null;
  blackId: string | null;
  result: string;
  endReason?: string | null;
  tournamentMatchId: string | null;
  matchStatus?: string;
  tournamentStatus?: string;
  winnerId?: string | null;
  timeControl: string | null;
  gameStart: Date;
  moves: { ply: number; color: string; uci: string; timeRemainingMs: number | null }[];
}

// Builds a move list from UCI strings, with the remaining time each side had after it.
function moves(ucis: string[], times: (number | null)[] = []) {
  return ucis.map((uci, i) => ({
    ply: i + 1,
    color: i % 2 === 0 ? 'WHITE' : 'BLACK',
    uci,
    timeRemainingMs: times[i] ?? null,
  }));
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: randomUUID(),
    whiteId: WHITE,
    blackId: BLACK,
    result: 'IN_PROGRESS',
    tournamentMatchId: null,
    timeControl: 'rapid_10_0',
    gameStart: new Date('2026-11-09T18:42:24Z'),
    moves: [],
    ...overrides,
  };
}

// Fake PrismaService: applies the where-clauses the recovery uses to an in-memory table.
function makeFakePrisma(rows: Row[]) {
  const matches = (r: Row, where: any): boolean => {
    if (where.id !== undefined && r.id !== where.id) return false;
    if (where.result !== undefined && r.result !== where.result) return false;
    if ('tournamentMatchId' in where && r.tournamentMatchId !== where.tournamentMatchId) return false;
    if (where.tournamentMatch && (!r.tournamentMatchId
      || (r.matchStatus ?? 'IN_PROGRESS') !== where.tournamentMatch.is.status
      || (r.tournamentStatus ?? 'IN_PROGRESS') !== where.tournamentMatch.is.tournament.status
      || (r.winnerId ?? null) !== where.tournamentMatch.is.winnerId)) return false;
    if (where.OR && !where.OR.some((c: any) => matches(r, c))) return false;
    if (where.whiteId !== undefined && r.whiteId !== where.whiteId) return false;
    if (where.blackId !== undefined && r.blackId !== where.blackId) return false;
    return true;
  };
  return {
    rows,
    game: {
      async updateMany({ where, data }: any) {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
      async findMany({ where }: any) {
        return rows.filter((r) => matches(r, where)).map((r) => ({
          ...r,
          moves: [...r.moves].sort((a, b) => a.ply - b.ply),
        }));
      },
    },
  };
}

function setup(rows: Row[]) {
  const prisma = makeFakePrisma(rows);
  const rated: string[] = [];
  const rating = { async applyGameResult(id: string) { rated.push(id); return null; } };
  const service = new GameService(prisma as any, rating as any);
  return { prisma, rated, service };
}

describe('GameService.recoverInterruptedGames (#76)', () => {
  it('restores a casual game with its position, clocks and player turn', async () => {
    const game = row({ moves: moves(['e2e4', 'e7e5'], [600000, 405250]) });
    const { service } = setup([game]);

    const before = Date.now();
    const summary = await service.recoverInterruptedGames();
    assert.deepEqual(summary, { restored: 1, aborted: 0, concluded: 0 });

    const state = service.getPublicGameState(game.id);
    const expected = new Chess();
    expected.move('e4');
    expected.move('e5');
    assert.equal(state.fen, expected.fen());
    assert.deepEqual(state.moves, ['e4', 'e5']);
    assert.equal(state.turn, 'w');
    assert.equal(state.plyCount, 2);
    assert.equal(state.whiteTimeRemainingMs, 600000);
    assert.equal(state.blackTimeRemainingMs, 405250);
    assert.equal(state.timeControl, 'rapid_10_0');
    assert.equal(state.isFinished, false);

    // The clock of the side to move restarts at boot.
    const session = service.getGameSession(game.id)!;
    assert.ok(session.lastMoveTimestamp >= before);
    assert.equal(service.findActiveGameForPlayer(WHITE), game.id);
    assert.equal(service.findActiveGameForPlayer(BLACK), game.id);
    assert.equal(game.result, 'IN_PROGRESS');
  });

  it('keeps the default clock for a side that has not moved yet', async () => {
    const game = row({ moves: moves(['d2d4'], [600000]) });
    const { service } = setup([game]);
    await service.recoverInterruptedGames();
    const state = service.getPublicGameState(game.id);
    assert.equal(state.turn, 'b');
    assert.equal(state.blackTimeRemainingMs, 10 * 60 * 1000);
  });

  it('restores a game with no moves and accepts the first move after it', async () => {
    const game = row();
    const { service } = setup([game]);
    await service.recoverInterruptedGames();
    const res = service.executeMove({ gameId: game.id, from: 'e2', to: 'e4' } as any, WHITE);
    assert.equal(res.success, true);
    assert.equal(res.plyCount, 1);
  });

  it('replays a promotion move', async () => {
    // White's h-pawn reaches g7 and promotes by capturing the rook on h8.
    const game = row({
      moves: moves(['h2h4', 'g7g5', 'h4g5', 'f7f6', 'g5g6', 'e7e6', 'g6g7', 'd7d6', 'g7h8q']),
    });
    const { service } = setup([game]);
    const summary = await service.recoverInterruptedGames();
    assert.equal(summary.restored, 1);
    assert.equal(service.getPublicGameState(game.id).moves.at(-1), 'gxh8=Q');
  });

  it('aborts AI games instead of restoring them', async () => {
    const asWhite = row({ blackId: AI_BOT_USER_ID, moves: moves(['e2e4']) });
    const asBlack = row({ whiteId: AI_BOT_USER_ID });
    const { service } = setup([asWhite, asBlack]);

    const summary = await service.recoverInterruptedGames();
    assert.deepEqual(summary, { restored: 0, aborted: 2, concluded: 0 });
    for (const g of [asWhite, asBlack]) {
      assert.equal(g.result, 'ABORTED');
      assert.equal(g.endReason, SERVER_RESTART_REASON);
      assert.equal(service.hasActiveGame(g.id), false);
    }
  });

  it('restores tournament games with the same identity, position and clocks, leaving finished games alone', async () => {
    const tournament = row({ tournamentMatchId: randomUUID(), moves: moves(['e2e4', 'e7e5'], [590000, 580000]) });
    const finished = row({ result: 'WHITE_WON' });
    const { service } = setup([tournament, finished]);

    const summary = await service.recoverInterruptedGames();
    assert.deepEqual(summary, { restored: 1, aborted: 0, concluded: 0 });
    const state = service.getPublicGameState(tournament.id);
    assert.deepEqual(state.moves, ['e4', 'e5']);
    assert.equal(state.whiteTimeRemainingMs, 590000);
    assert.equal(state.blackTimeRemainingMs, 580000);
    assert.equal(service.executeMove({ gameId: tournament.id, from: 'g1', to: 'f3' } as any, WHITE).success, true);
    assert.equal(tournament.result, 'IN_PROGRESS');
    assert.equal(finished.result, 'WHITE_WON');
    assert.equal(service.getActiveGamesCount(), 1);
  });

  it('does not resurrect cancelled tournaments, resolved matches or matches with a winner', async () => {
    const games = [
      row({ tournamentMatchId: randomUUID(), tournamentStatus: 'CANCELLED' }),
      row({ tournamentMatchId: randomUUID(), matchStatus: 'FINISHED' }),
      row({ tournamentMatchId: randomUUID(), winnerId: WHITE }),
    ];
    const { service } = setup(games);
    assert.equal((await service.recoverInterruptedGames()).restored, 0);
    assert.equal(service.getActiveGamesCount(), 0);
  });

  it('aborts an unrestorable tournament history so bracket recovery can reopen check-in', async () => {
    const game = row({ tournamentMatchId: randomUUID(), moves: moves(['e2e5']) });
    const { service } = setup([game]);
    assert.equal((await service.recoverInterruptedGames()).aborted, 1);
    assert.equal(game.result, 'ABORTED');
    assert.equal(game.endReason, SERVER_RESTART_REASON);
    assert.equal(service.hasActiveGame(game.id), false);
  });

  it('aborts a game whose move history has a gap', async () => {
    const history = moves(['e2e4', 'e7e5', 'g1f3']);
    history.splice(1, 1); // ply 2 is missing
    const game = row({ moves: history });
    const { service } = setup([game]);

    const summary = await service.recoverInterruptedGames();
    assert.deepEqual(summary, { restored: 0, aborted: 1, concluded: 0 });
    assert.equal(game.result, 'ABORTED');
    assert.equal(game.endReason, SERVER_RESTART_REASON);
    assert.equal(service.hasActiveGame(game.id), false);
  });

  it('aborts a game with an illegal stored move', async () => {
    const game = row({ moves: moves(['e2e5']) });
    const { service } = setup([game]);
    const summary = await service.recoverInterruptedGames();
    assert.equal(summary.aborted, 1);
    assert.equal(game.result, 'ABORTED');
  });

  it('aborts a game that lost one of its players', async () => {
    const game = row({ blackId: null });
    const { service } = setup([game]);
    const summary = await service.recoverInterruptedGames();
    assert.equal(summary.aborted, 1);
    assert.equal(game.result, 'ABORTED');
  });

  it('concludes and rates a game whose final move was saved but not its result', async () => {
    // Fool's mate: black mates white on ply 4.
    const game = row({ moves: moves(['f2f3', 'e7e5', 'g2g4', 'd8h4']) });
    const { service, rated } = setup([game]);

    const summary = await service.recoverInterruptedGames();
    assert.deepEqual(summary, { restored: 0, aborted: 0, concluded: 1 });
    assert.equal(game.result, 'BLACK_WON');
    assert.equal(game.endReason, 'CHECKMATE');
    assert.deepEqual(rated, [game.id]);
    assert.equal(service.hasActiveGame(game.id), false);
  });

  it('does not replace a session already in memory', async () => {
    const game = row({ moves: moves(['e2e4']) });
    const { service } = setup([game]);
    service.createGame({ gameId: game.id, whitePlayerId: WHITE, blackPlayerId: BLACK });

    const summary = await service.recoverInterruptedGames();
    assert.equal(summary.restored, 0);
    assert.equal(service.getPublicGameState(game.id).plyCount, 0);
  });

  it('never throws out of the bootstrap hook', async () => {
    const service = new GameService(
      { game: { async updateMany() { throw new Error('db down'); } } } as any,
      { async applyGameResult() { return null; } } as any,
    );
    await service.onApplicationBootstrap();
    assert.equal(service.getActiveGamesCount(), 0);
  });
});
