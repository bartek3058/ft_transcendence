import 'reflect-metadata'; // services are @Injectable, so decorators need this
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AiGameService } from '../src/ai/ai-game.service';
import { GameService } from '../src/game/game.service';
import { RatingService } from '../src/rating/rating.service';
import { AI_BOT_USER_ID, AI_BOT_DISPLAY_RATING, AI_BOT_ROLE } from '../src/ai/ai.constants';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Fake Prisma for the AI game service: a stub bot row for the seed check and a
// spy on game.create so we can inspect what gets persisted.
function makeAiGameService() {
  const created: any[] = [];
  const prisma = {
    user: {
      async findUnique() {
        return { id: AI_BOT_USER_ID };
      },
    },
    game: {
      async create(args: any) {
        created.push(args.data);
        return args.data;
      },
    },
  };
  const game = new GameService(prisma as any, {} as any);
  const service = new AiGameService(prisma as any, game);
  return { service, game, created };
}

describe('AiGameService.createAiGame', () => {
  it('seats the human and the bot on opposite colours (human as white)', async () => {
    const { service, game, created } = makeAiGameService();
    const result = await service.createAiGame({
      humanId: 'human-1',
      humanRating: 1234,
      difficulty: 'medium',
      humanColor: 'w',
    });

    assert.equal(result.humanColor, 'w');
    assert.equal(result.botColor, 'b');
    assert.equal(created[0].whiteId, 'human-1');
    assert.equal(created[0].blackId, AI_BOT_USER_ID);
    assert.equal(created[0].whiteRating, 1234);
    assert.equal(created[0].blackRating, AI_BOT_DISPLAY_RATING);
    assert.equal(created[0].result, 'IN_PROGRESS');
    // The in-memory session exists and starts from the opening position.
    assert.ok(game.hasActiveGame(result.gameId));
    assert.equal(result.state.fen, STARTPOS);
  });

  it('seats the human as black when asked (bot takes white)', async () => {
    const { service, created } = makeAiGameService();
    const result = await service.createAiGame({
      humanId: 'human-2',
      humanRating: 1500,
      difficulty: 'hard',
      humanColor: 'b',
    });
    assert.equal(result.humanColor, 'b');
    assert.equal(result.botColor, 'w');
    assert.equal(created[0].whiteId, AI_BOT_USER_ID);
    assert.equal(created[0].blackId, 'human-2');
    assert.equal(created[0].whiteRating, AI_BOT_DISPLAY_RATING);
    assert.equal(created[0].blackRating, 1500);
  });

  it('tracks the game as an AI game and can forget it', async () => {
    const { service } = makeAiGameService();
    const result = await service.createAiGame({
      humanId: 'human-3',
      humanRating: 1100,
      difficulty: 'easy',
    });
    assert.ok(service.isAiGame(result.gameId));
    const meta = service.getAiGame(result.gameId);
    assert.equal(meta?.humanId, 'human-3');
    assert.equal(meta?.difficulty, 'easy');
    assert.equal(meta?.botColor, result.humanColor === 'w' ? 'b' : 'w');

    service.forget(result.gameId);
    assert.equal(service.isAiGame(result.gameId), false);
  });

  it('rejects an unknown difficulty', async () => {
    const { service } = makeAiGameService();
    await assert.rejects(
      service.createAiGame({ humanId: 'h', humanRating: 1200, difficulty: 'insane' as any }),
    );
  });
});

// RatingService must never move ELO for a game where one side is the AI bot.
function makeRatingService(opts: { whiteRole: string; blackRole: string }) {
  const spies = { gameUpdateMany: 0, userUpdate: 0 };
  const white = { id: 'white-player', rating: 1200, role: opts.whiteRole };
  const black = { id: 'black-player', rating: 1200, role: opts.blackRole };
  const game = {
    id: 'game-1',
    result: 'WHITE_WON',
    whiteId: white.id,
    blackId: black.id,
    whiteRatingChange: null,
    blackRatingChange: null,
  };
  const tx = {
    user: {
      async findUnique({ where }: any) {
        if (where.id === white.id) return white;
        if (where.id === black.id) return black;
        return null;
      },
      async update() {
        spies.userUpdate += 1;
        return {};
      },
    },
    game: {
      async updateMany() {
        spies.gameUpdateMany += 1;
        return { count: 1 };
      },
    },
  };
  const prisma = {
    game: {
      async findUnique() {
        return game;
      },
    },
    async $transaction(fn: any) {
      return fn(tx);
    },
  };
  return { service: new RatingService(prisma as any), spies };
}

describe('RatingService.applyGameResult — AI games are unrated', () => {
  it('skips rating when the black player is the bot', async () => {
    const { service, spies } = makeRatingService({ whiteRole: 'user', blackRole: AI_BOT_ROLE });
    const result = await service.applyGameResult('game-1');
    assert.equal(result, null);
    assert.equal(spies.gameUpdateMany, 0);
    assert.equal(spies.userUpdate, 0);
  });

  it('skips rating when the white player is the bot', async () => {
    const { service, spies } = makeRatingService({ whiteRole: AI_BOT_ROLE, blackRole: 'user' });
    const result = await service.applyGameResult('game-1');
    assert.equal(result, null);
    assert.equal(spies.gameUpdateMany, 0);
  });

  it('still rates a normal human-vs-human game', async () => {
    const { service, spies } = makeRatingService({ whiteRole: 'user', blackRole: 'user' });
    const result = await service.applyGameResult('game-1');
    assert.ok(result !== null);
    assert.equal(spies.gameUpdateMany, 1);
    assert.equal(spies.userUpdate, 2);
  });
});
