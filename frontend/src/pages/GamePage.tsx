import { ChessBoard } from "../components/chess/ChessBoard";
import { GameSidebar } from "../components/chess/GameSidebar";
import { MatchmakingLobby } from "../components/chess/MatchmakingLobby";
import { PromotionDialog } from "../components/chess/PromotionDialog";
import { useAuth } from "../context/AuthContext";
import { useChat } from "../hooks/useChat";
import { useChessGame } from "../hooks/useChessGame";
import { useMatchmaking } from "../hooks/useMatchmaking";

const fmt = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function GamePage() {
  const { user } = useAuth();
  const chess = useChessGame();
  const chat = useChat();
  const matchmaking = useMatchmaking();
  const turn = chess.game.turn();

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

  const myColor = matchmaking.game.color === "w" ? "White" : "Black";

  return (
    <>
      <div className="gameLayout">
        <section>
          <div className="player">
            <div className="avatar">O</div>
            <div>
              <b>Opponent</b>
              <small>Connected</small>
            </div>
            <div
              className={`clock ${turn === "b" && !chess.result ? "activeClock" : ""}`}
            >
              {fmt(chess.blackTime)}
            </div>
          </div>

          <ChessBoard
            board={chess.board}
            selected={chess.selected}
            onSquareClick={chess.clickSquare}
            onMove={chess.movePiece}
            orientation={matchmaking.game.color}
          />

          <div className="player">
            <div className="avatar me">
              {(user?.username?.[0] ?? "P").toUpperCase()}
            </div>
            <div>
              <b>{user?.username ?? "Player"}</b>
              <small>Playing as: {myColor}</small>
            </div>
            <div
              className={`clock mine ${turn === "w" && !chess.result ? "activeClock" : ""}`}
            >
              {fmt(chess.whiteTime)}
            </div>
          </div>
        </section>

        <GameSidebar
          gameId={matchmaking.game.gameId}
          moves={chess.moves}
          onNewGame={chess.reset}
          onResign={chess.resign}
          {...chat}
        />
      </div>

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
            <button className="primary resultButton" onClick={chess.reset}>
              Play again
            </button>
          </div>
        </div>
      )}
    </>
  );
}
