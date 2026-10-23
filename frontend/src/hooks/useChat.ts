import { useState } from "react";
import type { ChatMessage } from "../types";

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "1", user: "Alice", text: "Good luck! 👋" },
    { id: "2", user: "You", text: "Thanks, you too!" },
  ]);
  const [draft, setDraft] = useState("");

  function send() {
    const text = draft.trim();
    if (!text) return;
    setMessages((v) => [...v, { id: crypto.randomUUID(), user: "You", text }]);
    setDraft("");
  }

  return { messages, draft, setDraft, send };
}
