
import { useEffect, useState } from "react";
import { io } from "socket.io-client";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

type SubscribeAck =
  | { ok: true }
  | { ok: false; error: { code: string } };

const UPDATE_EVENTS = [
  "tournament:participant_joined",
  "tournament:participant_left",
  "tournament:registration_closed",
  "tournament:started",
  "tournament:cancelled",
  "tournament:match_updated",
  "tournament:finished",
] as const;

export function useTournamentRealtime(
  tournamentId: string | undefined,
  enabled: boolean,
  onUpdate: () => void
) {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");

  useEffect(() => {
    if (!enabled || !tournamentId) {
      setStatus("disconnected");
      return;
    }

    let active = true;
    let subscribed = false;
    let revisionTimer: ReturnType<typeof setTimeout> | undefined;

    const socket = io("/tournaments", {
      path: "/socket.io",
      transports: ["websocket"],
      withCredentials: true,
      auth: { csrf: "1" },
      forceNew: true,
      autoConnect: false,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    const scheduleUpdate = () => {
      clearTimeout(revisionTimer);
      revisionTimer = setTimeout(() => {
        if (active) onUpdate();
      }, 200);
    };

    const handleReady = async () => {
      subscribed = false;

      try {
        const ack = (await socket
          .timeout(5000)
          .emitWithAck("tournament:subscribe", {
            tournamentId,
          })) as SubscribeAck;

        if (!active) return;

        if (!ack.ok) {
          console.warn(
            "Tournament subscription rejected:",
            ack.error.code
          );
          setStatus("disconnected");
          scheduleUpdate();
          return;
        }

        subscribed = true;
        setStatus("connected");
        scheduleUpdate();
      } catch (error) {
        if (active) {
          console.error("Tournament subscription failed:", error);
          setStatus("disconnected");
        }
      }
    };

    const handleDisconnect = () => {
      subscribed = false;
      if (active) setStatus("disconnected");
    };

    const handleConnectError = (error: Error) => {
      if (active) {
        console.warn("Tournament connection error:", error.message);
        setStatus("disconnected");
      }
    };

    const handleEvent = (payload: { tournamentId?: string }) => {
      if (payload?.tournamentId === tournamentId) {
        scheduleUpdate();
      }
    };

    socket.on("tournament:ready", () => {
      void handleReady();
    });

    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);

    UPDATE_EVENTS.forEach((event) => {
      socket.on(event, handleEvent);
    });

    setStatus("connecting");
    const connectTimer = window.setTimeout(() => {
      if (active) socket.connect();
    }, 0);

    const onFocus = () => {
      scheduleUpdate();

      if (!socket.connected && !socket.active) {
        socket.connect();
      }
    };

    window.addEventListener("focus", onFocus);

    return () => {
      active = false;
      window.clearTimeout(connectTimer);
      clearTimeout(revisionTimer);
      window.removeEventListener("focus", onFocus);

      if (subscribed && socket.connected) {
        socket.emit("tournament:unsubscribe", { tournamentId });
      }

      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [tournamentId, enabled, onUpdate]);

  return status;
}
