import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { LlmMessage } from './chat.types';

/* Transient upstream failures worth retrying. 429 = rate limited, 5xx = the
provider having a bad moment (Gemini loves to throw 503 "high demand"). */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor() {
    this.baseUrl = (process.env.LLM_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = process.env.LLM_API_KEY?.trim() || '';
    this.model = process.env.LLM_MODEL?.trim() || 'gpt-4o-mini';
    this.timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 20_000;
    // Extra attempts after the first one, so 2 => up to 3 tries total.
    this.maxRetries = Math.max(0, Number(process.env.LLM_MAX_RETRIES ?? 2));
    this.retryBaseMs = Math.max(0, Number(process.env.LLM_RETRY_BASE_MS ?? 400));

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

    let lastError: ServiceUnavailableException | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.attempt(messages);
      } catch (error) {
        /* Only transient failures are retryable; a bad request/auth error
        (or an empty reply) is final, so we rethrow those straight away.*/
        if (!(error instanceof RetryableLlmError)) {
          throw error instanceof ServiceUnavailableException
            ? error
            : new ServiceUnavailableException('The AI chat service is temporarily unavailable.');
        }

        lastError = error.asServiceUnavailable();
        if (attempt < this.maxRetries) {
          const delay = this.backoffDelay(attempt, error.retryAfterMs);
          this.logger.warn(
            `LLM attempt ${attempt + 1}/${this.maxRetries + 1} failed (${error.reason}); retrying in ${delay}ms.`,
          );
          await sleep(delay);
        }
      }
    }

    // Ran out of attempts - surface the last transient failure.
    throw lastError ?? new ServiceUnavailableException('The AI chat service is temporarily unavailable.');
  }

  private async attempt(messages: LlmMessage[]): Promise<string> {
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
          /* Headroom for a fuller answer; the brevity prompt keeps most replies
          well under this, and tidyTruncated cleans up the rare overshoot.*/
          max_tokens: 500,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        this.logger.error(`LLM request failed: ${response.status} ${response.statusText} ${detail.slice(0, 300)}`);
        if (RETRYABLE_STATUSES.has(response.status)) {
          throw new RetryableLlmError(`${response.status} ${response.statusText}`, parseRetryAfter(response));
        }
        throw new ServiceUnavailableException('The AI chat service is temporarily unavailable.');
      }

      const data = (await response.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
      };
      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        this.logger.error('LLM response contained no message content.');
        throw new ServiceUnavailableException('The AI chat service returned an empty response.');
      }
      const trimmed = content.trim();
      /* The token cap can cut the reply off mid-flow. OpenAI signals this with
      finish_reason "length", but gateways vary (Gemini's OpenAI endpoint sends
      "MAX_TOKENS"), so match loosely - and log whatever we actually got, so a
      future surprise value is visible instead of silently slipping through. */
      const finish = choice?.finish_reason;
      if (finish && finish !== 'stop') {
        this.logger.warn(`LLM reply did not end naturally (finish_reason=${finish}).`);
      }
      if (typeof finish === 'string' && /length|max.?token/i.test(finish)) {
        return tidyTruncated(trimmed);
      }
      return trimmed;
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof RetryableLlmError) {
        throw error;
      }
      // A network blip is transient (retried below); a timeout is not.
      if ((error as Error).name === 'AbortError') {
        /* A timeout already waited the full budget, so don't retry it - that
        would just stack another full wait on something that's clearly stuck.*/
        this.logger.error(`LLM request timed out after ${this.timeoutMs}ms.`);
        throw new ServiceUnavailableException('The AI chat service timed out.');
      }
      this.logger.error(`LLM request error: ${(error as Error).message}`);
      throw new RetryableLlmError(`network: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private backoffDelay(attempt: number, retryAfterMs?: number): number {
    const exponential = this.retryBaseMs * 2 ** attempt;
    const jitter = Math.random() * this.retryBaseMs;
    return Math.max(retryAfterMs ?? 0, Math.round(exponential + jitter));
  }
}

class RetryableLlmError extends Error {
  constructor(
    readonly reason: string,
    readonly retryAfterMs?: number,
  ) {
    super(reason);
    this.name = 'RetryableLlmError';
  }

  asServiceUnavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException('The AI chat service is temporarily unavailable.');
  }
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  // Retry-After is either seconds or an HTTP date.
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tidyTruncated(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  const isOrphan = (line: string): boolean => {
    const t = line.trim();
    return t === '' || /^#{1,6}\s/.test(t) || /^[-*_]{3,}$/.test(t);
  };
  while (lines.length > 1 && isOrphan(lines[lines.length - 1])) lines.pop();

  const out = lines.join('\n').trimEnd();

  if (/[.!?]["'”’)\]]?$/.test(out)) return out;

  // Otherwise it ends mid-sentence - cut back to the last real sentence end.
  const sentenceEnd = /(?<![0-9])[.!?]["'”’)\]]?/g;
  let lastEnd = -1;
  for (const m of out.matchAll(sentenceEnd)) {
    const end = m.index + m[0].length;
    if (end >= out.length || /\s/.test(out[end])) lastEnd = end;
  }
  if (lastEnd > 0) {
    const kept = out.slice(0, lastEnd).trim();
    if (kept) return kept;
  }
  return `${out}…`;
}
