import { useEffect, useState } from "react";
import { BarChart3, Swords, Trophy } from "lucide-react";
import { Page } from "../components/ui/Page";
import {
  getMyGames,
  getMyProfile,
  type HistoryGame,
  type ProfileData,
  type ProfileOutcome,
} from "../services/profile";

const PAGE_SIZE = 20;

const OUTCOME_LABEL: Record<ProfileOutcome, string> = {
  WIN: "Win",
  LOSS: "Loss",
  DRAW: "Draw",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDelta(change: number | null) {
  if (change == null) return "—";
  return `${change > 0 ? "+" : ""}${change} ELO`;
}

function errorText(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

export function HistoryPage() {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [games, setGames] = useState<HistoryGame[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([getMyProfile(), getMyGames(1, PAGE_SIZE)])
      .then(([profileData, history]) => {
        if (!active) return;
        setProfile(profileData);
        setGames(history.items);
        setPage(history.page);
        setTotalPages(history.totalPages);
      })
      .catch((err) => {
        if (active) setError(errorText(err, "Failed to load game history."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const loadMore = () => {
    setLoadingMore(true);
    getMyGames(page + 1, PAGE_SIZE)
      .then((history) => {
        // De-duplicate in case a game finished between page loads.
        setGames((prev) => {
          const seen = new Set(prev.map((g) => g.id));
          return [...prev, ...history.items.filter((g) => !seen.has(g.id))];
        });
        setPage(history.page);
        setTotalPages(history.totalPages);
      })
      .catch((err) => setError(errorText(err, "Failed to load more games.")))
      .finally(() => setLoadingMore(false));
  };

  const stats = profile?.stats;
  const user = profile?.user;
  const username = user?.username ?? "You";

  return (
    <Page title="Game History" sub="Your results, opponents and rating changes.">
      <div className="stats">
        <div className="card">
          <BarChart3 />
          <b>{loading ? "…" : (user?.rating ?? "—")}</b>
          <small>Current ELO{user?.rank ? ` · #${user.rank}` : ""}</small>
        </div>
        <div className="card">
          <Swords />
          <b>{loading ? "…" : `${stats?.winRate ?? 0}%`}</b>
          <small>Wins</small>
        </div>
        <div className="card">
          <Trophy />
          <b>{loading ? "…" : (stats?.games ?? 0)}</b>
          <small>
            Games{stats ? ` · ${stats.wins}W ${stats.draws}D ${stats.losses}L` : ""}
          </small>
        </div>
      </div>
      {error ? (
        <div className="card table">
          <p style={{ padding: "1rem", color: "var(--color-danger, #e53935)" }}>
            {error}
          </p>
        </div>
      ) : loading ? (
        <div className="card table">
          <p style={{ padding: "1rem" }}>Loading history…</p>
        </div>
      ) : games.length === 0 ? (
        <div className="card table">
          <p style={{ padding: "1rem" }}>No games played yet.</p>
        </div>
      ) : (
        <>
          <div className="card table games">
            {games.map((g) => (
              <div key={g.id}>
                <b>
                  {g.color === "WHITE"
                    ? `${username} vs ${g.opponent}`
                    : `${g.opponent} vs ${username}`}
                </b>
                <small>
                  {formatDate(g.playedAt)} · {g.timeControl ?? "Standard"}
                </small>
                <strong>{OUTCOME_LABEL[g.outcome]}</strong>
                <em
                  className={
                    g.ratingChange != null && g.ratingChange < 0 ? "loss" : "win"
                  }
                >
                  {formatDelta(g.ratingChange)}
                </em>
              </div>
            ))}
          </div>
          {page < totalPages && (
            <button
              className="primary"
              onClick={loadMore}
              disabled={loadingMore}
              style={{ marginTop: "1rem" }}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </Page>
  );
}
