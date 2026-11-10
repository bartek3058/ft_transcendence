import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Clock, Trophy, Users } from "lucide-react";
import { Page } from "../components/ui/Page";
import { CreateTournamentForm } from "../components/tournaments/CreateTournamentForm";
import { listTournaments, type TournamentPage, type TournamentTab } from "../services/tournaments";
import { TournamentInvitations } from "../components/tournaments/TournamentInvitations";
import { TournamentInviteFriends } from "../components/tournaments/TournamentInviteFriends";


const tabs: { id: TournamentTab; label: string }[] = [
  { id: "open", label: "Open" }, { id: "live", label: "Live" }, { id: "past", label: "Past" },
];
const formatDate = (date: string) => new Date(date).toLocaleString();

export function TournamentsPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TournamentTab>("open");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<TournamentPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setData(null);
    listTournaments(tab, offset)
      .then((page) => { if (active) setData(page); })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Failed to load tournaments");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tab, offset]);

  return (
    <Page title="Tournaments" sub="Join the competition and climb the leaderboard">
      <TournamentInvitations />
      <div className="tournament-toolbar">
        <div className="tournament-tabs" role="group" aria-label="Tournament status">
          {tabs.map((item) => (
            <button key={item.id} type="button"
              className={tab === item.id ? "primary" : "tournament-secondary"}
              aria-pressed={tab === item.id}
              onClick={() => { setTab(item.id); setOffset(0); }}>
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" className="primary" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? "Close form" : "+ Create Tournament"}
        </button>
      </div>

      {showCreate && (
        <CreateTournamentForm onCancel={() => setShowCreate(false)}
          onCreated={(tournament) => navigate(`/tournaments/${tournament.id}`)} />
      )}

      {loading && <p>Loading tournaments...</p>}
      {error && <p role="alert">Could not load tournaments: {error}</p>}
      {!loading && !error && data?.items.length === 0 && <p>No tournaments found in this category.</p>}
      {!loading && !error && (
        <div className="grid">
          {data?.items.map((tournament) => (
            <div className="card tournament" key={tournament.id}>
              <Trophy />
              <small>{tournament.status.replace(/_/g, " ")}</small>
              <h3>{tournament.title}</h3>
              {tournament.description && <p>{tournament.description}</p>}
              <p><Users size={15} /> {tournament.currentParticipants}/{tournament.maxParticipants} players</p>
              <p><Clock size={15} /> {formatDate(tournament.registrationDeadline)}</p>
              <p>Created by {tournament.creator.username}</p>
              {tournament.status === "OPEN_FOR_SIGNUP" && (
                <TournamentInviteFriends tournamentId={tournament.id} />
              )}
              <Link className="primary tournament-details-link" to={`/tournaments/${tournament.id}`}>
                View details
              </Link>
            </div>
          ))}
        </div>
      )}
      {!loading && !error && data && (
        <div className="tournament-pagination">
          <button type="button" className="tournament-secondary" disabled={offset === 0}
            onClick={() => setOffset((v) => Math.max(0, v - data.limit))}>Previous</button>
          <span>{data.total === 0 ? 0 : offset + 1} – {Math.min(offset + data.limit, data.total)} of {data.total}</span>
          <button type="button" className="tournament-secondary"
            disabled={offset + data.limit >= data.total}
            onClick={() => setOffset((v) => v + data.limit)}>Next</button>
        </div>
      )}
    </Page>
  );
}
