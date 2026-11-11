import * as React from "react";
import { GameResultOverlay } from "../components/chess/GameResultOverlay";
import "../styles/bootstrap-game-button.scss";
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

  if (matchmaking.status === "finished" && matchmaking.finishedGame) {
    const finished = matchmaking.finishedGame;
    const winner = finished.winnerColor === "w" ? "White" : "Black";
    return (
      <div className="matchmakingPage">
        <div className="matchmakingLobby">
          <div className="matchmakingIcon">♛</div>
          <h2>{finished.winnerColor ? "Game over" : "Draw"}</h2>
          <p>
            {finished.winnerColor ? `${winner} wins` : "Draw"}
            {finished.reason ? ` (${finished.reason})` : ""}.
          </p>
          <p>The game ended while you were disconnected.</p>
          <button className="primary" onClick={matchmaking.search}>
            Play again
          </button>
        </div>
      </div>
    );
  }

  if (
    !matchmaking.game ||
    !["matched", "restoring"].includes(matchmaking.status)
  ) {
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
      userId={user?.id ?? ""}
      onNewGame={matchmaking.search}
      restoring={matchmaking.status === "restoring"}
    />
  );
}

export function OnlineGame({
  joined,
  username,
  userId,
  onNewGame,
  restoring,
  tournamentMode = false,
}: {
  joined: GameJoined;
  username: string;
  userId?: string;
  onNewGame: () => void;
  restoring: boolean;
  tournamentMode?: boolean;
}) {
  const chess = useChessGame(joined, restoring);
  const chat = useChat(joined.gameId, userId ?? "");

  const handleResign = async () => {
    if (restoring || chess.isFinished || chess.waiting) return;
    if (!window.confirm("Are you sure you want to resign?")) return;
    await chess.resign();
  };

  const handleNewGame = async () => {
    if (tournamentMode) {
      onNewGame();
      return;
    }

    if (restoring || chess.waiting) return;
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
  const opponentColor = joined.color === "w" ? "b" : "w";
  const opponentTime =
    opponentColor === "w" ? chess.whiteTime : chess.blackTime;
  const myTime = joined.color === "w" ? chess.whiteTime : chess.blackTime;

  const opponentName =
    (opponentColor === "w"
      ? joined.whiteUsername
      : joined.blackUsername) || "Opponent";

  const opponentRating =
    opponentColor === "w" ? joined.whiteRating : joined.blackRating;

  const myRating =
    joined.color === "w" ? joined.whiteRating : joined.blackRating;

  return (
    <>
      {(!chess.connected || restoring) && (
        <p role="status" className="muted">
          Reconnecting to the game...
        </p>
      )}
      <div className="gameLayout">
        <section>
          <div className="player">
            <div className="avatar">
              {opponentName[0].toUpperCase()}
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <b>{opponentName}</b>
                {opponentRating != null && (
                  <span className="playerElo">{opponentRating} ELO</span>
                )}
              </div>
              
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
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <b>{username}</b>
                {myRating != null && (
                  <span className="playerElo">{myRating} ELO</span>
                )}
              </div>
              
            </div>
            <div
              className={`clock mine ${turn === joined.color && !chess.result ? "activeClock" : ""}`}
            >
              {fmt(myTime)}
            </div>
          </div>
        </section>

        <GameSidebar
          newGameLabel={
            tournamentMode ? "Back to tournament" : "New game"
          }
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
        <GameResultOverlay
          title={chess.result.title}
          message={chess.result.message}
          onPlayAgain={handleNewGame}
          playAgainLabel={
            tournamentMode ? "Back to tournament" : "Play again"
          }
        />
      )}
    </>
  );
}
