import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from './llm.service';

export interface ModerationResult {
  allowed: boolean;
  reason: string | null;
}

const MODERATION_PROMPT = [
  'You are a strict content-moderation classifier for the chat of a chess web app.',
  'Flag a message only if it is hateful, harassing, threatening, sexually explicit, or abusive.',
  'Ordinary chess talk and light, friendly trash-talk are NOT flagged.',
  'Reply with ONLY compact JSON and nothing else: {"flagged": true|false, "reason": "short reason or empty"}.',
].join(' ');

/**
 * AI content moderation. Runs each user chat message through the LLM classifier
 * before it reaches the chat model, so abusive content is blocked (and the user
 * warned) instead of being processed or shown.
 *
 * Fails open: if the LLM is unconfigured or errors, the message is allowed (a
 * moderation hiccup should never silently swallow normal chat). Failures are logged.
 */
@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(private readonly llm: LlmService) {}

  async check(text: string): Promise<ModerationResult> {
    if (!this.llm.configured) {
      return { allowed: true, reason: null };
    }
    try {
      const raw = await this.llm.complete([
        { role: 'system', content: MODERATION_PROMPT },
        { role: 'user', content: text },
      ]);
      const parsed = extractJson(raw);
      if (parsed && typeof parsed.flagged === 'boolean') {
        return {
          allowed: !parsed.flagged,
          reason: parsed.flagged ? (toReason(parsed.reason) ?? 'inappropriate content') : null,
        };
      }
      this.logger.warn(`Moderation returned an unparseable response; allowing by default.`);
    } catch (error) {
      this.logger.error(`Moderation check failed (allowing by default): ${(error as Error).message}`);
    }
    return { allowed: true, reason: null };
  }
}

// Parses a JSON object out of the model's reply, tolerating stray text/code fences.
function extractJson(raw: string): { flagged?: unknown; reason?: unknown } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function toReason(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;
}
