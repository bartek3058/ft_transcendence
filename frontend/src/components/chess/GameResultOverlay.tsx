import * as React from "react";

type GameResultOverlayProps = {
  title: string;
  message: string;
  onPlayAgain: () => void;
  playAgainLabel?: string;
};

export function GameResultOverlay({
  title,
  message,
  onPlayAgain,
  playAgainLabel = "Play again",
}: GameResultOverlayProps) {
  const [dismissed, setDismissed] = React.useState(false);


  if (dismissed) return null;

  return (
    <div
      className="resultOverlay"
      onClick={() => setDismissed(true)}
    >
      <div
        className="resultDialog"
        role="dialog"
        aria-label="Game result"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="resultClose"
          aria-label="Close result"
          onClick={() => setDismissed(true)}
        >
          ×
        </button>

        <div className="resultIcon">♛</div>
        <h2>{title}</h2>
        <p>{message}</p>

        <button
          type="button"
          className="primary resultButton"
          onClick={onPlayAgain}
        >
          {playAgainLabel}
        </button>
      </div>
    </div>
  );
}
