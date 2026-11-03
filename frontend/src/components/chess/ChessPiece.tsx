import type { DragEventHandler } from "react";
import type { Color, PieceSymbol } from "chess.js";

type Props = {
  type: PieceSymbol;
  color: Color;
  className?: string;
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLSpanElement>;
  onDragEnd?: DragEventHandler<HTMLSpanElement>;
};

const pieceUrls: Record<Color, Record<PieceSymbol, string>> = {
  w: {
    k: "/pieces/white-king.svg",
    q: "/pieces/white-queen.svg",
    r: "/pieces/white-rook.svg",
    b: "/pieces/white-bishop.svg",
    n: "/pieces/white-knight.svg",
    p: "/pieces/white-pawn.svg",
  },
  b: {
    k: "/pieces/black-king.svg",
    q: "/pieces/black-queen.svg",
    r: "/pieces/black-rook.svg",
    b: "/pieces/black-bishop.svg",
    n: "/pieces/black-knight.svg",
    p: "/pieces/black-pawn.svg",
  },
};

export function ChessPiece({
  type,
  color,
  className = "",
  draggable = false,
  onDragStart,
  onDragEnd,
}: Props) {
  return (
    <span
      className={`pieceFrame ${className}`}
      aria-hidden="true"
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <img
        className="pieceSvg"
        src={pieceUrls[color][type]}
        alt=""
        draggable={false}
      />
    </span>
  );
}
