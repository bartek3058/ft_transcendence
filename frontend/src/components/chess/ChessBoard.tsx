import type { Chess, Square } from "chess.js";
type ChessBoardState = ReturnType<Chess["board"]>;
import { ChessPiece } from "./ChessPiece";
type Props = {
  board: ChessBoardState;
  selected: Square | null;
  onSquareClick: (square: Square) => void;
};

const files = "abcdefgh".split("");
const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"];

export function ChessBoard({ board, selected, onSquareClick }: Props) {
  const square = (r: number, c: number) => `${files[c]}${8 - r}` as Square;
  return (
    <div className="woodBoardFrame">
      <div className="fileLabels fileLabelsTop">
        {files.map((f) => (
          <span key={`t-${f}`}>{f}</span>
        ))}
      </div>
      <div className="fileLabels fileLabelsBottom">
        {files.map((f) => (
          <span key={`b-${f}`}>{f}</span>
        ))}
      </div>
      <div className="rankLabels rankLabelsLeft">
        {ranks.map((r) => (
          <span key={`l-${r}`}>{r}</span>
        ))}
      </div>
      <div className="rankLabels rankLabelsRight">
        {ranks.map((r) => (
          <span key={`r-${r}`}>{r}</span>
        ))}
      </div>
      <div className="board">
        {board.flatMap((row, r) =>
          row.map((piece, c) => {
            const sq = square(r, c);
            return (
              <button
                key={sq}
                aria-label={sq}
                onClick={() => onSquareClick(sq)}
                className={`sq ${(r + c) % 2 ? "dark" : "light"} ${selected === sq ? "selected" : ""}`}
              >
                {piece && <ChessPiece type={piece.type} color={piece.color} />}
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}
