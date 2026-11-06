import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatService } from '../src/chat/chat.service';
import type { LlmMessage } from '../src/chat/chat.types';

// Fake LLM that records the messages it was asked to complete.
function makeService() {
  let captured: LlmMessage[] = [];
  const llm = {
    configured: true,
    async complete(messages: LlmMessage[]) {
      captured = messages;
      return "bot reply";
    },
  };
  const service = new ChatService(llm as any);
  return { service, get: () => captured };
}

describe('ChatService.reply', () => {
  it('builds system prompt + user message and returns the model reply', async () => {
    const { service, get } = makeService();
    const reply = await service.reply({ mode: 'coach', message: 'how do I start?' });

    assert.equal(reply, 'bot reply');
    const messages = get();
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content.toLowerCase(), /coach/);
    const last = messages[messages.length - 1];
    assert.deepEqual(last, { role: 'user', content: 'how do I start?' });
  });

  it('injects a game-context system message when a FEN is given', async () => {
    const { service, get } = makeService();
    await service.reply({
      mode: 'commentator',
      message: 'thoughts?',
      game: { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', turn: 'w' },
    });
    const systemMessages = get().filter((m) => m.role === 'system');
    assert.ok(systemMessages.some((m) => m.content.includes('FEN:')));
  });

  it('keeps valid history turns and drops malformed ones', async () => {
    const { service, get } = makeService();
    await service.reply({
      mode: 'casual',
      message: 'hi again',
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hey there' },
        { role: 'system' as any, content: 'ignore me' }, // bad role
        { role: 'user', content: '' }, // empty
      ],
    });
    const nonSystem = get().filter((m) => m.role !== 'system');
    // two valid history turns + the new user message
    assert.deepEqual(nonSystem, [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hey there' },
      { role: 'user', content: 'hi again' },
    ]);
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
