import { useCallback, useEffect, useState } from "react";
import type { ChatMessage, Sentiment } from "../types";
import { api } from "../services/api";

interface ChatResponse {
  reply: string;
  sentiment?: { label: Sentiment; score: number };
  blocked?: boolean;
}

export type ChatMode = "coach" | "commentator" | "rival" | "casual";

export const CHAT_MODES: { value: ChatMode; label: string }[] = [
  { value: "coach", label: "Coach" },
  { value: "commentator", label: "Commentator" },
  { value: "rival", label: "Rival" },
  { value: "casual", label: "Casual" },
];

type GameContext = { fen?: string; moves?: string[]; turn?: "w" | "b" };

type ChatPayload = {
  mode: ChatMode;
  message: string;
  history: { role: string; content: string }[];
  fen?: string;
  moves?: string[];
  turn?: "w" | "b";
};

type FailedRequest = {
  errorMsgId: string;
  userMsgId: string;
  payload: ChatPayload;
};

const STORAGE_KEY = "ai-chat";

function loadPersisted(): { messages: ChatMessage[]; mode: ChatMode } {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as {
        messages?: ChatMessage[];
        mode?: ChatMode;
      };
      return {
        messages: Array.isArray(saved.messages) ? saved.messages : [],
        mode: saved.mode ?? "coach",
      };
    }
  } catch {}
  return { messages: [], mode: "coach" };
}

export function useAiChat(getContext?: () => GameContext) {
  const [restored] = useState(loadPersisted);
  const [messages, setMessages] = useState<ChatMessage[]>(restored.messages);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<ChatMode>(restored.mode);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<FailedRequest | null>(null);

  useEffect(() => {
    try {
      const toSave = messages.filter((m) => !m.error);
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ messages: toSave, mode }),
      );
    } catch {}
  }, [messages, mode]);

  const runRequest = useCallback(
    async (payload: ChatPayload, userMsgId: string) => {
      setSending(true);
      try {
        const res = await api<ChatResponse>("/ai/chat", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (res.sentiment) {
          setMessages((v) =>
            v.map((m) =>
              m.id === userMsgId
                ? { ...m, sentiment: res.sentiment!.label }
                : m,
            ),
          );
        }
        setMessages((v) => [
          ...v,
          { id: crypto.randomUUID(), user: "AI", text: res.reply },
        ]);
        setFailed(null);
      } catch {
        const errorMsgId = crypto.randomUUID();
        setMessages((v) => [
          ...v,
          {
            id: errorMsgId,
            user: "AI",
            text: "⚠️ AI chat is unavailable right now.",
            error: true,
          },
        ]);
        setFailed({ errorMsgId, userMsgId, payload });
      } finally {
        setSending(false);
      }
    },
    [],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;

    const history = messages
      .filter((m) => !m.error)
      .map((m) => ({
        role: m.user === "You" ? "user" : "assistant",
        content: m.text,
      }));

    const mineId = crypto.randomUUID();
    setMessages((v) => [...v, { id: mineId, user: "You", text }]);
    setDraft("");

    const ctx = getContext?.() ?? {};
    await runRequest(
      {
        mode,
        message: text,
        history,
        fen: ctx.fen,
        moves: ctx.moves,
        turn: ctx.turn,
      },
      mineId,
    );
  }, [draft, sending, messages, mode, getContext, runRequest]);

  const retry = useCallback(async () => {
    if (!failed || sending) return;
    const { errorMsgId, userMsgId, payload } = failed;
    setMessages((v) => v.filter((m) => m.id !== errorMsgId));
    setFailed(null);
    await runRequest(payload, userMsgId);
  }, [failed, sending, runRequest]);

  return {
    messages,
    draft,
    setDraft,
    send,
    mode,
    setMode,
    sending,
    retry,
    retryableId: failed?.errorMsgId ?? null,
  };
}
