import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { ChatService } from './chat.service';
import { ChatMode, ChatTurn } from './chat.types';

interface ChatBody {
  mode?: ChatMode;
  message?: string;
  history?: ChatTurn[];
  fen?: string;
  moves?: string[];
  turn?: 'w' | 'b';
}

@Controller('ai')
@UseGuards(SessionGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post('chat')
  async chat(@Body() body: ChatBody): Promise<{ reply: string }> {
    const reply = await this.chat.reply({
      mode: body?.mode as ChatMode,
      message: body?.message as string,
      history: body?.history,
      game: { fen: body?.fen, moves: body?.moves, turn: body?.turn },
    });
    return { reply };
  }
}
