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
              title: "Time's up",
              message: "Alice wins — Peter ran out of time.",
            });
            return 0;
          }

          return t - 1;
        });
      } else {
        setBlackTime((t) => {
          if (t <= 1) {
            setResult({
              title: "Time's up",
              message: "Peter wins — Alice ran out of time.",
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
      const winner = next.turn() === "w" ? "Alice" : "Peter";
      setResult({
        title: "Checkmate!",
        message: `${winner} wins the game.`,
      });
    } else if (next.isStalemate()) {
      setResult({
        title: "Stalemate",
        message: "The game ended in a draw.",
      });
    } else if (next.isThreefoldRepetition()) {
      setResult({
        title: "Draw",
        message: "Threefold repetition.",
      });
    } else if (next.isInsufficientMaterial()) {
      setResult({
        title: "Draw",
        message: "Insufficient material to checkmate.",
      });
    } else if (next.isDraw()) {
      setResult({
        title: "Draw",
        message: "The game ended in a draw.",
      });
    }
  }

  function makeMove(
    from: Square,
    to: Square,
    promotion?: PromotionPiece,
  ): boolean {
    try {
      const next = new Chess(game.fen());
      const move = next.move({
        from,
        to,
        ...(promotion ? { promotion } : {}),
      });

      if (!move) {
        return false;
      }

      setGame(next);
      setMoves((current) => [...current, move.san]);
      setStarted(true);
      finishIfNeeded(next);

      return true;
    } catch {
      return false;
    }
  }

  function requiresPromotion(from: Square, to: Square): boolean {
    const piece = game.get(from);

    if (piece?.type !== "p") {
      return false;
    }

    const reachesLastRank =
      (piece.color === "w" && to.endsWith("8")) ||
      (piece.color === "b" && to.endsWith("1"));

    if (!reachesLastRank) {
      return false;
    }

    return game
      .moves({ square: from, verbose: true })
      .some((move) => move.to === to && Boolean(move.promotion));
  }

  function movePiece(from: Square, to: Square) {
    if (game.isGameOver() || pendingPromotion || result) {
      return;
    }

    const piece = game.get(from);

    if (!piece || piece.color !== game.turn()) {
      return;
    }

    if (requiresPromotion(from, to)) {
      setPendingPromotion({
        from,
        to,
        color: piece.color,
      });
      setSelected(null);
      return;
    }

    makeMove(from, to);
    setSelected(null);
  }

  function clickSquare(square: Square) {
    if (game.isGameOver() || pendingPromotion || result) {
      return;
    }

    if (!selected) {
      const piece = game.get(square);

      if (piece?.color === game.turn()) {
        setSelected(square);
      }

      return;
    }

    const target = game.get(square);

    if (target?.color === game.turn()) {
      setSelected(square);
      return;
    }

    movePiece(selected, square);
  }

  function promote(piece: PromotionPiece) {
    if (!pendingPromotion) {
      return;
    }

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
    if (!result) {
      setResult({
        title: "Resignation",
        message: `${
          game.turn() === "w" ? "Alice" : "Peter"
        } wins — the opponent resigned.`,
      });
    }
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
    movePiece,
    promote,
    cancelPromotion,
    reset,
    resign,
  };
}
