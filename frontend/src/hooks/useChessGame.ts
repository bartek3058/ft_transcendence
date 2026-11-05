import { useCallback, useEffect, useMemo, useState } from "react";
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import {
  getGameSocket,
  type GameJoined,
  type PublicGameState,
} from "../services/socket";

export type PromotionPiece = Extract<PieceSymbol, "q" | "r" | "b" | "n">;
export type PendingPromotion = { from: Square; to: Square; color: Color };
export type GameResult = { title: string; message: string } | null;

type ClockSnapshot = {
  whiteMs: number;
  blackMs: number;
  turn: Color;
  isFinished: boolean;
  receivedAt: number;
};

function createClockSnapshot(state: PublicGameState): ClockSnapshot {
  return {
    whiteMs: state.whiteTimeRemainingMs,
    blackMs: state.blackTimeRemainingMs,
    turn: state.turn,
    isFinished: state.isFinished,
    receivedAt: performance.now(),
  };
}

export function useChessGame(joined: GameJoined) {
  const [state, setState] = useState<PublicGameState>(joined.state);
  const [selected, setSelected] = useState<Square | null>(null);
  const [pendingPromotion, setPendingPromotion] =
    useState<PendingPromotion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [clockSnapshot, setClockSnapshot] = useState<ClockSnapshot>(() =>
    createClockSnapshot(joined.state),
  );
  const [clockNow, setClockNow] = useState(() => performance.now());

  useEffect(() => {
    const socket = getGameSocket();

    const onState = (next: PublicGameState) => {
      if (next.gameId !== joined.gameId) return;

      const now = performance.now();
      setState(next);
      setClockSnapshot({
        whiteMs: next.whiteTimeRemainingMs,
        blackMs: next.blackTimeRemainingMs,
        turn: next.turn,
        isFinished: next.isFinished,
        receivedAt: now,
      });
      setClockNow(now);
      setSelected(null);
      setPendingPromotion(null);
      setWaiting(false);
      setError(null);
    };

    const onError = (payload?: { code?: string; state?: PublicGameState }) => {
      if (payload?.state?.gameId === joined.gameId) onState(payload.state);
      setError(payload?.code ?? "Unable to make move");
      setWaiting(false);
    };

    socket.on("game:state", onState);
    socket.on("game:error", onError);

    return () => {
      socket.off("game:state", onState);
      socket.off("game:error", onError);
    };
  }, [joined.gameId]);

  useEffect(() => {
    if (clockSnapshot.isFinished || state.plyCount === 0) return;

    const interval = window.setInterval(() => {
      setClockNow(performance.now());
    }, 100);

    return () => window.clearInterval(interval);
  }, [clockSnapshot.isFinished, state.plyCount]);

  const elapsedMs =
    clockSnapshot.isFinished || state.plyCount === 0
      ? 0
      : Math.max(0, clockNow - clockSnapshot.receivedAt);

  const whiteTimeMs = Math.max(
    0,
    clockSnapshot.whiteMs - (clockSnapshot.turn === "w" ? elapsedMs : 0),
  );
  const blackTimeMs = Math.max(
    0,
    clockSnapshot.blackMs - (clockSnapshot.turn === "b" ? elapsedMs : 0),
  );

  const game = useMemo(() => new Chess(state.fen), [state.fen]);
  const board = useMemo(() => game.board(), [game]);
  const canMove = !state.isFinished && !waiting && game.turn() === joined.color;

  const sendMove = useCallback(
    (from: Square, to: Square, promotion?: PromotionPiece) => {
      const socket = getGameSocket();
      if (!socket.connected) {
        setError("Connection lost");
        return;
      }

      setWaiting(true);
      setError(null);
      socket.emit("game:move", {
        gameId: joined.gameId,
        from,
        to,
        ...(promotion ? { promotion } : {}),
      });
    },
    [joined.gameId],
  );

  function movePiece(from: Square, to: Square) {
    if (!canMove || pendingPromotion) return;

    const piece = game.get(from);
    if (!piece || piece.color !== joined.color) return;

    const legalMoves = game.moves({ square: from, verbose: true });
    const candidates = legalMoves.filter((move) => move.to === to);
    if (!candidates.length) return;

    if (candidates.some((move) => Boolean(move.promotion))) {
      setPendingPromotion({ from, to, color: piece.color });
      setSelected(null);
      return;
    }

    sendMove(from, to);
    setSelected(null);
  }

  function clickSquare(square: Square) {
    if (!canMove || pendingPromotion) return;

    if (!selected) {
      if (game.get(square)?.color === joined.color) setSelected(square);
      return;
    }

    if (game.get(square)?.color === joined.color) {
      setSelected(square);
      return;
    }

    movePiece(selected, square);
  }

  function promote(piece: PromotionPiece) {
    if (!pendingPromotion) return;
    sendMove(pendingPromotion.from, pendingPromotion.to, piece);
    setPendingPromotion(null);
  }

  const resign = useCallback(async (): Promise<boolean> => {
    if (state.isFinished) return true;
    const socket = getGameSocket();
    if (!socket.connected) {
      setError("Connection lost");
      return false;
    }
    setWaiting(true);
    setError(null);
    return new Promise<boolean>((resolve) => {
      socket
        .timeout(15000)
        .emit(
          "game:resign",
          { gameId: joined.gameId },
          (
            timeoutError: Error | null,
            reply?: { success: boolean; code?: string },
          ) => {
            setWaiting(false);
            if (timeoutError || !reply?.success) {
              setError(reply?.code ?? "Unable to resign. Please try again.");
              resolve(false);
              return;
            }
            resolve(true);
          },
        );
    });
  }, [joined.gameId, state.isFinished]);

  const result: GameResult = state.isFinished
    ? {
        title: state.winnerColor ? "Game over" : "Draw",
        message: state.winnerColor
          ? `${state.winnerColor === "w" ? "White" : "Black"} wins (${state.gameOverReason ?? "game over"}).`
          : `Draw (${state.gameOverReason ?? "game over"}).`,
      }
    : null;

  return {
    game,
    board,
    selected,
    moves: state.moves ?? [],
    pendingPromotion,
    whiteTime: Math.ceil(whiteTimeMs / 1000),
    blackTime: Math.ceil(blackTimeMs / 1000),
    result,
    error,
    waiting,
    clickSquare,
    movePiece,
    promote,
    cancelPromotion: () => setPendingPromotion(null),
    isFinished: state.isFinished,
    resign,
  };
}
