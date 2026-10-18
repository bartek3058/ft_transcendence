import { useState } from "react";
import type { ChatMessage } from "../types";
export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "1", user: "Alicja", text: "Powodzenia! 👋" },
    { id: "2", user: "Ty", text: "Dzięki, wzajemnie!" },
  ]);
  const [draft, setDraft] = useState("");
  function send() {
    const text = draft.trim();
    if (!text) return;
    setMessages((v) => [...v, { id: crypto.randomUUID(), user: "Ty", text }]);
    setDraft("");
  }
  return { messages, draft, setDraft, send };
}
