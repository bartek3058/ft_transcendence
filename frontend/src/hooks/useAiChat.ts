import { useCallback, useState } from "react";
import type { ChatMessage } from "../types";
import { api } from "../services/api";

export type ChatMode = "coach" | "commentator" | "rival" | "casual";

export const CHAT_MODES: { value: ChatMode; label: string }[] = [
  { value: "coach", label: "Coach" },
  { value: "commentator", label: "Commentator" },
  { value: "rival", label: "Rival" },
  { value: "casual", label: "Casual" },
];

type GameContext = { fen?: string; moves?: string[]; turn?: "w" | "b" };

/**
 * AI chat panel state. Talks to POST /api/ai/chat in the selected persona, with
 * optional live game context (FEN + moves) so coach/commentator modes can talk
 * about the actual position. History is sent so the model keeps the thread.
 */
export function useAiChat(getContext?: () => GameContext) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<ChatMode>("coach");
  const [sending, setSending] = useState(false);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;

    // Prior turns become the history (before we add this one).
    const history = messages.map((m) => ({
      role: m.user === "You" ? "user" : "assistant",
      content: m.text,
    }));

    setMessages((v) => [...v, { id: crypto.randomUUID(), user: "You", text }]);
    setDraft("");
    setSending(true);

    const ctx = getContext?.() ?? {};
    try {
      const { reply } = await api<{ reply: string }>("/ai/chat", {
        method: "POST",
        body: JSON.stringify({
          mode,
          message: text,
          history,
          fen: ctx.fen,
          moves: ctx.moves,
          turn: ctx.turn,
        }),
      });
      setMessages((v) => [...v, { id: crypto.randomUUID(), user: "AI", text: reply }]);
    } catch {
      setMessages((v) => [
        ...v,
        { id: crypto.randomUUID(), user: "AI", text: "⚠️ AI chat is unavailable right now." },
      ]);
    } finally {
      setSending(false);
    }
  }, [draft, sending, messages, mode, getContext]);

  return { messages, draft, setDraft, send, mode, setMode, sending };
}
