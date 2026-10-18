import type { Color } from "chess.js";
import { ChessPiece } from "./ChessPiece";
import type { PromotionPiece } from "../../hooks/useChessGame";

type Props = {
  color: Color;
  onSelect: (piece: PromotionPiece) => void;
  onCancel: () => void;
};

const choices: { type: PromotionPiece; label: string }[] = [
  { type: "q", label: "Hetman" },
  { type: "r", label: "Wieża" },
  { type: "b", label: "Goniec" },
  { type: "n", label: "Skoczek" },
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
        <h2 id="promotion-title">Wybierz figurę</h2>
        <p>
          Pion dotarł do ostatniej linii. Wybierz figurę, na którą ma zostać
          promowany.
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
          Anuluj
        </button>
      </div>
    </div>
  );
}
