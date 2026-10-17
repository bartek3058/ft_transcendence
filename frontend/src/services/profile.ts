export type ProfileOutcome = "WIN" | "DRAW" | "LOSS";

export interface ProfileData {
  user: {
    id: string;
    email: string;
    username: string;
    rating: number;
    status: string;
    createdAt: string;
  };
  stats: { games: number; wins: number; draws: number; losses: number };
  recentGames: Array<{
    id: string;
    opponent: string;
    color: "WHITE" | "BLACK";
    outcome: ProfileOutcome;
    result: string;
    timeControl: string | null;
    ratingChange: number | null;
    playedAt: string;
  }>;
}

export async function getMyProfile(): Promise<ProfileData> {
  const response = await fetch("/api/profile/me", {
    credentials: "same-origin",
  });
  if (!response.ok) {
    let message = `Błąd serwera (${response.status})`;
    try {
      message = (await response.json())?.error?.message ?? message;
    } catch {
      /* non-json */
    }
    throw new Error(message);
  }
  return response.json() as Promise<ProfileData>;
}
