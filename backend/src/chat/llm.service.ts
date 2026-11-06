import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { LlmMessage } from './chat.types';

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor() {
    this.baseUrl = (process.env.LLM_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = process.env.LLM_API_KEY?.trim() || '';
    this.model = process.env.LLM_MODEL?.trim() || 'gpt-4o-mini';
    this.timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 20_000;

    if (!this.apiKey) {
      this.logger.warn('LLM_API_KEY is not set - the AI chat will return a configuration error until it is.');
    }
  }

  get configured(): boolean {
    return this.apiKey.length > 0;
  }

  async complete(messages: LlmMessage[]): Promise<string> {
    if (!this.configured) {
      throw new ServiceUnavailableException('AI chat is not configured. Set LLM_API_KEY on the backend.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.8,
          max_tokens: 300,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        this.logger.error(`LLM request failed: ${response.status} ${response.statusText} ${detail.slice(0, 300)}`);
        throw new ServiceUnavailableException('The AI chat service is temporarily unavailable.');
      }

      const data = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        this.logger.error('LLM response contained no message content.');
        throw new ServiceUnavailableException('The AI chat service returned an empty response.');
      }
      return content.trim();
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      if ((error as Error).name === 'AbortError') {
        this.logger.error(`LLM request timed out after ${this.timeoutMs}ms.`);
        throw new ServiceUnavailableException('The AI chat service timed out.');
      }
      this.logger.error(`LLM request error: ${(error as Error).message}`);
      throw new ServiceUnavailableException('The AI chat service is temporarily unavailable.');
    } finally {
      clearTimeout(timer);
    }
  }
}
