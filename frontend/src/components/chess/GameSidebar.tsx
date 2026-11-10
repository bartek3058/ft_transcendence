import {
  CircleDot,
  Flag,
  History,
  MessageCircle,
  RotateCcw,
  Send,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { ChatMessage } from "../../types";

type Props = {
  gameId: string;
  moves: string[];
  messages: ChatMessage[];
  draft: string;
  setDraft: (v: string) => void;
  send: () => void;
  onNewGame: () => void;
  newGameLabel?: string;
  onResign: () => void;
  // Optional AI-chat controls. When onModeChange is given, a persona selector is
  // shown above the chat; `sending` disables input while the AI is replying.
  mode?: string;
  modes?: { value: string; label: string }[];
  onModeChange?: (mode: string) => void;
  sending?: boolean;
};

export function GameSidebar({
  gameId,
  moves,
  messages,
  draft,
  setDraft,
  send,
  onNewGame,
  newGameLabel = "New game",
  onResign,
  mode,
  modes,
  onModeChange,
  sending = false,
}: Props) {
  const chatBodyRef = useRef<HTMLDivElement>(null);

  // Keep the chat pinned to the latest message as new ones arrive.
  useEffect(() => {
    const el = chatBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <aside>
      <div className="card gameRoomCard">
        <div className="gameRoomInfo">
          <CircleDot size={16} />
          <span>Game room</span>
          <strong>{gameId.slice(0, 8)}</strong>
        </div>
      </div>

      <div className="card moves">
        <div className="cardTitle">
          <History size={18} /> Moves <span>{moves.length}</span>
        </div>
        <div className="moveList">
          {moves.length ? (
            Array.from({ length: Math.ceil(moves.length / 2) }, (_, i) => (
              <div key={i}>
                <em>{i + 1}.</em>
                <span>{moves[i * 2]}</span>
                <span>{moves[i * 2 + 1] || ""}</span>
              </div>
            ))
          ) : (
            <p className="muted">
              Click a piece, then the destination square. Move legality is
              checked by chess.js.
            </p>
          )}
        </div>
      </div>

      <div className="card chat">
        <div className="cardTitle">
          <MessageCircle size={18} /> Chat
          {onModeChange && (
            <select
              className="chatMode"
              value={mode}
              onChange={(e) => onModeChange(e.target.value)}
            >
              {(modes ?? []).map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="chatBody" ref={chatBodyRef}>
          {messages.map((m) => (
            <div
              key={m.id}
              className={m.user === "You" || m.user === "Ty" ? "msg mineMsg" : "msg"}
            >
              <b>{m.user}</b>
              <span>{m.text}</span>
              {m.sentiment && (
                <span className="msgMood" title={`sentiment: ${m.sentiment}`}>
                  {m.sentiment === "positive" ? "🙂" : m.sentiment === "negative" ? "🙁" : "😐"}
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="chatInput">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder={sending ? "AI is replying…" : "Write a message…"}
            disabled={sending}
          />
          <button onClick={send} aria-label="Send" disabled={sending}>
            <Send size={17} />
          </button>
        </div>
      </div>

      <div className="actions sidebarActions">
        <button onClick={onNewGame}>
          <RotateCcw size={16} /> {newGameLabel}
        </button>
        <button onClick={onResign}>
          <Flag size={16} /> Resign
        </button>
      </div>
    </aside>
  );
}
