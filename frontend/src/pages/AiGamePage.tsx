import { GameResultOverlay } from "../components/chess/GameResultOverlay";
import { useEffect, useState } from "react";
import { getMyProfile } from "../services/profile";
import { ChessBoard } from "../components/chess/ChessBoard";
import { GameSidebar } from "../components/chess/GameSidebar";
import { PromotionDialog } from "../components/chess/PromotionDialog";
import { AiLobby } from "../components/chess/AiLobby";
import { useAuth } from "../context/AuthContext";
import { useAiChat, CHAT_MODES, type ChatMode } from "../hooks/useAiChat";
import { useAiGame } from "../hooks/useAiGame";

export function AiGamePage() {
  const { user } = useAuth();
  const [myRating, setMyRating] = useState<number | null>(null);
  const ai = useAiGame();

  useEffect(() => {
    let active = true;
    setMyRating(null);

    if (user?.id) {
      getMyProfile()
        .then((profile) => {
          if (active && profile.user.id === user.id) {
            setMyRating(profile.user.rating);
          }
        })
        .catch(() => {
          if (active) setMyRating(null);
        });
    }

    return () => {
      active = false;
    };
  }, [user?.id]);
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

  return (
    <>
      <div className="gameLayout">
        <section>
          <div className="player">
            <div className="avatar">🤖</div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <b>Stockfish</b>
                <span className="playerElo">
                  {ai.difficulty.charAt(0).toUpperCase() + ai.difficulty.slice(1)}
                </span>
              </div>
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
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <b>{user?.username ?? "Player"}</b>
                {myRating != null && (
                  <span className="playerElo">{myRating} ELO</span>
                )}
              </div>
            </div>
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
          onHint={ai.requestHint}
          hintDisabled={!ai.myTurn || ai.hintPending}
          hintPending={ai.hintPending}
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
