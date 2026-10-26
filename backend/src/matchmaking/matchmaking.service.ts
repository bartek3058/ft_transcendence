import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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

  constructor(
    private readonly queue: QueueService,
    private readonly game: GameService,
    private readonly config: MatchmakingConfig = DEFAULT_MATCHMAKING_CONFIG,
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

  tryMatch(now: number = Date.now()): MatchResult | null {
    const pair = selectPair(this.queue.all(), now, this.config);
    if (!pair) return null;

    const [a, b] = pair;
    // Remove both before creating the game so a concurrent call can't match them twice.
    this.queue.remove(a.userId);
    this.queue.remove(b.userId);
    return this.createMatch(a, b);
  }

  matchAll(now: number = Date.now()): MatchResult[] {
    const results: MatchResult[] = [];
    let next = this.tryMatch(now);
    while (next) {
      results.push(next);
      next = this.tryMatch(now);
    }
    return results;
  }

  private createMatch(a: QueueEntry, b: QueueEntry): MatchResult {
    const gameId = randomUUID();
    // Randomise colours so neither player is always white
    const whiteFirst = Math.random() < 0.5;
    const whitePlayerId = whiteFirst ? a.userId : b.userId;
    const blackPlayerId = whiteFirst ? b.userId : a.userId;
    const timeControl = a.timeControl;

    const state = this.game.createGame({
      gameId,
      whitePlayerId,
      blackPlayerId,
      timeControl,
    });

    this.logger.log(
      `Matched ${whitePlayerId} (W) vs ${blackPlayerId} (B) [${timeControl ?? 'default'}] -> game ${gameId}`,
    );

    return { gameId, whitePlayerId, blackPlayerId, timeControl, players: [a.userId, b.userId], state };
  }
}
