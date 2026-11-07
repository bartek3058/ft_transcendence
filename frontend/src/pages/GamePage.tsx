import { ChessBoard } from "../components/chess/ChessBoard";
import { GameSidebar } from "../components/chess/GameSidebar";
import { MatchmakingLobby } from "../components/chess/MatchmakingLobby";
import { PromotionDialog } from "../components/chess/PromotionDialog";
import { useAuth } from "../context/AuthContext";
import { useChat } from "../hooks/useChat";
import { useChessGame } from "../hooks/useChessGame";
import { useMatchmaking } from "../hooks/useMatchmaking";
import type { GameJoined } from "../services/socket";

const fmt = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function GamePage() {
  const { user } = useAuth();
  const matchmaking = useMatchmaking();

  if (matchmaking.status !== "matched" || !matchmaking.game) {
    return (
      <div className="matchmakingPage">
        <MatchmakingLobby
          status={matchmaking.status}
          gameId={matchmaking.gameId}
          error={matchmaking.error}
          onSearch={matchmaking.search}
          onCancel={matchmaking.cancel}
        />
      </div>
    );
  }

  return (
    <OnlineGame
      key={matchmaking.game.gameId}
      joined={matchmaking.game}
      username={user?.username ?? "Player"}
      onNewGame={matchmaking.search}
    />
  );
}

function OnlineGame({
  joined,
  username,
  onNewGame,
}: {
  joined: GameJoined;
  username: string;
  onNewGame: () => void;
}) {
  const chess = useChessGame(joined);
  const chat = useChat();

  const handleResign = async () => {
    if (chess.isFinished || chess.waiting) return;
    if (!window.confirm("Are you sure you want to resign?")) return;
    await chess.resign();
  };

  const handleNewGame = async () => {
    if (chess.waiting) return;
    if (!chess.isFinished) {
      if (
        !window.confirm(
          "Leaving this game will count as a resignation. Continue?",
        )
      )
        return;
      const resigned = await chess.resign();
      if (!resigned) return;
    }
    onNewGame();
  };
  const turn = chess.game.turn();
  const myColor = joined.color === "w" ? "White" : "Black";
  const opponentColor = joined.color === "w" ? "b" : "w";
  const opponentTime =
    opponentColor === "w" ? chess.whiteTime : chess.blackTime;
  const myTime = joined.color === "w" ? chess.whiteTime : chess.blackTime;

  return (
    <>
      {!chess.connected && (
        <p role="status" className="muted">
          Reconnecting to the game...
        </p>
      )}
      <div className="gameLayout">
        <section>
          <div className="player">
            <div className="avatar">O</div>
            <div>
              <b>Opponent</b>
              <small>Connected</small>
            </div>
            <div
              className={`clock ${turn === opponentColor && !chess.result ? "activeClock" : ""}`}
            >
              {fmt(opponentTime)}
            </div>
          </div>

          <ChessBoard
            board={chess.board}
            selected={chess.selected}
            onSquareClick={chess.clickSquare}
            onMove={chess.movePiece}
            orientation={joined.color}
          />

          <div className="player">
            <div className="avatar me">
              {(username[0] ?? "P").toUpperCase()}
            </div>
            <div>
              <b>{username}</b>
              <small>Playing as: {myColor}</small>
            </div>
            <div
              className={`clock mine ${turn === joined.color && !chess.result ? "activeClock" : ""}`}
            >
              {fmt(myTime)}
            </div>
          </div>
        </section>

        <GameSidebar
          gameId={joined.gameId}
          moves={chess.moves}
          onNewGame={handleNewGame}
          onResign={handleResign}
          {...chat}
        />
      </div>

      {chess.error && (
        <p role="alert" className="muted">
          {chess.error}
        </p>
      )}

      {chess.pendingPromotion && (
        <PromotionDialog
          color={chess.pendingPromotion.color}
          onSelect={chess.promote}
          onCancel={chess.cancelPromotion}
        />
      )}

      {chess.result && (
        <div className="resultOverlay">
          <div className="resultDialog">
            <div className="resultIcon">♛</div>
            <h2>{chess.result.title}</h2>
            <p>{chess.result.message}</p>
            <button className="primary resultButton" onClick={handleNewGame}>
              Play again
            </button>
          </div>
        </div>
      )}
    </>
  );
}
