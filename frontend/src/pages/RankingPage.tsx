import { useEffect, useState } from "react";
import { Page } from "../components/ui/Page";
import { getLeaderboard, type LeaderboardEntry } from "../services/leaderboard";

export function RankingPage() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getLeaderboard(50, 0)
      .then((data) => {
        if (active) {
          setEntries(data.entries ?? []);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(
            err instanceof Error ? err.message : "Failed to load ranking.",
          );
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <Page title="ELO Ranking" sub="The best players on the platform.">
      {error ? (
        <div className="card table">
          <p style={{ padding: "1rem", color: "var(--color-danger, #e53935)" }}>
            {error}
          </p>
        </div>
      ) : loading ? (
        <div className="card table">
          <p style={{ padding: "1rem" }}>Loading leaderboard…</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="card table">
          <p style={{ padding: "1rem" }}>No ranked players yet.</p>
        </div>
      ) : (
        <div className="card table">
          {entries.map((entry) => (
            <div key={entry.id || entry.username}>
              <strong>#{entry.rank}</strong>
              <span className="avatar small">
                {entry.username[0]?.toUpperCase()}
              </span>
              <b>{entry.username}</b>
              <em>{entry.rating}</em>
            </div>
          ))}
        </div>
      )}
    </Page>
  );
}
