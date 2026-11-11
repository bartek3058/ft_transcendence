import { useEffect, useState } from "react";
import { friendsApi, type Friend } from "../../services/friends";
import { inviteToTournament } from "../../services/tournaments";

interface Props {
  tournamentId: string;
}

export function TournamentInviteFriends({ tournamentId }: Props) {
  const [open, setOpen] = useState(false);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError("");

    async function load() {
      try {
        const all: Friend[] = [];
        let offset = 0;

        for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
          const page = await friendsApi.friends(offset);
          all.push(...page.items);
          if (!page.hasMore) break;
          offset += page.limit;
        }

        if (active) setFriends(all);
      } catch (cause) {
        if (active) {
          setError(
            cause instanceof Error ? cause.message : "Unable to load friends",
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [open]);

  async function send() {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    setMessage("");

    try {
      await inviteToTournament(tournamentId, selected);
      setMessage("Tournament invitation sent.");
      setSelected("");
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Unable to send invitation";

      setError(
        /409/.test(message)
          ? "This player is already participating or has a pending invitation."
          : message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tournament-invite-friends">
      <button
        type="button"
        className="tournament-secondary"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Close invitations" : "Invite player"}
      </button>

      {open && (
        <div className="tournament-invite-form">
          <label htmlFor={`invite-friend-${tournamentId}`}>
            Select a friend
          </label>
          {loading ? (
            <p>Loading friends...</p>
          ) : (
            <select
              id={`invite-friend-${tournamentId}`}
              value={selected}
              disabled={busy}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">Choose a friend</option>
              {friends.map((friend) => (
                <option key={friend.user.id} value={friend.user.id}>
                  {friend.user.username}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            className="primary"
            disabled={!selected || busy || loading}
            onClick={() => void send()}
          >
            {busy ? "Sending..." : "Send invitation"}
          </button>

          {!loading && friends.length === 0 && (
            <p>No friends available. Add friends first.</p>
          )}
          {error && <p role="alert">{error}</p>}
          {message && <p role="status">{message}</p>}
        </div>
      )}
    </div>
  );
}
