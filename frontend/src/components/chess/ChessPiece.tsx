import type { Color, PieceSymbol } from "chess.js";

type Props = { type: PieceSymbol; color: Color; className?: string };

/**
 * Klasyczny zestaw Cburnett (Wikimedia Commons) – smukłe figury Staunton,
 * podobne do zestawu z przesłanej referencji. Pliki są SVG 45×45 z
 * przezroczystym tłem, więc zachowują identyczne proporcje i centrowanie.
 */
const pieceUrls: Record<Color, Record<PieceSymbol, string>> = {
  w: {
    k: "https://commons.wikimedia.org/wiki/Special:Redirect/file/Chess_klt45.svg",
    q: "https://commons.wikimedia.org/wiki/Special:Redirect/file/Chess_qlt45.svg",
    r: "https://commons.wikimedia.org/wiki/Special:Redirect/file/Chess_rlt45.svg",
    b: "https://commons.wikimedia.org/wiki/Special:Redirect/file/Chess_blt45.svg",
    n: "https://commons.wikimedia.org/wiki/Special:Redirect/file/Chess_nlt45.svg",
    p: "https://commons.wikimedia.org/wiki/Special:Redirect/file/Chess_plt45.svg",
  },
  b: {
    k: "https://commons.wikimedia.org/wiki/Special:Redirect/file/Chess_kdt45.svg",
    q: "https://commons.wikimedia.org/wiki/Special:Redirect/file/Chess_qdt45.svg",
    r: "https://commons.wikimedia.org/wiki/Special:Redirect/file/Chess_rdt45.svg",
    b: "https://commons.wikimedia.org/wiki/Special:Redirect/file/Chess_bdt45.svg",
    n: "https://commons.wikimedia.org/wiki/Special:Redirect/file/Chess_ndt45.svg",
    p: "https://commons.wikimedia.org/wiki/Special:Redirect/file/Chess_pdt45.svg",
  },
};

export function ChessPiece({ type, color, className = "" }: Props) {
  return (
    <span className={`pieceFrame ${className}`} aria-hidden="true">
      <img
        className="pieceSvg"
        src={pieceUrls[color][type]}
        alt=""
        draggable={false}
      />
    </span>
  );
}
