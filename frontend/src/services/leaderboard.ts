export interface LeaderboardEntry {
  rank: number;
  id: string;
  username: string;
  rating: number;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
}

export async function getLeaderboard(
  limit = 20,
  offset = 0,
): Promise<LeaderboardResponse> {
  const params = new URLSearchParams();
  if (limit) params.set("limit", limit.toString());
  if (offset) params.set("offset", offset.toString());

  const response = await fetch(`/api/leaderboard?${params.toString()}`, {
    credentials: "same-origin",
  });

  if (!response.ok) {
    let message = `Server error (${response.status})`;
    try {
      message = (await response.json())?.error?.message ?? message;
    } catch {}
    throw new Error(message);
  }

  return response.json() as Promise<LeaderboardResponse>;
}

export interface CreateTournamentInput {
  title: string;
  description?: string;
  maxParticipants: 2 | 4 | 8 | 16 | 32;
  registrationDeadline: string;
}
