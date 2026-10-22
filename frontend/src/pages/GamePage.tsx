import { ChessBoard } from "../components/chess/ChessBoard";
import { GameSidebar } from "../components/chess/GameSidebar";
import { PromotionDialog } from "../components/chess/PromotionDialog";
import { useChessGame } from "../hooks/useChessGame";
import { useChat } from "../hooks/useChat";
const fmt = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
export function GamePage() {
  const chess = useChessGame();
  const chat = useChat();
  const turn = chess.game.turn();
  return (
    <>
      <div className="gameLayout">
        <section>
          <div className="player">
            <div className="avatar">A</div>
            <div>
              <b>Alicja</b>
              <small>♟ 1571</small>
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
          />
          <div className="player">
            <div className="avatar me">P</div>
            <div>
              <b>Piotr</b>
              <small>♙ 1542</small>
            </div>
            <div
              className={`clock mine ${turn === "w" && !chess.result ? "activeClock" : ""}`}
            >
              {fmt(chess.whiteTime)}
            </div>
          </div>
        </section>
        <GameSidebar
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
