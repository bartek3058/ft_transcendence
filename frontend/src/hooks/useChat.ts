import { useCallback, useEffect, useState } from "react";
import type { ChatMessage } from "../types";
import { getGameSocket } from "../services/socket";

interface ServerChatMessage {
  id: string;
  gameId: string;
  userId: string;
  user: string;
  text: string;
  createdAt: number;
}

interface ChatHistoryPayload {
  gameId: string;
  messages: ServerChatMessage[];
}

export function useChat(gameId: string, userId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const socket = getGameSocket();

    const toChatMessage = (message: ServerChatMessage): ChatMessage => ({
      id: message.id,
      user: message.userId === userId ? "You" : message.user,
      text: message.text,
    });

    const onMessage = (message: ServerChatMessage) => {
      if (message.gameId !== gameId) return;

      setMessages((current) => {
        if (current.some((item) => item.id === message.id)) {
          return current;
        }

        return [...current, toChatMessage(message)];
      });
    };

    const onHistory = (payload: ChatHistoryPayload) => {
      if (payload.gameId !== gameId) return;
      setMessages(payload.messages.map(toChatMessage));
    };

    socket.on("game:chat:message", onMessage);
    socket.on("game:chat:history", onHistory);

    socket.emit("game:chat:get-history", { gameId });

    return () => {
      socket.off("game:chat:message", onMessage);
      socket.off("game:chat:history", onHistory);
    };
  }, [gameId, userId]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || sending) return;

    const socket = getGameSocket();

    if (!socket.connected) return;

    setSending(true);

    socket.timeout(5000).emit(
      "game:chat:send",
      { gameId, text },
      (
        error: Error | null,
        reply?: { success: boolean; code?: string },
      ) => {
        setSending(false);

        if (!error && reply?.success) {
          setDraft("");
        } else {
          console.error("Chat message failed:", reply?.code ?? error);
        }
      },
    );
  }, [draft, gameId, sending]);

  return { messages, draft, setDraft, send, sending };
}
