import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTournamentInvitationsRealtime } from "../../hooks/useTournamentInvitationsRealtime";
import {
  listMyTournamentInvitations,
  respondToTournamentInvitation,
  type TournamentInvitation,
} from "../../services/tournaments";

const formatDate = (value: string) => new Date(value).toLocaleString();

export function TournamentInvitations() {
  const [items, setItems] = useState<TournamentInvitation[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const refresh = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const page = await listMyTournamentInvitations(offset);
        setItems(page.items);
        setTotal(page.total);
        setLimit(page.limit);
        setError("");
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Unable to load invitations",
        );
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [offset],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useTournamentInvitationsRealtime(
    useCallback(() => {
      void refresh(true);
    }, [refresh]),
  );

  async function respond(id: string, response: "ACCEPT" | "DECLINE") {
    setBusy(id);
    setError("");
    setMessage("");
    try {
      await respondToTournamentInvitation(id, response);
      setMessage(
        response === "ACCEPT"
          ? "Invitation accepted. You have joined the tournament."
          : "Invitation declined.",
      );
      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to respond");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="tournament-invitations-panel">
      <div className="tournament-invitations-heading">
        <div>
          <h2>Tournament invitations</h2>
          <p>Invitations from your friends</p>
        </div>
      </div>

      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}

      {loading ? (
        <p>Loading invitations...</p>
      ) : items.length === 0 ? (
        <p>No pending tournament invitations.</p>
      ) : (
        <div className="tournament-invitations-list">
          {items.map((invitation) => (
            <article className="tournament-invitation-card" key={invitation.id}>
              <div>
                <h3>{invitation.tournament.title}</h3>
                <p>Invited by {invitation.sender.username}</p>
                <p>
                  {invitation.tournament.currentParticipants}/
                  {invitation.tournament.maxParticipants} players
                </p>
                <small>Expires: {formatDate(invitation.expiresAt)}</small>
              </div>
              <div className="tournament-invitation-actions">
                <Link
                  className="tournament-secondary"
                  to={`/tournaments/${invitation.tournament.id}`}
                >
                  Details
                </Link>
                <button
                  type="button"
                  className="primary"
                  disabled={busy !== null}
                  onClick={() => void respond(invitation.id, "ACCEPT")}
                >
                  {busy === invitation.id ? "Processing..." : "Accept"}
                </button>
                <button
                  type="button"
                  className="tournament-secondary"
                  disabled={busy !== null}
                  onClick={() => void respond(invitation.id, "DECLINE")}
                >
                  Decline
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {total > limit && (
        <div className="tournament-pagination">
          <button
            type="button"
            className="tournament-secondary"
            disabled={offset === 0 || loading || busy !== null}
            onClick={() => setOffset((value) => Math.max(0, value - limit))}
          >
            Previous
          </button>
          <span>
            {offset + 1}–{Math.min(offset + limit, total)} of {total}
          </span>
          <button
            type="button"
            className="tournament-secondary"
            disabled={offset + limit >= total || loading || busy !== null}
            onClick={() => setOffset((value) => value + limit)}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}
