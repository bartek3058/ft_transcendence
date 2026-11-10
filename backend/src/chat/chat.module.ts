import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { LlmService } from './llm.service';
import { SentimentService } from './sentiment.service';
import { ModerationService } from './moderation.service';

/*
AI chat: a REST endpoint (POST /api/ai/chat) that talks to an LLM in a chosen
persona (coach/commentator/rival/casual)
*/
@Module({
  imports: [AuthModule],
  controllers: [ChatController],
  providers: [ChatService, LlmService, SentimentService, ModerationService],
  exports: [ChatService],
})
export class ChatModule {}
