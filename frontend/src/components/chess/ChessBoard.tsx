import { useState } from "react";
import type { Chess, Color, Square } from "chess.js";
import { ChessPiece } from "./ChessPiece";

type ChessBoardState = ReturnType<Chess["board"]>;

type Props = {
  board: ChessBoardState;
  selected: Square | null;
  onSquareClick: (square: Square) => void;
  onMove: (from: Square, to: Square) => void;
  orientation?: Color;
};

const files = "abcdefgh".split("");
const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"];

export function ChessBoard({
  board,
  selected,
  onSquareClick,
  onMove,
  orientation = "w",
}: Props) {
  const [draggedFrom, setDraggedFrom] = useState<Square | null>(null);
  const [draggedOver, setDraggedOver] = useState<Square | null>(null);

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

  function handleDragStart(
    event: React.DragEvent<HTMLSpanElement>,
    square: Square,
  ) {
    setDraggedFrom(square);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", square);

    const dragImage = event.currentTarget.cloneNode(true) as HTMLElement;
    const { width, height } = event.currentTarget.getBoundingClientRect();

    dragImage.style.position = "fixed";
    dragImage.style.left = "-9999px";
    dragImage.style.top = "-9999px";
    dragImage.style.width = `${width}px`;
    dragImage.style.height = `${height}px`;

    document.body.appendChild(dragImage);

    event.dataTransfer.setDragImage(dragImage, width / 2, height / 2);

    requestAnimationFrame(() => {
      dragImage.remove();
    });
  }

  function handleDragOver(
    event: React.DragEvent<HTMLButtonElement>,
    square: Square,
  ) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDraggedOver(square);
  }

  function handleDrop(event: React.DragEvent<HTMLButtonElement>, to: Square) {
    event.preventDefault();

    const from =
      draggedFrom ?? (event.dataTransfer.getData("text/plain") as Square | "");

    setDraggedFrom(null);
    setDraggedOver(null);

    if (!from || from === to) {
      return;
    }

    onMove(from as Square, to);
  }

  function handleDragEnd() {
    setDraggedFrom(null);
    setDraggedOver(null);
  }

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
            type="button"
            aria-label={square}
            onClick={() => onSquareClick(square)}
            onDragOver={(event) => handleDragOver(event, square)}
            onDragLeave={() => {
              if (draggedOver === square) {
                setDraggedOver(null);
              }
            }}
            onDrop={(event) => handleDrop(event, square)}
            className={`sq ${(row + col) % 2 ? "dark" : "light"} ${
              selected === square ? "selected" : ""
            } ${draggedOver === square ? "dragOver" : ""}`}
          >
            {piece && (
              <ChessPiece
                type={piece.type}
                color={piece.color}
                draggable
                onDragStart={(event) => handleDragStart(event, square)}
                onDragEnd={handleDragEnd}
              />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
