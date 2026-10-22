import {
  CalendarDays,
  CircleUserRound,
  Crown,
  Gamepad2,
  Mail,
  Minus,
  Trophy,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { getMyProfile, type ProfileData } from "../services/profile";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

function signed(value: number | null) {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${value}`;
}

export function ProfilePage() {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getMyProfile()
      .then((data) => active && setProfile(data))
      .catch(
        (err) =>
          active &&
          setError(
            err instanceof Error ? err.message : "Failed to load profile.",
          ),
      );
    return () => {
      active = false;
    };
  }, []);

  if (error)
    return (
      <div className="profilePage">
        <div className="profileState error">{error}</div>
      </div>
    );
  if (!profile)
    return (
      <div className="profilePage">
        <div className="profileState">Loading profile…</div>
      </div>
    );

  const { user, stats, recentGames } = profile;
  const winRate = stats.games
    ? Math.round((stats.wins / stats.games) * 100)
    : 0;

  return (
    <div className="profilePage">
      <section className="profileHero card">
        <div className="profileAvatar">
          {user.username.slice(0, 1).toUpperCase()}
        </div>
        <div className="profileIdentity">
          <span className="profileOnline">
            <i />
            {user.status === "offline" ? "Logged in" : user.status}
          </span>
          <h1>{user.username}</h1>
          <div className="profileMeta">
            <span>
              <Mail size={15} />
              {user.email}
            </span>
            <span>
              <CalendarDays size={15} />
              Joined {formatDate(user.createdAt)}
            </span>
          </div>
        </div>
        <div className="profileRating">
          <Crown size={22} />
          <strong>{user.rating}</strong>
          <span>ELO</span>
        </div>
      </section>

      <section className="profileStats">
        <div className="card">
          <Gamepad2 />
          <strong>{stats.games}</strong>
          <span>Games</span>
        </div>
        <div className="card winStat">
          <Trophy />
          <strong>{stats.wins}</strong>
          <span>Wins</span>
        </div>
        <div className="card">
          <Minus />
          <strong>{stats.draws}</strong>
          <span>Draws</span>
        </div>
        <div className="card lossStat">
          <X />
          <strong>{stats.losses}</strong>
          <span>Losses</span>
        </div>
        <div className="card">
          <CircleUserRound />
          <strong>{winRate}%</strong>
          <span>Win rate</span>
        </div>
      </section>

      <section className="profileHistory card">
        <div className="profileSectionTitle">
          <div>
            <h2>Recent games</h2>
            <p>Results saved in the database</p>
          </div>
          <span>{recentGames.length}</span>
        </div>
        {recentGames.length === 0 ? (
          <div className="profileEmpty">
            <Gamepad2 size={32} />
            <b>No games played yet</b>
            <span>
              Your game history will appear here after you finish your first
              online game.
            </span>
          </div>
        ) : (
          <div className="profileGameList">
            {recentGames.map((game) => (
              <div className="profileGame" key={game.id}>
                <span className={`outcome ${game.outcome.toLowerCase()}`}>
                  {game.outcome === "WIN"
                    ? "W"
                    : game.outcome === "DRAW"
                      ? "D"
                      : "L"}
                </span>
                <div>
                  <b>vs {game.opponent}</b>
                  <small>
                    {game.color === "WHITE" ? "White" : "Black"} ·{" "}
                    {game.timeControl ?? "No time control"} ·{" "}
                    {formatDate(game.playedAt)}
                  </small>
                </div>
                <strong
                  className={
                    game.ratingChange != null && game.ratingChange < 0
                      ? "negative"
                      : "positive"
                  }
                >
                  {signed(game.ratingChange)} ELO
                </strong>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
