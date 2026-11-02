import { useEffect, useState } from "react";
import { BarChart3, Swords, Trophy } from "lucide-react";
import { Page } from "../components/ui/Page";
import { getMyProfile, type ProfileData } from "../services/profile";

export function HistoryPage() {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getMyProfile()
      .then((data) => {
        if (active) {
          setProfile(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(
            err instanceof Error ? err.message : "Failed to load game history.",
          );
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const stats = profile?.stats;
  const user = profile?.user;
  const recentGames = profile?.recentGames ?? [];
  const winRate = stats?.games
    ? Math.round((stats.wins / stats.games) * 100)
    : 0;

  return (
    <Page title="Game History" sub="Your recent results and rating changes.">
      <div className="stats">
        <div className="card">
          <BarChart3 />
          <b>{loading ? "…" : (user?.rating ?? 1500)}</b>
          <small>Current ELO</small>
        </div>
        <div className="card">
          <Swords />
          <b>{loading ? "…" : `${winRate}%`}</b>
          <small>Wins</small>
        </div>
        <div className="card">
          <Trophy />
          <b>{loading ? "…" : (stats?.games ?? 0)}</b>
          <small>Games</small>
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
      ) : recentGames.length === 0 ? (
        <div className="card table">
          <p style={{ padding: "1rem" }}>No games played yet.</p>
        </div>
      ) : (
        <div className="card table games">
          {recentGames.map((g) => {
            const opponent = g.opponent;
            const vsText =
              g.color === "WHITE"
                ? `${user?.username ?? "You"} vs ${opponent}`
                : `${opponent} vs ${user?.username ?? "You"}`;
            const ratingDelta =
              g.ratingChange != null
                ? `${g.ratingChange >= 0 ? "+" : ""}${g.ratingChange} ELO`
                : "—";
            const isLoss = g.ratingChange != null && g.ratingChange < 0;

            return (
              <div key={g.id}>
                <b>{vsText}</b>
                <small>{g.timeControl ?? "Standard"}</small>
                <strong>{g.result || g.outcome}</strong>
                <em className={isLoss ? "loss" : "win"}>{ratingDelta}</em>
              </div>
            );
          })}
        </div>
      )}
    </Page>
  );
}
