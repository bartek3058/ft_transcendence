import { BadRequestException, Injectable } from '@nestjs/common';
import { LlmService } from './llm.service';
import { SYSTEM_PROMPTS, buildGameContextPrompt } from './chat.prompts';
import { CHAT_MODES, ChatMode, ChatRequest, ChatTurn, LlmMessage } from './chat.types';

const MAX_MESSAGE_LENGTH = 1000;
const MAX_HISTORY_TURNS = 12; // how many prior turns we keep for context
const MAX_HISTORY_CONTENT = 2000;

@Injectable()
export class ChatService {
  constructor(private readonly llm: LlmService) {}

  async reply(request: ChatRequest): Promise<string> {
    const mode = this.validateMode(request.mode);
    const message = this.validateMessage(request.message);
    const history = this.sanitizeHistory(request.history);

    const messages: LlmMessage[] = [{ role: 'system', content: SYSTEM_PROMPTS[mode] }];

    const context = request.game ? buildGameContextPrompt(request.game) : null;
    if (context) {
      messages.push({ role: 'system', content: context });
    }

    for (const turn of history) {
      messages.push({ role: turn.role, content: turn.content });
    }
    messages.push({ role: 'user', content: message });

    return this.llm.complete(messages);
  }

  private validateMode(mode: unknown): ChatMode {
    if (typeof mode !== 'string' || !CHAT_MODES.includes(mode as ChatMode)) {
      throw new BadRequestException(`mode must be one of: ${CHAT_MODES.join(', ')}.`);
    }
    return mode as ChatMode;
  }

  private validateMessage(message: unknown): string {
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new BadRequestException('message must be a non-empty string.');
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException(`message must be at most ${MAX_MESSAGE_LENGTH} characters.`);
    }
    return message.trim();
  }

  // History comes from the client, so trust nothing: keep only well-formed turns,
  // clamp their length, and cap how many we forward.
  private sanitizeHistory(history: unknown): ChatTurn[] {
    if (!Array.isArray(history)) {
      return [];
    }
    const clean: ChatTurn[] = [];
    for (const item of history) {
      const role = (item as ChatTurn)?.role;
      const content = (item as ChatTurn)?.content;
      if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
        clean.push({ role, content: content.slice(0, MAX_HISTORY_CONTENT) });
      }
    }
    return clean.slice(-MAX_HISTORY_TURNS);
  }
}
