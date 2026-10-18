import { useEffect, useMemo, useState } from "react";
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";

export type PromotionPiece = Extract<PieceSymbol, "q" | "r" | "b" | "n">;
export type PendingPromotion = { from: Square; to: Square; color: Color };
export type GameResult = { title: string; message: string } | null;
const INITIAL_TIME = 10 * 60;

export function useChessGame() {
  const [game, setGame] = useState(() => new Chess());
  const [selected, setSelected] = useState<Square | null>(null);
  const [moves, setMoves] = useState<string[]>([]);
  const [pendingPromotion, setPendingPromotion] =
    useState<PendingPromotion | null>(null);
  const [whiteTime, setWhiteTime] = useState(INITIAL_TIME);
  const [blackTime, setBlackTime] = useState(INITIAL_TIME);
  const [started, setStarted] = useState(false);
  const [result, setResult] = useState<GameResult>(null);
  const board = useMemo(() => game.board(), [game]);

  useEffect(() => {
    if (!started || result || game.isGameOver() || pendingPromotion) return;
    const id = window.setInterval(() => {
      if (game.turn() === "w") {
        setWhiteTime((t) => {
          if (t <= 1) {
            setResult({
              title: "Koniec czasu",
              message: "Alicja wygrywa — Piotrowi skończył się czas.",
            });
            return 0;
          }
          return t - 1;
        });
      } else {
        setBlackTime((t) => {
          if (t <= 1) {
            setResult({
              title: "Koniec czasu",
              message: "Piotr wygrywa — Alicji skończył się czas.",
            });
            return 0;
          }
          return t - 1;
        });
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [started, result, game, pendingPromotion]);

  function finishIfNeeded(next: Chess) {
    if (next.isCheckmate()) {
      const winner = next.turn() === "w" ? "Alicja" : "Piotr";
      setResult({ title: "Szach-mat!", message: `${winner} wygrywa partię.` });
    } else if (next.isStalemate())
      setResult({ title: "Pat", message: "Partia zakończyła się remisem." });
    else if (next.isThreefoldRepetition())
      setResult({ title: "Remis", message: "Trzykrotne powtórzenie pozycji." });
    else if (next.isInsufficientMaterial())
      setResult({
        title: "Remis",
        message: "Niewystarczający materiał do mata.",
      });
    else if (next.isDraw())
      setResult({ title: "Remis", message: "Partia zakończyła się remisem." });
  }

  function makeMove(from: Square, to: Square, promotion?: PromotionPiece) {
    try {
      const next = new Chess(game.fen());
      const move = next.move({ from, to, ...(promotion ? { promotion } : {}) });
      if (move) {
        setGame(next);
        setMoves((v) => [...v, move.san]);
        setStarted(true);
        finishIfNeeded(next);
      }
    } catch {
      /* nielegalny ruch */
    }
  }

  function clickSquare(square: Square) {
    if (game.isGameOver() || pendingPromotion || result) return;
    if (!selected) {
      const piece = game.get(square);
      if (piece?.color === game.turn()) setSelected(square);
      return;
    }
    const target = game.get(square);
    if (target?.color === game.turn()) {
      setSelected(square);
      return;
    }
    const piece = game.get(selected);
    const last =
      piece?.type === "p" &&
      ((piece.color === "w" && square.endsWith("8")) ||
        (piece.color === "b" && square.endsWith("1")));
    if (
      last &&
      game
        .moves({ square: selected, verbose: true })
        .some((m) => m.to === square && Boolean(m.promotion))
    ) {
      setPendingPromotion({ from: selected, to: square, color: piece!.color });
      setSelected(null);
      return;
    }
    makeMove(selected, square);
    setSelected(null);
  }
  function promote(piece: PromotionPiece) {
    if (!pendingPromotion) return;
    makeMove(pendingPromotion.from, pendingPromotion.to, piece);
    setPendingPromotion(null);
  }
  function cancelPromotion() {
    setPendingPromotion(null);
  }
  function reset() {
    setGame(new Chess());
    setMoves([]);
    setSelected(null);
    setPendingPromotion(null);
    setWhiteTime(INITIAL_TIME);
    setBlackTime(INITIAL_TIME);
    setStarted(false);
    setResult(null);
  }
  function resign() {
    if (!result)
      setResult({
        title: "Poddanie partii",
        message: `${game.turn() === "w" ? "Alicja" : "Piotr"} wygrywa — przeciwnik poddał partię.`,
      });
  }
  return {
    game,
    board,
    selected,
    moves,
    pendingPromotion,
    whiteTime,
    blackTime,
    result,
    clickSquare,
    promote,
    cancelPromotion,
    reset,
    resign,
  };
}
