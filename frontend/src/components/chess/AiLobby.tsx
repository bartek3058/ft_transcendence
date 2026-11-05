import { useState } from "react";
import type { AiDifficulty, PlayerColor } from "../../services/socket";

type ColorChoice = PlayerColor | "random";

interface Props {
  status: "idle" | "connecting" | "error";
  error: string | null;
  onStart: (difficulty: AiDifficulty, color: ColorChoice) => void;
}

const DIFFICULTIES: { value: AiDifficulty; label: string; hint: string }[] = [
  { value: "easy", label: "Easy", hint: "Blunders often" },
  { value: "medium", label: "Medium", hint: "Club player" },
  { value: "hard", label: "Hard", hint: "Full strength" },
];

const COLORS: { value: ColorChoice; label: string }[] = [
  { value: "w", label: "White" },
  { value: "b", label: "Black" },
  { value: "random", label: "Random" },
];

export function AiLobby({ status, error, onStart }: Props) {
  const [difficulty, setDifficulty] = useState<AiDifficulty>("medium");
  const [color, setColor] = useState<ColorChoice>("random");
  const connecting = status === "connecting";

  return (
    <div className="matchmakingCard">
      <div className="matchmakingIcon">🤖</div>
      <h2>Play vs AI</h2>
      <p>Challenge the Stockfish engine. Games against the AI are not rated.</p>

      <div className="aiOptionGroup">
        <span className="aiOptionLabel">Difficulty</span>
        <div className="aiOptions">
          {DIFFICULTIES.map((d) => (
            <button
              key={d.value}
              type="button"
              className={difficulty === d.value ? "aiOption selected" : "aiOption"}
              onClick={() => setDifficulty(d.value)}
              disabled={connecting}
              title={d.hint}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div className="aiOptionGroup">
        <span className="aiOptionLabel">Your colour</span>
        <div className="aiOptions">
          {COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              className={color === c.value ? "aiOption selected" : "aiOption"}
              onClick={() => setColor(c.value)}
              disabled={connecting}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {status === "error" && <p className="aiError">{error ?? "Something went wrong."}</p>}

      <button
        type="button"
        className="primary"
        onClick={() => onStart(difficulty, color)}
        disabled={connecting}
      >
        {connecting ? "Starting…" : "Start game"}
      </button>
    </div>
  );
}
