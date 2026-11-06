export type ProfileOutcome = "WIN" | "DRAW" | "LOSS";

export interface HistoryGame {
  id: string;
  opponent: string;
  color: "WHITE" | "BLACK";
  outcome: ProfileOutcome;
  result: string;
  timeControl: string | null;
  ratingChange: number | null;
  playedAt: string;
}

export interface ProfileData {
  user: {
    id: string;
    email: string;
    username: string;
    rating: number;
    status: string;
    createdAt: string;
    rank?: number;
  };
  stats: {
    games: number;
    wins: number;
    draws: number;
    losses: number;
    winRate?: number;
    rank?: number;
  };
  recentGames: HistoryGame[];
}

export interface GameHistoryPage {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  items: HistoryGame[];
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    let message = `Server error (${response.status})`;
    try {
      message = (await response.json())?.error?.message ?? message;
    } catch {
      /* non-json */
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function getMyProfile(): Promise<ProfileData> {
  return getJson<ProfileData>("/api/profile/me");
}

export function getMyGames(page = 1, limit = 20): Promise<GameHistoryPage> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });
  return getJson<GameHistoryPage>(`/api/profile/me/games?${params.toString()}`);
}
