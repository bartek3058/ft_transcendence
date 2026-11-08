import { Injectable } from '@nestjs/common';

export type Sentiment = 'positive' | 'neutral' | 'negative';

export interface SentimentResult {
  label: Sentiment;
  // Normalized score in [-1, 1] (negative .. positive).
  score: number;
}

// Small, hand-tuned lexicons. A lexicon-based analyzer is deliberate: it is fast,
// free (no extra LLM call per message), deterministic, and easy to explain at
// evaluation. Extend the word lists to improve coverage.
const POSITIVE = new Set([
  'good', 'great', 'nice', 'love', 'like', 'awesome', 'amazing', 'cool', 'fun',
  'win', 'winning', 'won', 'best', 'happy', 'glad', 'thanks', 'thank', 'wow',
  'brilliant', 'clever', 'strong', 'gg', 'well', 'yay', 'enjoy', 'enjoyed',
]);
const NEGATIVE = new Set([
  'bad', 'hate', 'awful', 'terrible', 'ugly', 'boring', 'lose', 'losing', 'lost',
  'worst', 'sad', 'angry', 'annoying', 'stupid', 'dumb', 'cheat', 'cheater',
  'unfair', 'trash', 'sucks', 'suck', 'weak', 'ugh', 'damn', 'rage',
]);
// Words that flip the sentiment of the next token ("not good" -> negative).
const NEGATORS = new Set(['not', 'no', 'never', "don't", 'dont', "didn't", 'didnt', "isn't", 'isnt']);

@Injectable()
export class SentimentService {
  analyze(text: string): SentimentResult {
    const tokens = (text ?? '')
      .toLowerCase()
      .split(/[^a-z']+/)
      .filter(Boolean);

    let score = 0;
    let hits = 0;
    let negated = false;

    for (const token of tokens) {
      if (NEGATORS.has(token)) {
        negated = true;
        continue;
      }
      let value = 0;
      if (POSITIVE.has(token)) value = 1;
      else if (NEGATIVE.has(token)) value = -1;

      if (value !== 0) {
        score += negated ? -value : value;
        hits += 1;
      }
      // A negator only affects the immediately following word.
      negated = false;
    }

    if (hits === 0) {
      return { label: 'neutral', score: 0 };
    }
    const normalized = Math.max(-1, Math.min(1, score / hits));
    const label: Sentiment = normalized > 0.2 ? 'positive' : normalized < -0.2 ? 'negative' : 'neutral';
    return { label, score: Number(normalized.toFixed(2)) };
  }
}
