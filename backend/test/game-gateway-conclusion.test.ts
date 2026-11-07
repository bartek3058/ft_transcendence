import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GameGateway } from '../src/game/game.gateway';

// A move that ends the game on the board (checkmate, stalemate, repetition,
// insufficient material) must go through removeGame() like a timeout or a
// resignation: otherwise the result is never persisted, the session lingers in
// memory and the tournament bracket hook never fires.

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function setup(moveResult: { isGameOver: boolean }) {
  const calls = { removeGame: 0, emitted: [] as string[] };
  let active = true;
  let releaseRemove: () => void = () => undefined;

  const game: any = {
    executeMove: () => ({ success: true, currentFen: 'fen', ...moveResult }),
    getPublicGameState: () => ({ gameId: GAME_ID }),
    hasActiveGame: () => active,
    removeGame: async () => {
      calls.removeGame++;
      // Hold the conclusion open so a second trigger overlaps with it.
      await new Promise<void>((resolve) => {
        releaseRemove = resolve;
      });
      active = false;
      return true;
    },
  };
  const gateway = new GameGateway({} as any, game);
  gateway.server = {
    to: () => ({ emit: (event: string) => calls.emitted.push(event) }),
  } as any;

  const client: any = {
    data: { userId: USER_ID },
    rooms: new Set([GAME_ID]),
    emit: () => undefined,
  };
  const move = () =>
    gateway.handleMove(client, { gameId: GAME_ID, from: 'd8', to: 'h4' } as any);

  return { gateway, calls, move, finishRemove: () => releaseRemove() };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('GameGateway: game-ending moves are persisted', () => {
  it('a move that ends the game calls removeGame once', async () => {
    const { calls, move, finishRemove } = setup({ isGameOver: true });
    move();
    await flush();
    assert.equal(calls.removeGame, 1);
    assert.deepEqual(calls.emitted, ['game:state'], 'final state broadcast exactly once');
    finishRemove();
    await flush();
  });

  it('a normal move does not conclude the game', async () => {
    const { calls, move } = setup({ isGameOver: false });
    move();
    await flush();
    assert.equal(calls.removeGame, 0);
  });

  it('a timeout check during the conclusion does not conclude twice', async () => {
    const { gateway, calls, move, finishRemove } = setup({ isGameOver: true });
    move();
    await flush();
    // Same guard as the clock ticker path.
    await Promise.race([(gateway as any).finishTimedOutGame(GAME_ID), flush()]);
    assert.equal(calls.removeGame, 1);
    finishRemove();
    await flush();
  });
});
