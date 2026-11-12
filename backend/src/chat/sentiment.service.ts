import { Injectable } from '@nestjs/common';

export type Sentiment = 'positive' | 'neutral' | 'negative';

export interface SentimentResult {
  label: Sentiment;
  // Normalized score in [-1, 1] (negative .. positive).
  score: number;
}

// Hand-tuned lexicons. A lexicon-based analyzer is fast and free (no extra LLM call per message).
const POSITIVE = new Set([
  'good', 'great', 'nice', 'love', 'like', 'awesome', 'amazing', 'cool', 'fun',
  'win', 'winning', 'won', 'best', 'happy', 'glad', 'thanks', 'thank', 'wow',
  'brilliant', 'clever', 'strong', 'gg', 'well', 'yay', 'enjoy', 'enjoyed',
  'excellent', 'perfect', 'fantastic', 'wonderful', 'sweet', 'solid', 'smart',
  'impressive', 'beautiful', 'fair', 'respect', 'nicely', 'congrats', 'ggwp',
]);
const NEGATIVE = new Set([
  'bad', 'hate', 'awful', 'terrible', 'ugly', 'boring', 'lose', 'losing', 'lost',
  'worst', 'sad', 'angry', 'annoying', 'stupid', 'dumb', 'cheat', 'cheater',
  'unfair', 'trash', 'sucks', 'suck', 'weak', 'ugh', 'damn', 'rage',
  'horrible', 'pathetic', 'disgusting', 'noob', 'toxic', 'lame', 'garbage',
  'useless', 'quit', 'tilt', 'tilted', 'salty', 'mad', 'disappointing',
]);
// Words that flip the sentiment of the next token ("not good" -> negative).
const NEGATORS = new Set(['not', 'no', 'never', "don't", 'dont', "didn't", 'didnt', "isn't", 'isnt', "wasn't", 'wasnt']);
// Words that amplify the next sentiment token ("very good" > "good").
const INTENSIFIERS = new Set(['very', 'really', 'so', 'super', 'totally', 'absolutely', 'extremely', 'such']);
const INTENSITY = 1.5;

/* Emoji carry a lot of chat sentiment, and the word tokenizer strips them, so we
score them in a dedicated pass. Single-codepoint emoji only (no variation
selectors) to keep the matching simple and surrogate-safe.*/
const POSITIVE_EMOJI = new Set(['🙂', '😀', '😄', '😁', '😍', '🥰', '😎', '🔥', '👍', '🎉', '💪', '😂']);
const NEGATIVE_EMOJI = new Set(['🙁', '😞', '😡', '😠', '😭', '😢', '👎', '💀', '🤬', '😤', '😒', '😣']);

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
    let multiplier = 1;

    for (const token of tokens) {
      if (NEGATORS.has(token)) {
        negated = true;
        continue;
      }
      if (INTENSIFIERS.has(token)) {
        multiplier = INTENSITY;
        continue;
      }
      let value = 0;
      if (POSITIVE.has(token)) value = 1;
      else if (NEGATIVE.has(token)) value = -1;

      if (value !== 0) {
        score += (negated ? -value : value) * multiplier;
        hits += 1;
      }
      // A negator/intensifier only affects the immediately following sentiment word.
      negated = false;
      multiplier = 1;
    }

    // Emoji pass: the word split above drops them, so count them separately.
    for (const ch of Array.from(text ?? '')) {
      if (POSITIVE_EMOJI.has(ch)) {
        score += 1;
        hits += 1;
      } else if (NEGATIVE_EMOJI.has(ch)) {
        score -= 1;
        hits += 1;
      }
    }

    if (hits === 0) {
      return { label: 'neutral', score: 0 };
    }
    const normalized = Math.max(-1, Math.min(1, score / hits));
    const label: Sentiment = normalized > 0.2 ? 'positive' : normalized < -0.2 ? 'negative' : 'neutral';
    return { label, score: Number(normalized.toFixed(2)) };
  }
}
