import { useCallback, useEffect, useRef, useState } from "react";
import {
  getGameSocket,
  getMatchmakingSocket,
  joinGameRoom,
  type GameJoined,
  type FinishedGame,
  type MatchFound,
} from "../services/socket";
import { useAuth } from "../context/AuthContext";

type MatchmakingStatus =
  | "idle"
  | "restoring"
  | "connecting"
  | "queued"
  | "matched"
  | "finished"
  | "error";

export function useMatchmaking() {
  const { user } = useAuth();
  const storageKey = user ? `chesshub:last-game:${user.id}` : null;
  const [status, setStatus] = useState<MatchmakingStatus>("restoring");
  const [gameId, setGameId] = useState<string | null>(null);
  const [game, setGame] = useState<GameJoined | null>(null);
  const [finishedGame, setFinishedGame] = useState<FinishedGame | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readyRef = useRef(false);
  const gameReadyRef = useRef(false);
  const activeGameIdRef = useRef<string | null>(null);
  const gameRef = useRef<GameJoined | null>(null);
  const wantsToSearchRef = useRef(false);

  useEffect(() => {
    if (!storageKey) return;
    activeGameIdRef.current = sessionStorage.getItem(storageKey);
    const matchmaking = getMatchmakingSocket();
    const gameSocket = getGameSocket();

    const joinQueue = () => {
      matchmaking.emit("queue:join", {
        timeControl: "rapid_10_0",
      });
    };

    const onReady = () => {
      readyRef.current = true;

      if (wantsToSearchRef.current) {
        joinQueue();
      }
    };

    const onDisconnect = () => {
      readyRef.current = false;
    };

    const onJoined = () => {
      setStatus("queued");
    };

    const onMatched = (match: MatchFound) => {
      wantsToSearchRef.current = false;
      activeGameIdRef.current = match.gameId;
      sessionStorage.setItem(storageKey, match.gameId);
      setFinishedGame(null);
      setGameId(match.gameId);
      if (gameSocket.connected && gameReadyRef.current) {
        joinGameRoom(match.gameId);
      }
    };

    const onGameJoined = (joined: GameJoined) => {
      activeGameIdRef.current = joined.gameId;
      sessionStorage.setItem(storageKey, joined.gameId);
      gameRef.current = joined;
      setFinishedGame(null);
      setGameId(joined.gameId);
      setGame(joined);
      setError(null);
      setStatus("matched");
    };

    const onGameFinished = (finished: FinishedGame) => {
      if (finished.gameId !== activeGameIdRef.current) return;
      sessionStorage.removeItem(storageKey);
      activeGameIdRef.current = null;
      gameRef.current = null;
      setGame(null);
      setGameId(finished.gameId);
      setFinishedGame(finished);
      setError(null);
      setStatus("finished");
    };

    const onError = (payload?: { code?: string }) => {
      wantsToSearchRef.current = false;
      setError(payload?.code ?? "WebSocket connection error");
      setStatus("error");
    };

    const onConnectError = () => {
      wantsToSearchRef.current = false;
      setError("Unable to connect to the server.");
      setStatus("error");
    };

    matchmaking.on("matchmaking:ready", onReady);
    matchmaking.on("disconnect", onDisconnect);
    matchmaking.on("queue:joined", onJoined);
    matchmaking.on("matched", onMatched);
    matchmaking.on("error", onError);
    matchmaking.on("connect_error", onConnectError);

    const onGameReady = () => {
      gameReadyRef.current = true;
      if (activeGameIdRef.current) {
        gameSocket.emit("game:join", { gameId: activeGameIdRef.current });
      } else {
        gameSocket.emit("game:resume");
      }
    };
    const onNoActiveGame = () => {
      if (activeGameIdRef.current) return; // game:join will resolve this ID
      setStatus((current) => (current === "restoring" ? "idle" : current));
    };
    const onGameDisconnect = () => {
      gameReadyRef.current = false;
      if (activeGameIdRef.current) setStatus("restoring");
    };
    gameSocket.on("game:ready", onGameReady);
    gameSocket.on("game:no-active", onNoActiveGame);
    gameSocket.on("disconnect", onGameDisconnect);
    gameSocket.on("game:joined", onGameJoined);
    gameSocket.on("game:finished", onGameFinished);
    const onGameError = (payload?: { code?: string }) => {
      if (payload?.code === "GAME_NOT_FOUND") {
        sessionStorage.removeItem(storageKey);
        activeGameIdRef.current = null;
      }
      if (
        [
          "UNAUTHENTICATED",
          "GAME_NOT_FOUND",
          "GAME_RESULT_LOOKUP_FAILED",
          "NOT_A_PLAYER",
          "GAME_ID_REQUIRED",
        ].includes(payload?.code ?? "")
      ) {
        onError(payload);
      }
    };
    gameSocket.on("game:error", onGameError);
    gameSocket.on("connect_error", onConnectError);

    const connectTimer = window.setTimeout(() => {
      gameSocket.connect();
    }, 0);

    return () => {
      window.clearTimeout(connectTimer);
      matchmaking.off("matchmaking:ready", onReady);
      matchmaking.off("disconnect", onDisconnect);
      matchmaking.off("queue:joined", onJoined);
      matchmaking.off("matched", onMatched);
      matchmaking.off("error", onError);
      matchmaking.off("connect_error", onConnectError);

      gameSocket.off("game:ready", onGameReady);
      gameSocket.off("game:no-active", onNoActiveGame);
      gameSocket.off("disconnect", onGameDisconnect);
      gameSocket.off("game:joined", onGameJoined);
      gameSocket.off("game:finished", onGameFinished);
      gameSocket.off("game:error", onGameError);
      gameSocket.off("connect_error", onConnectError);

      wantsToSearchRef.current = false;
      readyRef.current = false;
      gameReadyRef.current = false;

      if (matchmaking.connected) {
        matchmaking.emit("queue:leave");
      }

      matchmaking.disconnect();
      gameSocket.disconnect();
    };
  }, [storageKey]);

  const search = useCallback(() => {
    const socket = getMatchmakingSocket();

    if (gameRef.current) {
      getGameSocket().emit("game:leave", { gameId: gameRef.current.gameId });
    }
    if (storageKey) sessionStorage.removeItem(storageKey);
    activeGameIdRef.current = null;
    gameRef.current = null;
    setFinishedGame(null);
    setError(null);
    setGame(null);
    setGameId(null);
    setStatus("connecting");

    wantsToSearchRef.current = true;

    if (socket.connected && readyRef.current) {
      socket.emit("queue:join", {
        timeControl: "rapid_10_0",
      });

      return;
    }

    if (!socket.connected) {
      socket.connect();
    }
  }, [storageKey]);

  const cancel = useCallback(() => {
    const socket = getMatchmakingSocket();

    wantsToSearchRef.current = false;

    if (socket.connected && readyRef.current) {
      socket.emit("queue:leave");
    }

    setStatus("idle");
    if (storageKey) sessionStorage.removeItem(storageKey);
    activeGameIdRef.current = null;
    setFinishedGame(null);
    gameRef.current = null;
    setGameId(null);
    setGame(null);
    setError(null);
  }, [storageKey]);

  return {
    status,
    gameId,
    game,
    finishedGame,
    error,
    search,
    cancel,
  };
}
