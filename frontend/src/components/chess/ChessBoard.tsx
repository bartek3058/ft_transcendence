import type { Chess, Color, Square } from "chess.js";
import { ChessPiece } from "./ChessPiece";

type ChessBoardState = ReturnType<Chess["board"]>;

type Props = {
  board: ChessBoardState;
  selected: Square | null;
  onSquareClick: (square: Square) => void;
  orientation?: Color;
  // Two squares to highlight as a suggested move (the AI hint).
  highlight?: { from: Square; to: Square } | null;
};

const files = "abcdefgh".split("");
const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"];

export function ChessBoard({
  board,
  selected,
  onSquareClick,
  orientation = "w",
  highlight = null,
}: Props) {
  const isBlack = orientation === "b";

  const displayFiles = isBlack ? [...files].reverse() : files;
  const displayRanks = isBlack ? [...ranks].reverse() : ranks;

  const squares = board.flatMap((row, r) =>
    row.map((piece, c) => ({
      piece,
      square: `${files[c]}${8 - r}` as Square,
      row: r,
      col: c,
    })),
  );

  const displaySquares = isBlack ? [...squares].reverse() : squares;

  return (
    <div className="woodBoardFrame">
      <div className="fileLabels fileLabelsTop">
        {displayFiles.map((file) => (
          <span key={`t-${file}`}>{file}</span>
        ))}
      </div>

      <div className="fileLabels fileLabelsBottom">
        {displayFiles.map((file) => (
          <span key={`b-${file}`}>{file}</span>
        ))}
      </div>

      <div className="rankLabels rankLabelsLeft">
        {displayRanks.map((rank) => (
          <span key={`l-${rank}`}>{rank}</span>
        ))}
      </div>

      <div className="rankLabels rankLabelsRight">
        {displayRanks.map((rank) => (
          <span key={`r-${rank}`}>{rank}</span>
        ))}
      </div>

      <div className="board">
        {displaySquares.map(({ piece, square, row, col }) => (
          <button
            key={square}
            aria-label={square}
            onClick={() => onSquareClick(square)}
            className={`sq ${(row + col) % 2 ? "dark" : "light"} ${
              selected === square ? "selected" : ""
            } ${highlight && (highlight.from === square || highlight.to === square) ? "hint" : ""}`}
          >
            {piece && <ChessPiece type={piece.type} color={piece.color} />}
          </button>
        ))}
      </div>
    </div>
  );
}
