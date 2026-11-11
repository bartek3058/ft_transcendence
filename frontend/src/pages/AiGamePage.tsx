import { GameResultOverlay } from "../components/chess/GameResultOverlay";
import { ChessBoard } from "../components/chess/ChessBoard";
import { GameSidebar } from "../components/chess/GameSidebar";
import { PromotionDialog } from "../components/chess/PromotionDialog";
import { AiLobby } from "../components/chess/AiLobby";
import { useAuth } from "../context/AuthContext";
import { useAiChat, CHAT_MODES, type ChatMode } from "../hooks/useAiChat";
import { useAiGame } from "../hooks/useAiGame";

export function AiGamePage() {
  const { user } = useAuth();
  const ai = useAiGame();
  const chat = useAiChat(() => ({
    fen: ai.game.fen(),
    moves: ai.moves,
    turn: ai.game.turn(),
  }));

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
            onMove={ai.movePiece}
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
            <button
              onClick={ai.requestHint}
              disabled={!ai.myTurn || ai.hintPending}
              title="Suggest a move"
            >
              {ai.hintPending ? "💡 Thinking…" : "💡 Hint"}
            </button>
          </div>
        </section>

        <GameSidebar
          gameId={ai.gameId ?? ""}
          moves={ai.moves}
          messages={chat.messages}
          draft={chat.draft}
          setDraft={chat.setDraft}
          send={chat.send}
          onNewGame={ai.leave}
          onResign={ai.resign}
          mode={chat.mode}
          modes={CHAT_MODES}
          onModeChange={(m) => chat.setMode(m as ChatMode)}
          sending={chat.sending}
          retry={chat.retry}
          retryableId={chat.retryableId}
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
        <GameResultOverlay
          title={ai.result.title}
          message={ai.result.message}
          onPlayAgain={ai.leave}
        />
      )}
    </>
  );
}
