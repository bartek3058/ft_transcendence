import { OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketServer,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MakeMoveDto } from './dto/make-move.dto';
import { SessionService } from '../auth/session.service';
import { readSessionToken } from '../auth/session-cookie';
import { GameService } from './game.service';

interface JoinGameRoomDto {
  gameId?: string;
}

@WebSocketGateway({ namespace: '/game' })
export class GameGateway implements OnGatewayConnection, OnGatewayInit, OnModuleDestroy {
  private clockTimer: NodeJS.Timeout | null = null;
  private lastClockBroadcast = 0;
  private readonly concludingTimeouts = new Set<string>();
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly sessions: SessionService,
    private readonly game: GameService,
  ) {}

  onModuleDestroy(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
  }

  afterInit(): void {
    // One timer per gateway, not one per game or connected client.
    this.clockTimer = setInterval(() => {
      const now = Date.now();
      const shouldBroadcast = now - this.lastClockBroadcast >= 5000;
      if (shouldBroadcast) this.lastClockBroadcast = now;
      for (const gameId of this.game.getActiveGameIds()) {
        if (this.concludingTimeouts.has(gameId)) continue;
        if (this.game.checkGameTimeout(gameId, now)) {
          void this.finishTimedOutGame(gameId);
          continue;
        }
        if (shouldBroadcast) {
          const snapshot = this.game.getClockSnapshot(gameId, now);
          if (snapshot && !snapshot.isFinished) {
            this.server.to(gameId).emit('game:clock', snapshot);
          }
        }
      }
    }, 250);
    this.clockTimer.unref();
  }

  private async finishTimedOutGame(gameId: string): Promise<void> {
    if (this.concludingTimeouts.has(gameId)) return;
    this.concludingTimeouts.add(gameId);
    try {
      if (!this.game.hasActiveGame(gameId)) return;
      this.server.to(gameId).emit('game:state', this.game.getPublicGameState(gameId));
      await this.game.removeGame(gameId);
    } finally {
      this.concludingTimeouts.delete(gameId);
    }
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = readSessionToken({
        headers: {
          cookie: client.handshake.headers.cookie,
        },
      });

      const account = await this.sessions.authenticate(token);

      client.data.userId = account.id;

      // The client must wait until authentication has completed
      // before sending game:join.
      client.emit('game:ready');
    } catch {
      client.emit('game:error', {
        code: 'UNAUTHENTICATED',
      });

      client.disconnect(true);
    }
  }

  @SubscribeMessage('game:join')
  async handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinGameRoomDto,
  ): Promise<void> {
    const userId: string | undefined = client.data.userId;

    if (!userId) {
      client.emit('game:error', {
        code: 'UNAUTHENTICATED',
      });

      client.disconnect(true);
      return;
    }

    const gameId = dto?.gameId?.trim();

    if (!gameId) {
      client.emit('game:error', {
        code: 'GAME_ID_REQUIRED',
      });

      return;
    }

    const session = this.game.getGameSession(gameId);

    if (!session) {
      client.emit('game:error', {
        code: 'GAME_NOT_FOUND',
      });

      return;
    }

    if (
      session.whitePlayerId !== userId &&
      session.blackPlayerId !== userId
    ) {
      client.emit('game:error', {
        code: 'NOT_A_PLAYER',
      });

      return;
    }

    await client.join(gameId);

    const state = this.game.getPublicGameState(gameId);

    client.emit('game:joined', {
      gameId,
      color: session.whitePlayerId === userId ? 'w' : 'b',
      state,
    });
  }


  @SubscribeMessage('game:move')
  handleMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: MakeMoveDto,
  ): void {
    const userId: string | undefined = client.data.userId;
    if (!userId) {
      client.emit('game:error', { code: 'UNAUTHENTICATED' });
      return;
    }

    if (
      !dto || typeof dto.gameId !== 'string' ||
      !/^[a-h][1-8]$/.test(dto.from) ||
      !/^[a-h][1-8]$/.test(dto.to) ||
      (dto.promotion !== undefined && !['q', 'r', 'b', 'n'].includes(dto.promotion))
    ) {
      client.emit('game:error', { code: 'INVALID_MOVE' });
      return;
    }

    if (!client.rooms.has(dto.gameId)) {
      client.emit('game:error', { code: 'NOT_IN_ROOM' });
      return;
    }

    const result = this.game.executeMove(dto, userId);

if (!result.success) {
  if (result.errorReason === 'TIMEOUT') {
    void this.finishTimedOutGame(dto.gameId);
  }

  client.emit('game:error', {
    code: result.errorReason ?? 'ILLEGAL_MOVE',
    state: this.game.hasActiveGame(dto.gameId)
      ? this.game.getPublicGameState(dto.gameId)
      : undefined,
  });

  return;
}

    this.server.to(dto.gameId).emit('game:state',
      this.game.getPublicGameState(dto.gameId));
  }

  @SubscribeMessage('game:leave')
  async handleLeaveRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinGameRoomDto,
  ): Promise<void> {
    if (typeof dto?.gameId === 'string') {
      await client.leave(dto.gameId);
    }
  }

  @SubscribeMessage('game:resign')
  async handleResign(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinGameRoomDto,
  ): Promise<{ success: boolean; code?: string }> {
    const userId: string | undefined = client.data.userId;
    if (!userId) {
      return { success: false, code: 'UNAUTHENTICATED' };
    }

    const gameId = typeof dto?.gameId === 'string' ? dto.gameId.trim() : '';
    if (!gameId) {
      return { success: false, code: 'GAME_ID_REQUIRED' };
    }
    if (!client.rooms.has(gameId)) {
      return { success: false, code: 'NOT_IN_ROOM' };
    }

    const result = this.game.resignGame(gameId, userId);
    if (!result.success) {
      return { success: false, code: result.errorReason ?? 'RESIGN_FAILED' };
    }

    // Deliver the final state before removeGame purges the in-memory session.
    this.server.to(gameId).emit('game:state', this.game.getPublicGameState(gameId));

    // Persist result, moves and rating using the existing conclusion pipeline.
    const saved = await this.game.removeGame(gameId);
    if (!saved) {
      return { success: false, code: 'GAME_RESULT_SAVE_FAILED' };
    }
    return { success: true };
  }

}
