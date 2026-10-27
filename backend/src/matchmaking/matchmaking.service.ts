import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { GameService } from '../game/game.service';
import { PublicGameState } from '../game/types/chess.types';
import { QueueService } from './queue.service';
import {
  QueueEntry,
  MatchmakingConfig,
  DEFAULT_MATCHMAKING_CONFIG,
  selectPair,
} from './pairing';

export interface JoinQueueParams {
  userId: string;
  rating: number;
  timeControl?: string;
}

export interface MatchResult {
  gameId: string;
  whitePlayerId: string;
  blackPlayerId: string;
  timeControl?: string;
  //The two users taken out of the queue, for notifying both clients
  players: [string, string];
  state: PublicGameState;
}

@Injectable()
export class MatchmakingService {
  private readonly logger = new Logger(MatchmakingService.name);
  private readonly config: MatchmakingConfig = DEFAULT_MATCHMAKING_CONFIG;

  constructor(
    private readonly queue: QueueService,
    private readonly game: GameService,
    private readonly prisma: PrismaService,
  ) {}

  //Put a player into the queue
  join(params: JoinQueueParams, now: number = Date.now()): QueueEntry {
    const existing = this.queue.get(params.userId);
    if (existing) return existing;
    return this.queue.add({
      userId: params.userId,
      rating: params.rating,
      timeControl: params.timeControl,
      joinedAt: now,
    });
  }

  //Remove a player from the queue
  leave(userId: string): boolean {
    return this.queue.remove(userId);
  }

  async tryMatch(now: number = Date.now()): Promise<MatchResult | null> {
    const pair = selectPair(this.queue.all(), now, this.config);
    if (!pair) return null;

    const [a, b] = pair;
    // Remove both before creating the game so a concurrent call can't match them twice.
    this.queue.remove(a.userId);
    this.queue.remove(b.userId);
    return this.createMatch(a, b);
  }

  async matchAll(now: number = Date.now()): Promise<MatchResult[]> {
    const results: MatchResult[] = [];
    let next = await this.tryMatch(now);
    while (next) {
      results.push(next);
      next = await this.tryMatch(now);
    }
    return results;
  }

  private async createMatch(a: QueueEntry, b: QueueEntry): Promise<MatchResult> {
    const gameId = randomUUID();
    // Randomise colours so neither player is always white
    const whiteFirst = Math.random() < 0.5;
    const white = whiteFirst ? a : b;
    const black = whiteFirst ? b : a;
    const timeControl = a.timeControl;

    // Persist an IN_PROGRESS row (same id as the in-memory session) with the players'
    // pre-game ratings, so RatingService.applyGameResult can read it when the game ends.
    await this.prisma.game.create({
      data: {
        id: gameId,
        whiteId: white.userId,
        blackId: black.userId,
        whiteRating: white.rating,
        blackRating: black.rating,
        timeControl,
        result: 'IN_PROGRESS',
      },
    });

    const state = this.game.createGame({
      gameId,
      whitePlayerId: white.userId,
      blackPlayerId: black.userId,
      timeControl,
    });

    this.logger.log(
      `Matched ${white.userId} (W) vs ${black.userId} (B) [${timeControl ?? 'default'}] -> game ${gameId}`,
    );

    return {
      gameId,
      whitePlayerId: white.userId,
      blackPlayerId: black.userId,
      timeControl,
      players: [a.userId, b.userId],
      state,
    };
  }
}
