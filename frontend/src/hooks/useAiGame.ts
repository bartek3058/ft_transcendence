import { useCallback, useEffect, useRef, useState } from "react";
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import {
  getAiGameSocket,
  type AiCreated,
  type AiDifficulty,
  type AiHint,
  type AiMoved,
  type PlayerColor,
} from "../services/socket";

export type PromotionPiece = Extract<PieceSymbol, "q" | "r" | "b" | "n">;
export type PendingPromotion = { from: Square; to: Square; color: Color };
export type GameResult = { title: string; message: string } | null;
export type AiStatus = "idle" | "connecting" | "playing" | "gameover" | "error";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function useAiGame() {
  const [status, setStatus] = useState<AiStatus>("idle");
  const [game, setGame] = useState(() => new Chess());
  const [gameId, setGameId] = useState<string | null>(null);
  const [humanColor, setHumanColor] = useState<PlayerColor>("w");
  const [difficulty, setDifficulty] = useState<AiDifficulty>("medium");
  const [selected, setSelected] = useState<Square | null>(null);
  const [moves, setMoves] = useState<string[]>([]);
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null);
  const [hint, setHint] = useState<{ from: Square; to: Square } | null>(null);
  const [hintPending, setHintPending] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [result, setResult] = useState<GameResult>(null);
  const [error, setError] = useState<string | null>(null);

  // Read by the socket listeners (set up once) without going stale.
  const humanColorRef = useRef<PlayerColor>("w");
  const gameIdRef = useRef<string | null>(null);
  const pendingStartRef = useRef<{ difficulty: AiDifficulty; color?: PlayerColor } | null>(null);

  const describeEnd = useCallback((winner: PlayerColor | null, reason: string | null): GameResult => {
    const human = humanColorRef.current;
    const nice = (reason ?? "").toLowerCase().replace(/_/g, " ");
    if (winner === null) {
      return { title: "Draw", message: reason ? `Game drawn (${nice}).` : "The game ended in a draw." };
    }
    const youWon = winner === human;
    return {
      title: youWon ? "You win!" : "You lose",
      message: youWon
        ? `You beat Stockfish${reason ? ` by ${nice}` : ""}.`
        : `Stockfish wins${reason ? ` by ${nice}` : ""}.`,
    };
  }, []);

  useEffect(() => {
    const socket = getAiGameSocket();

    const onReady = () => {
      const start = pendingStartRef.current;
      if (start) {
        socket.emit("ai:new", { difficulty: start.difficulty, color: start.color });
      }
    };

    const onCreated = (payload: AiCreated) => {
      pendingStartRef.current = null;
      gameIdRef.current = payload.gameId;
      humanColorRef.current = payload.humanColor;
      setGameId(payload.gameId);
      setHumanColor(payload.humanColor);
      setDifficulty(payload.difficulty);
      setMoves([]);
      setSelected(null);
      setHint(null);
      setResult(null);
      setThinking(false);
      setGame(new Chess(payload.state.fen));
      setStatus("playing");
    };

    const onMoved = (payload: AiMoved) => {
      setThinking(false);
      setHintPending(false);
      setHint(null);
      setGame(new Chess(payload.state.fen));
      setMoves((prev) => {
        const next = [...prev];
        if (payload.humanMove?.san) next.push(payload.humanMove.san);
        if (payload.botMove?.san) next.push(payload.botMove.san);
        return next;
      });
      if (payload.gameOver) {
        setResult(describeEnd(payload.gameOver.winnerColor, payload.gameOver.reason));
        setStatus("gameover");
      }
    };

    const onRejected = (payload: { reason?: string; state: { fen: string } }) => {
      // Server refused the move: snap back to its authoritative position.
      setThinking(false);
      setHintPending(false);
      setSelected(null);
      if (payload?.state?.fen) setGame(new Chess(payload.state.fen));
    };

    const onGameOver = (payload: {
      winnerColor: PlayerColor | null;
      reason: string | null;
      state?: { fen: string };
    }) => {
      setResult(describeEnd(payload.winnerColor, payload.reason));
      setStatus("gameover");
      setThinking(false);
      setHintPending(false);
      // Resync to the authoritative final position (e.g. on resign/timeout).
      if (payload.state?.fen) setGame(new Chess(payload.state.fen));
    };

    const onHint = (payload: AiHint) => {
      setHintPending(false);
      setHint({ from: payload.from as Square, to: payload.to as Square });
    };

    const onError = (payload?: { code?: string; message?: string }) => {
      pendingStartRef.current = null;
      setError(payload?.message ?? payload?.code ?? "AI game error");
      // Never leave the board locked: clear the waiting flags on any error.
      setThinking(false);
      setHintPending(false);
      setStatus((s) => (s === "connecting" ? "error" : s));
    };

    const onConnectError = () => {
      pendingStartRef.current = null;
      setError("Unable to connect to the server.");
      setStatus("error");
    };

    socket.on("ai:ready", onReady);
    socket.on("ai:created", onCreated);
    socket.on("ai:moved", onMoved);
    socket.on("ai:rejected", onRejected);
    socket.on("ai:gameover", onGameOver);
    socket.on("ai:hint", onHint);
    socket.on("ai:error", onError);
    socket.on("connect_error", onConnectError);

    return () => {
      socket.off("ai:ready", onReady);
      socket.off("ai:created", onCreated);
      socket.off("ai:moved", onMoved);
      socket.off("ai:rejected", onRejected);
      socket.off("ai:gameover", onGameOver);
      socket.off("ai:hint", onHint);
      socket.off("ai:error", onError);
      socket.off("connect_error", onConnectError);
      socket.disconnect();
    };
  }, [describeEnd]);

  const start = useCallback((diff: AiDifficulty, color?: PlayerColor | "random") => {
    const socket = getAiGameSocket();
    setError(null);
    setResult(null);
    setStatus("connecting");
    pendingStartRef.current = {
      difficulty: diff,
      color: color === "random" ? undefined : color,
    };
    if (socket.connected) {
      socket.emit("ai:new", {
        difficulty: diff,
        color: color === "random" ? undefined : color,
      });
    } else {
      socket.connect();
    }
  }, []);

  function submitMove(from: Square, to: Square, promotion?: PromotionPiece) {
    const id = gameIdRef.current;
    if (!id) return;
    try {
      const next = new Chess(game.fen());
      const move = next.move({ from, to, ...(promotion ? { promotion } : {}) });
      if (!move) return;
      // Optimistic: show our own move immediately; the server reply reconciles
      // the board (and adds the bot's answer) a moment later.
      setGame(next);
      setSelected(null);
      setHint(null);
      setThinking(true);
      getAiGameSocket().emit("ai:move", { gameId: id, from, to, promotion });
    } catch {
      /* illegal move - ignore */
    }
  }

  function clickSquare(square: Square) {
    if (status !== "playing" || thinking || pendingPromotion || result) return;
    if (game.turn() !== humanColor) return; // not your turn (bot is to move)

    if (!selected) {
      const piece = game.get(square);
      if (piece?.color === humanColor) setSelected(square);
      return;
    }
    const target = game.get(square);
    if (target?.color === humanColor) {
      setSelected(square);
      return;
    }
    const piece = game.get(selected);
    const promoting =
      piece?.type === "p" &&
      ((piece.color === "w" && square.endsWith("8")) ||
        (piece.color === "b" && square.endsWith("1")));
    if (
      promoting &&
      game.moves({ square: selected, verbose: true }).some((m) => m.to === square && Boolean(m.promotion))
    ) {
      setPendingPromotion({ from: selected, to: square, color: piece!.color });
      setSelected(null);
      return;
    }
    submitMove(selected, square);
  }

  // Drag-and-drop entry point: given a from/to, behaves like a click-move
  // (turn/ownership checks + promotion dialog), then submits.
  function movePiece(from: Square, to: Square) {
    if (status !== "playing" || thinking || pendingPromotion || result) return;
    if (game.turn() !== humanColor) return;

    const piece = game.get(from);
    if (!piece || piece.color !== humanColor) return;

    const promoting =
      piece.type === "p" &&
      ((piece.color === "w" && to.endsWith("8")) ||
        (piece.color === "b" && to.endsWith("1")));
    if (
      promoting &&
      game.moves({ square: from, verbose: true }).some((m) => m.to === to && Boolean(m.promotion))
    ) {
      setPendingPromotion({ from, to, color: piece.color });
      setSelected(null);
      return;
    }
    submitMove(from, to);
  }

  function promote(piece: PromotionPiece) {
    if (!pendingPromotion) return;
    submitMove(pendingPromotion.from, pendingPromotion.to, piece);
    setPendingPromotion(null);
  }

  function cancelPromotion() {
    setPendingPromotion(null);
  }

  const requestHint = useCallback(() => {
    const id = gameIdRef.current;
    if (!id || hintPending) return; // one hint at a time (don't spam the engine)
    setHintPending(true);
    getAiGameSocket().emit("ai:hint", { gameId: id });
  }, [hintPending]);

  const resign = useCallback(() => {
    const id = gameIdRef.current;
    if (!id) return;
    getAiGameSocket().emit("ai:resign", { gameId: id });
  }, []);

  const leave = useCallback(() => {
    // Tell the server to abandon the game so it isn't left orphaned in RAM / DB.
    const id = gameIdRef.current;
    if (id) getAiGameSocket().emit("ai:leave", { gameId: id });
    pendingStartRef.current = null;
    gameIdRef.current = null;
    setStatus("idle");
    setGameId(null);
    setSelected(null);
    setHint(null);
    setHintPending(false);
    setResult(null);
    setThinking(false);
    setMoves([]);
    setGame(new Chess(START_FEN));
  }, []);

  const myTurn = status === "playing" && !thinking && game.turn() === humanColor;

  return {
    status,
    game,
    board: game.board(),
    gameId,
    humanColor,
    difficulty,
    selected,
    moves,
    pendingPromotion,
    hint,
    hintPending,
    thinking,
    result,
    error,
    myTurn,
    start,
    clickSquare,
    movePiece,
    promote,
    cancelPromotion,
    requestHint,
    resign,
    leave,
  };
}
