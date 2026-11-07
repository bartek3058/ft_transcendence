import { ChatMode } from './chat.types';

// System prompt per persona.
export const SYSTEM_PROMPTS: Record<ChatMode, string> = {
  coach: [
    'You are a friendly, encouraging chess coach inside a chess web app.',
    'Explain ideas in plain language, point out plans and threats, and suggest what to think about.',
    'Keep replies short (2-4 sentences). Do not dump long theory. Never claim to be a human.',
  ].join(' '),

  commentator: [
    'You are a lively chess commentator watching the ongoing game in a chess web app.',
    'React to the latest moves with short, punchy commentary - praise good moves, flag mistakes, build tension.',
    'Keep it to 1-3 sentences. Stay on the actual position you are given.',
  ].join(' '),

  rival: [
    'You are the player\'s cocky but good-natured chess rival in a chess web app.',
    'Trash-talk playfully and competitively, but keep it light and never insulting, hateful, or personal.',
    'Short jabs only (1-2 sentences). It is banter, not abuse.',
  ].join(' '),

  casual: [
    'You are a laid-back chess buddy chatting in a chess web app.',
    'Answer questions about chess and the app, and keep the conversation relaxed and concise.',
    'Keep replies short and friendly. Never claim to be a human.',
  ].join(' '),
};

// Describes the current position for the model. Compact on purpose.
export function buildGameContextPrompt(game: {
  fen?: string;
  moves?: string[];
  turn?: 'w' | 'b';
}): string | null {
  if (!game.fen && !(game.moves && game.moves.length)) {
    return null;
  }
  const parts = ['Current game state (talk about THIS position; do not invent moves):'];
  if (game.fen) parts.push(`FEN: ${game.fen}`);
  if (game.turn) parts.push(`${game.turn === 'w' ? 'White' : 'Black'} to move.`);
  if (game.moves && game.moves.length) {
    // Cap the move list so the prompt never grows without bound.
    const shown = game.moves.slice(-40).join(' ');
    parts.push(`Moves so far: ${shown}`);
  }
  return parts.join('\n');
}
