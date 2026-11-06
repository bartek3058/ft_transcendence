export type ChatMode = 'coach' | 'commentator' | 'rival' | 'casual';

export const CHAT_MODES: readonly ChatMode[] = ['coach', 'commentator', 'rival', 'casual'];

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatGameContext {
  fen?: string;
  moves?: string[];
  turn?: 'w' | 'b';
}

export interface ChatRequest {
  mode: ChatMode;
  message: string;
  history?: ChatTurn[];
  game?: ChatGameContext;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
