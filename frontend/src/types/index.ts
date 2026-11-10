export type Tab = "Game" | "Tournaments" | "Ranking" | "History";
export type Sentiment = "positive" | "neutral" | "negative";
export type ChatMessage = {
  id: string;
  user: string;
  text: string;
  sentiment?: Sentiment;
  // Set on an AI bubble when the request failed, so the UI can offer a retry.
  error?: boolean;
};
export type GameHistoryItem = {
  white: string;
  black: string;
  result: string;
  mode: string;
  elo: string;
};
export type Tournament = {
  name: string;
  mode: string;
  players: string;
  startsAt: string;
};
