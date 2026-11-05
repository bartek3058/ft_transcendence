import { ChessBoard } from "../components/chess/ChessBoard";
import { GameSidebar } from "../components/chess/GameSidebar";
import { PromotionDialog } from "../components/chess/PromotionDialog";
import { AiLobby } from "../components/chess/AiLobby";
import { useAuth } from "../context/AuthContext";
import { useChat } from "../hooks/useChat";
import { useAiGame } from "../hooks/useAiGame";

export function AiGamePage() {
  const { user } = useAuth();
  const ai = useAiGame();
  const chat = useChat();

  if (ai.status === "idle" || ai.status === "connecting" || ai.status === "error") {
    return (
      <div className="matchmakingPage">
        <AiLobby status={ai.status} error={ai.error} onStart={ai.start} />
      </div>
    );
  }

  const myColorLabel = ai.humanColor === "w" ? "White" : "Black";

  return (
    <>
      <div className="gameLayout">
        <section>
          <div className="player">
            <div className="avatar">🤖</div>
            <div>
              <b>Stockfish</b>
              <small>{ai.thinking ? "Thinking…" : `Difficulty: ${ai.difficulty}`}</small>
            </div>
          </div>

          <ChessBoard
            board={ai.board}
            selected={ai.selected}
            onSquareClick={ai.clickSquare}
            orientation={ai.humanColor}
            highlight={ai.hint}
          />

          <div className="player">
            <div className="avatar me">
              {(user?.username?.[0] ?? "P").toUpperCase()}
            </div>
            <div>
              <b>{user?.username ?? "Player"}</b>
              <small>Playing as: {myColorLabel}</small>
            </div>
          </div>

          <div className="actions aiActions">
            <button onClick={ai.requestHint} disabled={!ai.myTurn} title="Suggest a move">
              💡 Hint
            </button>
          </div>
        </section>

        <GameSidebar
          gameId={ai.gameId ?? ""}
          moves={ai.moves}
          onNewGame={ai.leave}
          onResign={ai.resign}
          {...chat}
        />
      </div>

      {ai.pendingPromotion && (
        <PromotionDialog
          color={ai.pendingPromotion.color}
          onSelect={ai.promote}
          onCancel={ai.cancelPromotion}
        />
      )}

      {ai.result && (
        <div className="resultOverlay">
          <div className="resultDialog">
            <div className="resultIcon">♛</div>
            <h2>{ai.result.title}</h2>
            <p>{ai.result.message}</p>
            <button className="primary resultButton" onClick={ai.leave}>
              Play again
            </button>
          </div>
        </div>
      )}
    </>
  );
}
