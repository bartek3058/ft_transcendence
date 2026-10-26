import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QueueService } from '../src/matchmaking/queue.service';
import { MatchmakingService } from '../src/matchmaking/matchmaking.service';
import { DEFAULT_MATCHMAKING_CONFIG } from '../src/matchmaking/pairing';

const T0 = 1_000_000;

function makeFakeGame() {
  const calls: any[] = [];
  const game = {
    calls,
    createGame(opts: any) {
      calls.push(opts);
      return { gameId: opts.gameId, whitePlayerId: opts.whitePlayerId, blackPlayerId: opts.blackPlayerId };
    },
  };
  return game;
}

function makeService() {
  const queue = new QueueService();
  const game = makeFakeGame();
  const service = new MatchmakingService(queue, game as any, DEFAULT_MATCHMAKING_CONFIG);
  return { queue, game, service };
}

describe('MatchmakingService', () => {
  it('adds a player to the queue on join', () => {
    const { queue, service } = makeService();
    service.join({ userId: 'a', rating: 1500 }, T0);
    assert.equal(queue.has('a'), true);
    assert.equal(queue.size(), 1);
  });

  it('is idempotent: re-joining keeps the original wait time', () => {
    const { queue, service } = makeService();
    service.join({ userId: 'a', rating: 1500 }, T0);
    service.join({ userId: 'a', rating: 1500 }, T0 + 5_000);
    assert.equal(queue.size(), 1);
    assert.equal(queue.get('a')!.joinedAt, T0);
  });

  it('removes a player on leave', () => {
    const { queue, service } = makeService();
    service.join({ userId: 'a', rating: 1500 }, T0);
    assert.equal(service.leave('a'), true);
    assert.equal(queue.has('a'), false);
  });

  it('returns null when only one player is waiting', () => {
    const { service } = makeService();
    service.join({ userId: 'a', rating: 1500 }, T0);
    assert.equal(service.tryMatch(T0), null);
  });

  it('matches two compatible players and removes both from the queue', () => {
    const { queue, service } = makeService();
    service.join({ userId: 'a', rating: 1500 }, T0);
    service.join({ userId: 'b', rating: 1520 }, T0);

    const match = service.tryMatch(T0);
    assert.ok(match);
    assert.equal(queue.size(), 0);
    assert.deepEqual(new Set(match!.players), new Set(['a', 'b']));
  });

  it('assigns the two players to distinct colours', () => {
    const { service } = makeService();
    service.join({ userId: 'a', rating: 1500 }, T0);
    service.join({ userId: 'b', rating: 1520 }, T0);

    const match = service.tryMatch(T0)!;
    assert.notEqual(match.whitePlayerId, match.blackPlayerId);
    assert.deepEqual(new Set([match.whitePlayerId, match.blackPlayerId]), new Set(['a', 'b']));
  });

  it('creates the game through GameService with the generated gameId', () => {
    const { game, service } = makeService();
    service.join({ userId: 'a', rating: 1500 }, T0);
    service.join({ userId: 'b', rating: 1520 }, T0);

    const match = service.tryMatch(T0)!;
    assert.equal(game.calls.length, 1);
    assert.equal(game.calls[0].gameId, match.gameId);
    assert.equal(match.state.gameId, match.gameId);
  });

  it('drains the queue into multiple matches with matchAll', () => {
    const { queue, service } = makeService();
    for (const id of ['a', 'b', 'c', 'd']) {
      service.join({ userId: id, rating: 1500 }, T0);
    }
    const matches = service.matchAll(T0);
    assert.equal(matches.length, 2);
    assert.equal(queue.size(), 0);
  });

  it('does not match players in different time controls', () => {
    const { service } = makeService();
    service.join({ userId: 'a', rating: 1500, timeControl: 'blitz_5_0' }, T0);
    service.join({ userId: 'b', rating: 1500, timeControl: 'rapid_10_0' }, T0);
    assert.equal(service.tryMatch(T0), null);
  });
});
