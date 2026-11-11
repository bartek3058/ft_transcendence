import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTournamentGame } from "../hooks/useTournamentGame";
import { OnlineGame } from "./GamePage";

export function TournamentGamePage() {
  const { gameId } = useParams<{ gameId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const { joined, restoring, error, finished } =
    useTournamentGame(gameId);

  const tournamentId = searchParams.get("tournamentId");

  const backUrl = tournamentId
    ? `/tournaments/${encodeURIComponent(tournamentId)}`
    : "/tournaments";

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <Link to={backUrl}>← Back to tournament</Link>
      </div>

      {error && (
        <p role="alert" className="muted">
          {error}
        </p>
      )}

      {finished && !joined && (
        <div className="matchmakingLobby">
          <h2>Game finished</h2>
          <p>{finished.result === "ABORTED"
            ? "This game could not be restored. Return to the tournament to check in for a replacement game."
            : finished.result}</p>
          <button
            className="primary"
            onClick={() => navigate(backUrl)}
          >
            Back to tournament
          </button>
        </div>
      )}

      {!joined && !finished && (
        <p role="status" className="muted">
          {restoring
            ? "Connecting to tournament game..."
            : "Waiting for game..."}
        </p>
      )}

      {joined && (
        <OnlineGame
          key={joined.gameId}
          joined={joined}
          username={user?.username ?? "Player"}
          restoring={restoring}
          tournamentMode
          onNewGame={() => navigate(backUrl)}
        />
      )}
    </div>
  );
}
