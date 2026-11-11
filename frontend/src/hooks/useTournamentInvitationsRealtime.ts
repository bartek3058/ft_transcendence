import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

export type InvitationConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected";

export function useTournamentInvitationsRealtime(
  onUpdate: () => void
): InvitationConnectionStatus {
  const [status, setStatus] =
    useState<InvitationConnectionStatus>("connecting");

  const callbackRef = useRef(onUpdate);

  useEffect(() => {
    callbackRef.current = onUpdate;
  }, [onUpdate]);

  useEffect(() => {
    let active = true;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;

    const socket = io("/tournaments", {
      path: "/socket.io",
      transports: ["websocket"],
      withCredentials: true,
      auth: { csrf: "1" },
      forceNew: true,
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    const scheduleUpdate = () => {
      clearTimeout(updateTimer);

      updateTimer = setTimeout(() => {
        if (active) callbackRef.current();
      }, 200);
    };

    const handleReady = () => {
      if (!active) return;
      setStatus("connected");
      scheduleUpdate();
    };

    const handleConnect = () => {
      if (!active) return;
      setStatus("connected");
      scheduleUpdate();
    };

    const handleDisconnect = () => {
      if (!active) return;
      setStatus("disconnected");
    };

    const handleConnectError = (error: Error) => {
      if (!active) return;
      console.warn(
        "Tournament invitations connection error:",
        error.message
      );
      setStatus("disconnected");
    };

    const handleInvitationReceived = () => {
      scheduleUpdate();
    };

    const handleInvitationAnswered = () => {
      scheduleUpdate();
    };

    socket.on("tournament:ready", handleReady);
    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);

    socket.on(
      "tournament:invitation_received",
      handleInvitationReceived
    );

    socket.on(
      "tournament:invitation_answered",
      handleInvitationAnswered
    );

    setStatus("connecting");
    const connectTimer = window.setTimeout(() => {
      if (active) socket.connect();
    }, 0);

    const handleFocus = () => {
      scheduleUpdate();

      if (!socket.connected && !socket.active) {
        socket.connect();
      }
    };

    window.addEventListener("focus", handleFocus);

    return () => {
      active = false;
      window.clearTimeout(connectTimer);
      clearTimeout(updateTimer);
      window.removeEventListener("focus", handleFocus);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, []);

  return status;
}
