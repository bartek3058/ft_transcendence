interface MatchmakingLobbyProps {
  status: "idle" | "connecting" | "queued" | "matched" | "error";
  gameId: string | null;
  error: string | null;
  onSearch: () => void;
  onCancel: () => void;
}

export function MatchmakingLobby({
  status,
  gameId,
  error,
  onSearch,
  onCancel,
}: MatchmakingLobbyProps) {
  const isSearching = status === "connecting" || status === "queued";

  return (
    <div className="matchmakingLobby">
      <div className="matchmakingIcon">♞</div>

      <h2>{status === "matched" ? "Opponent found" : "Online game"}</h2>

      <p>
        {status === "idle" &&
          "Join the queue and play against another online player."}
        {status === "connecting" && "Connecting to the server..."}
        {status === "queued" &&
          "Searching for an opponent with a similar ELO rating..."}
        {status === "matched" &&
          "Both players have been assigned to the same game room."}
        {status === "error" && (error ?? "Unable to connect to matchmaking.")}
      </p>

      {gameId && <small className="matchmakingGameId">Game ID: {gameId}</small>}

      {isSearching ? (
        <button type="button" onClick={onCancel}>
          Cancel search
        </button>
      ) : status !== "matched" ? (
        <button type="button" className="primary" onClick={onSearch}>
          Search for opponent
        </button>
      ) : null}
    </div>
  );
}
