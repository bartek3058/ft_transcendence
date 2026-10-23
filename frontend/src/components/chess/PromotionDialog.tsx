import type { Color } from "chess.js";
import { ChessPiece } from "./ChessPiece";
import type { PromotionPiece } from "../../hooks/useChessGame";

type Props = {
  color: Color;
  onSelect: (piece: PromotionPiece) => void;
  onCancel: () => void;
};

const choices: { type: PromotionPiece; label: string }[] = [
  { type: "q", label: "Queen" },
  { type: "r", label: "Rook" },
  { type: "b", label: "Bishop" },
  { type: "n", label: "Knight" },
];

export function PromotionDialog({ color, onSelect, onCancel }: Props) {
  return (
    <div
      className="promotionBackdrop"
      role="presentation"
      onMouseDown={onCancel}
    >
      <div
        className="promotionDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="promotion-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="promotion-title">Choose a piece</h2>
        <p>
          The pawn has reached the last rank. Choose the piece you want to
          promote it to.
        </p>
        <div className="promotionChoices">
          {choices.map(({ type, label }) => (
            <button
              key={type}
              type="button"
              onClick={() => onSelect(type)}
              aria-label={label}
              title={label}
            >
              <ChessPiece type={type} color={color} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <button className="promotionCancel" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
