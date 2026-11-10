import { Settings2, ChevronDown } from "lucide-react";
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
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../context/AuthContext";
import { updateUsername, changePassword } from "../services/auth";
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

  const { refresh } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [usernameMessage, setUsernameMessage] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [usernameError, setUsernameError] = useState(false);
  const [passwordError, setPasswordError] = useState(false);

  async function handleUsernameSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = username.trim();

    if (!/^[A-Za-z0-9_]{3,20}$/.test(normalized)) {
      setUsernameError(true);
      setUsernameMessage("Username must contain 3–20 letters, numbers or underscores.");
      return;
    }

    setUsernameSaving(true);
    setUsernameMessage("");
    try {
      await updateUsername(normalized);
      setProfile((previous) =>
        previous
          ? { ...previous, user: { ...previous.user, username: normalized } }
          : previous,
      );
      setUsername("");
      setUsernameError(false);
      setUsernameMessage("Username updated successfully.");
      try {
        await refresh();
        setProfile(await getMyProfile());
      } catch {
        setUsernameMessage("Username saved. Refresh the page to update all account details.");
      }
    } catch (error) {
      setUsernameError(true);
      setUsernameMessage(
        error instanceof Error ? error.message : "Failed to update username.",
      );
    } finally {
      setUsernameSaving(false);
    }
  }

  async function handlePasswordSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (newPassword !== confirmPassword) {
      setPasswordError(true);
      setPasswordMessage("Passwords do not match.");
      return;
    }

    const length = [...newPassword].length;
    if (
      length < 15 ||
      length > 128 ||
      new TextEncoder().encode(newPassword).length > 512
    ) {
      setPasswordError(true);
      setPasswordMessage("Password must contain 15–128 characters (max 512 bytes).");
      return;
    }

    setPasswordSaving(true);
    setPasswordMessage("");
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordError(false);
      setPasswordMessage("Password changed successfully.");
    } catch (error) {
      setPasswordError(true);
      setPasswordMessage(
        error instanceof Error ? error.message : "Failed to change password.",
      );
    } finally {
      setPasswordSaving(false);
    }
  }


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


      <section className={`profileAccountAccordion card${settingsOpen ? " isOpen" : ""}`}>
        <button
          type="button"
          className="profileAccountToggle"
          aria-expanded={settingsOpen}
          aria-controls="profileAccountContent"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <span className="profileAccountToggleIcon">
            <Settings2 size={20} />
          </span>
          <span className="profileAccountToggleText">
            <strong>Account settings</strong>
            <small>Manage your username and password</small>
          </span>
          <ChevronDown size={20} className="profileAccountChevron" />
        </button>
        <div
          id="profileAccountContent"
          className="profileAccountContent"
          {...(!settingsOpen ? { inert: "" } : {})}
        >
          <div className="profileAccountContentInner">


        <form onSubmit={handleUsernameSave} className="profileSettingsForm">
          <h3>Change username</h3>
          <p>Current username: {user.username}</p>
          <label htmlFor="newUsername">New username</label>
          <input
            id="newUsername"
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Enter new username"
            minLength={3}
            maxLength={20}
            pattern="[A-Za-z0-9_]{3,20}"
            autoComplete="username"
            required
            disabled={usernameSaving}
          />
          <small>3–20 characters: letters, numbers and underscores.</small>
          {usernameMessage && (
            <p className={usernameError ? "profileSettingsError" : "profileSettingsSuccess"} role="status">
              {usernameMessage}
            </p>
          )}
          <button type="submit" disabled={usernameSaving}>
            {usernameSaving ? "Saving..." : "Save username"}
          </button>
        </form>

        <form onSubmit={handlePasswordSave} className="profileSettingsForm">
          <h3>Change password</h3>
          <label htmlFor="currentPassword">Current password</label>
          <input
            id="currentPassword"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
            disabled={passwordSaving}
          />
          <label htmlFor="newPassword">New password</label>
          <input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            minLength={15}
            required
            disabled={passwordSaving}
          />
          <label htmlFor="confirmPassword">Confirm new password</label>
          <input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
            disabled={passwordSaving}
          />
          <small>Minimum 15 characters.</small>
          {passwordMessage && (
            <p className={passwordError ? "profileSettingsError" : "profileSettingsSuccess"} role="status">
              {passwordMessage}
            </p>
          )}
          <button type="submit" disabled={passwordSaving}>
            {passwordSaving ? "Updating..." : "Change password"}
          </button>
        </form>
          </div>
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
