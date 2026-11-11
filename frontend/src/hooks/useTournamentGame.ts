import { useEffect, useState } from "react";
import {
  getGameSocket,
  type GameJoined,
  type FinishedGame,
} from "../services/socket";

type TournamentGameState = {
  joined: GameJoined | null;
  restoring: boolean;
  error: string | null;
  finished: FinishedGame | null;
};

export function useTournamentGame(gameId: string | undefined) {
  const [state, setState] = useState<TournamentGameState>({
    joined: null,
    restoring: true,
    error: null,
    finished: null,
  });

  useEffect(() => {
    if (!gameId) {
      setState({
        joined: null,
        restoring: false,
        error: "Missing game ID",
        finished: null,
      });
      return;
    }

    const socket = getGameSocket();
    let active = true;

    setState({
      joined: null,
      restoring: true,
      error: null,
      finished: null,
    });

    const onReady = () => {
      if (!active) return;
      socket.emit("game:join", { gameId });
    };

    const onJoined = (joined: GameJoined) => {
      if (!active || joined.gameId !== gameId) return;

      setState({
        joined,
        restoring: false,
        error: null,
        finished: null,
      });
    };

    const onFinished = (finished: FinishedGame) => {
      if (!active || finished.gameId !== gameId) return;

      setState((previous) => ({
        ...previous,
        joined: null,
        error: null,
        restoring: false,
        finished,
      }));
    };

    const onDisconnect = () => {
      if (!active) return;

      setState((previous) => ({
        ...previous,
        restoring: true,
      }));
    };

    const onError = (payload?: { code?: string }) => {
      if (!active) return;

      setState((previous) => ({
        ...previous,
        restoring: false,
        error: payload?.code ?? "Unable to join game",
      }));
    };

    const onConnectError = () => {
      if (!active) return;

      setState((previous) => ({
        ...previous,
        restoring: true,
        error: "Unable to connect to game server",
      }));
    };

    socket.on("game:ready", onReady);
    socket.on("game:joined", onJoined);
    socket.on("game:finished", onFinished);
    socket.on("game:error", onError);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);

    if (socket.connected) {
      socket.emit("game:join", { gameId });
    } else {
      socket.connect();
    }

    return () => {
      active = false;

      socket.off("game:ready", onReady);
      socket.off("game:joined", onJoined);
      socket.off("game:finished", onFinished);
      socket.off("game:error", onError);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);

      if (socket.connected) {
        socket.emit("game:leave", { gameId });
      }

      socket.disconnect();
    };
  }, [gameId]);

  return state;
}
