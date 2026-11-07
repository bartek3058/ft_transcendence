import { useCallback, useEffect, useRef, useState } from "react";
import {
  getGameSocket,
  getMatchmakingSocket,
  joinGameRoom,
  type GameJoined,
  type MatchFound,
} from "../services/socket";

type MatchmakingStatus = "idle" | "connecting" | "queued" | "matched" | "error";

export function useMatchmaking() {
  const [status, setStatus] = useState<MatchmakingStatus>("idle");
  const [gameId, setGameId] = useState<string | null>(null);
  const [game, setGame] = useState<GameJoined | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readyRef = useRef(false);
  const wantsToSearchRef = useRef(false);

  useEffect(() => {
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
      setGameId(match.gameId);
      joinGameRoom(match.gameId);
    };

    const onGameJoined = (joined: GameJoined) => {
      setGame(joined);
      setStatus("matched");
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

    gameSocket.on("game:joined", onGameJoined);
    const onGameError = (payload?: { code?: string }) => {
      if (
        [
          "UNAUTHENTICATED",
          "GAME_NOT_FOUND",
          "NOT_A_PLAYER",
          "GAME_ID_REQUIRED",
        ].includes(payload?.code ?? "")
      ) {
        onError(payload);
      }
    };
    gameSocket.on("game:error", onGameError);
    gameSocket.on("connect_error", onConnectError);

    return () => {
      matchmaking.off("matchmaking:ready", onReady);
      matchmaking.off("disconnect", onDisconnect);
      matchmaking.off("queue:joined", onJoined);
      matchmaking.off("matched", onMatched);
      matchmaking.off("error", onError);
      matchmaking.off("connect_error", onConnectError);

      gameSocket.off("game:joined", onGameJoined);
      gameSocket.off("game:error", onGameError);
      gameSocket.off("connect_error", onConnectError);

      wantsToSearchRef.current = false;
      readyRef.current = false;

      if (matchmaking.connected) {
        matchmaking.emit("queue:leave");
      }

      matchmaking.disconnect();
      gameSocket.disconnect();
    };
  }, []);

  const search = useCallback(() => {
    const socket = getMatchmakingSocket();

    if (game) {
      getGameSocket().emit("game:leave", { gameId: game.gameId });
    }
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
  }, [game]);

  const cancel = useCallback(() => {
    const socket = getMatchmakingSocket();

    wantsToSearchRef.current = false;

    if (socket.connected && readyRef.current) {
      socket.emit("queue:leave");
    }

    setStatus("idle");
    setGameId(null);
    setGame(null);
    setError(null);
  }, []);

  return {
    status,
    gameId,
    game,
    error,
    search,
    cancel,
  };
}
