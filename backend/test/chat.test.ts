import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatService } from '../src/chat/chat.service';
import { SentimentService } from '../src/chat/sentiment.service';
import { ModerationService } from '../src/chat/moderation.service';
import type { LlmMessage } from '../src/chat/chat.types';

// Fake LLM. `completeImpl` lets a test control what each call returns (the first
// call is moderation, the second is the chat reply). Default: a plain reply,
// which moderation treats as "not JSON" -> allow.
function makeService(completeImpl?: (messages: LlmMessage[]) => string) {
  const calls: LlmMessage[][] = [];
  const llm = {
    configured: true,
    async complete(messages: LlmMessage[]) {
      calls.push(messages);
      return completeImpl ? completeImpl(messages) : 'bot reply';
    },
  };
  const service = new ChatService(
    llm as any,
    new SentimentService(),
    new ModerationService(llm as any),
  );
  return { service, calls, last: () => calls[calls.length - 1] };
}

describe('ChatService.reply', () => {
  it('builds system prompt + user message and returns the model reply', async () => {
    const { service, last } = makeService();
    const result = await service.reply({ mode: 'coach', message: 'how do I start?' });

    assert.equal(result.reply, 'bot reply');
    assert.equal(result.blocked, false);
    const messages = last();
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content.toLowerCase(), /coach/);
    assert.deepEqual(messages[messages.length - 1], { role: 'user', content: 'how do I start?' });
  });

  it('injects a game-context system message when a FEN is given', async () => {
    const { service, last } = makeService();
    await service.reply({
      mode: 'commentator',
      message: 'thoughts?',
      game: { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', turn: 'w' },
    });
    const systemMessages = last().filter((m) => m.role === 'system');
    assert.ok(systemMessages.some((m) => m.content.includes('FEN:')));
  });

  it('keeps valid history turns and drops malformed ones', async () => {
    const { service, last } = makeService();
    await service.reply({
      mode: 'casual',
      message: 'hi again',
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hey there' },
        { role: 'system' as any, content: 'ignore me' },
        { role: 'user', content: '' },
      ],
    });
    const nonSystem = last().filter((m) => m.role !== 'system');
    assert.deepEqual(nonSystem, [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hey there' },
      { role: 'user', content: 'hi again' },
    ]);
  });

  it('attaches the sentiment of the user message', async () => {
    const { service } = makeService();
    const result = await service.reply({ mode: 'casual', message: 'I love this game, so fun' });
    assert.equal(result.sentiment.label, 'positive');
  });

  it('blocks a message flagged by moderation (never calls the chat model)', async () => {
    // The first (moderation) call returns a "flagged" verdict.
    const { service, calls } = makeService(() => '{"flagged": true, "reason": "harassment"}');
    const result = await service.reply({ mode: 'rival', message: 'something nasty' });

    assert.equal(result.blocked, true);
    assert.match(result.reply, /blocked/i);
    assert.equal(calls.length, 1); // only moderation ran, not the chat reply
  });

  it('rejects an unknown mode', async () => {
    const { service } = makeService();
    await assert.rejects(service.reply({ mode: 'evil' as any, message: 'hi' }));
  });

  it('rejects an empty message', async () => {
    const { service } = makeService();
    await assert.rejects(service.reply({ mode: 'coach', message: '   ' }));
  });
});

describe('SentimentService (lexicon)', () => {
  const s = new SentimentService();

  it('detects positive text', () => {
    assert.equal(s.analyze('this is great, I really love it').label, 'positive');
  });

  it('detects negative text', () => {
    assert.equal(s.analyze('this is terrible and boring, I hate it').label, 'negative');
  });

  it('returns neutral for a plain chess sentence', () => {
    assert.equal(s.analyze('the knight moves to f3').label, 'neutral');
  });

  it('handles negation ("not good" -> negative)', () => {
    assert.equal(s.analyze('not good').label, 'negative');
  });
});

describe('ModerationService', () => {
  function makeModeration(completeImpl: () => string, configured = true) {
    const llm = { configured, async complete() { return completeImpl(); } };
    return new ModerationService(llm as any);
  }

  it('allows a clean message', async () => {
    const mod = makeModeration(() => '{"flagged": false, "reason": ""}');
    assert.deepEqual(await mod.check('good game!'), { allowed: true, reason: null });
  });

  it('blocks a flagged message with a reason', async () => {
    const mod = makeModeration(() => '{"flagged": true, "reason": "hate speech"}');
    const result = await mod.check('...');
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'hate speech');
  });

  it('fails open when the LLM is not configured', async () => {
    const mod = makeModeration(() => 'unused', false);
    assert.deepEqual(await mod.check('anything'), { allowed: true, reason: null });
  });

  it('fails open on an unparseable response', async () => {
    const mod = makeModeration(() => 'I cannot do that');
    assert.deepEqual(await mod.check('anything'), { allowed: true, reason: null });
  });
});
