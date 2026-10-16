export type Tab = 'gra' | 'turnieje' | 'ranking' | 'historia';
export type ChatMessage = { id: string; user: string; text: string };
export type GameHistoryItem = { white: string; black: string; result: string; mode: string; elo: string };
export type Tournament = { name: string; mode: string; players: string; startsAt: string };
