import { Flag, History, MessageCircle, RotateCcw, Send } from "lucide-react";
import type { ChatMessage } from "../../types";
type Props = {
  moves: string[];
  messages: ChatMessage[];
  draft: string;
  setDraft: (v: string) => void;
  send: () => void;
  onNewGame: () => void;
  onResign: () => void;
};
export function GameSidebar({
  moves,
  messages,
  draft,
  setDraft,
  send,
  onNewGame,
  onResign,
}: Props) {
  return (
    <aside>
      <div className="card moves">
        <div className="cardTitle">
          <History size={18} /> Ruchy <span>{moves.length}</span>
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
              Kliknij figurę, a potem pole docelowe. Legalność ruchów sprawdza
              chess.js.
            </p>
          )}
        </div>
      </div>
      <div className="card chat">
        <div className="cardTitle">
          <MessageCircle size={18} /> Czat
        </div>
        <div className="chatBody">
          {messages.map((m) => (
            <div key={m.id} className={m.user === "Ty" ? "msg mineMsg" : "msg"}>
              <b>{m.user}</b>
              <span>{m.text}</span>
            </div>
          ))}
        </div>
        <div className="chatInput">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Napisz wiadomość…"
          />
          <button onClick={send} aria-label="Wyślij">
            <Send size={17} />
          </button>
        </div>
      </div>
      <div className="actions sidebarActions">
        <button onClick={onNewGame}>
          <RotateCcw size={16} /> Nowa partia
        </button>
        <button onClick={onResign}>
          <Flag size={16} /> Poddaj
        </button>
      </div>
    </aside>
  );
}
