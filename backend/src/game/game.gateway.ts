import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { SessionService } from '../auth/session.service';
import { readSessionToken } from '../auth/session-cookie';
import { GameService } from './game.service';

interface JoinGameRoomDto {
  gameId?: string;
}

@WebSocketGateway({ namespace: '/game' })
export class GameGateway implements OnGatewayConnection {
  constructor(
    private readonly sessions: SessionService,
    private readonly game: GameService,
  ) {}

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
}
