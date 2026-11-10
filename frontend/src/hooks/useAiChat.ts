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

// Everything we need to (re)send one request to the chat endpoint.
type ChatPayload = {
  mode: ChatMode;
  message: string;
  history: { role: string; content: string }[];
  fen?: string;
  moves?: string[];
  turn?: "w" | "b";
};

// The last request that failed, kept so the user can retry it without retyping.
type FailedRequest = { errorMsgId: string; userMsgId: string; payload: ChatPayload };

/* We stash the thread in sessionStorage so a page refresh doesn't wipe it -
same storage the PvP game uses for its reconnect id. Per-tab and cleared when
the tab closes, which is the behaviour we want for an in-game chat. */
const STORAGE_KEY = "ai-chat";

function loadPersisted(): { messages: ChatMessage[]; mode: ChatMode } {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as { messages?: ChatMessage[]; mode?: ChatMode };
      return {
        messages: Array.isArray(saved.messages) ? saved.messages : [],
        mode: saved.mode ?? "coach",
      };
    }
  } catch {
    /* storage disabled, full, or corrupt JSON - just start empty */
  }
  return { messages: [], mode: "coach" };
}

/*
AI chat panel state. Talks to POST /api/ai/chat in the selected persona, with
optional live game context (FEN + moves) so coach/commentator modes can talk
about the actual position. History is sent so the model keeps the thread.

The backend already retries transient upstream errors, so a failure that
reaches us is a real outage - we surface it as an error bubble and let the
user retry that exact request (backend hiccups do clear up).
*/
export function useAiChat(getContext?: () => GameContext) {
  // Seed from sessionStorage once, so a refresh keeps the conversation.
  const [restored] = useState(loadPersisted);
  const [messages, setMessages] = useState<ChatMessage[]>(restored.messages);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<ChatMode>(restored.mode);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<FailedRequest | null>(null);

  /* Keep sessionStorage in sync with the thread. Error bubbles are UI-only and
  their retry state isn't restored, so we drop them before saving - otherwise a
  refresh would show a dead error with a retry button that does nothing. */
  useEffect(() => {
    try {
      const toSave = messages.filter((m) => !m.error);
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ messages: toSave, mode }));
    } catch {
      /* ignore storage write failures (private mode, quota, etc.) */
    }
  }, [messages, mode]);

  /* Fire one request and reconcile the thread with the result. 'userMsgId' is
  the user's bubble this reply belongs to (so we can tag its sentiment).*/
  const runRequest = useCallback(async (payload: ChatPayload, userMsgId: string) => {
    setSending(true);
    try {
      const res = await api<ChatResponse>("/ai/chat", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      // Tag the user's own message with its sentiment.
      if (res.sentiment) {
        setMessages((v) =>
          v.map((m) => (m.id === userMsgId ? { ...m, sentiment: res.sentiment!.label } : m)),
        );
      }
      setMessages((v) => [...v, { id: crypto.randomUUID(), user: "AI", text: res.reply }]);
      setFailed(null);
    } catch {
      const errorMsgId = crypto.randomUUID();
      setMessages((v) => [
        ...v,
        { id: errorMsgId, user: "AI", text: "⚠️ AI chat is unavailable right now.", error: true },
      ]);
      setFailed({ errorMsgId, userMsgId, payload });
    } finally {
      setSending(false);
    }
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;

    /* Prior turns become the history (before we add this one). Error bubbles are
    UI-only, so they never go to the model. */
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
      { mode, message: text, history, fen: ctx.fen, moves: ctx.moves, turn: ctx.turn },
      mineId,
    );
  }, [draft, sending, messages, mode, getContext, runRequest]);

  // Resend the last failed request as-is, dropping its error bubble first.
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
    // The error bubble that currently offers a retry (null when there's none).
    retryableId: failed?.errorMsgId ?? null,
  };
}
