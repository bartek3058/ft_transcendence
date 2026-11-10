import type { TournamentParticipant } from "../../services/tournaments";

type Props = {
  participants: TournamentParticipant[];
};

export function TournamentPodium({ participants }: Props) {
  const champion = participants.find((p) => p.finalRank === 1);
  const runnerUp = participants.find((p) => p.finalRank === 2);
  const semifinalists = participants.filter((p) => p.finalRank === 3);

  if (!champion && !runnerUp && semifinalists.length === 0) {
    return null;
  }

  return (
    <section className="tournament-section tournament-podium-section">
      <div className="tournament-section-heading">
        <div>
          <span className="tournament-eyebrow">RESULTS</span>
          <h2>Tournament podium</h2>
        </div>
        <span className="tournament-count">Final standings</span>
      </div>

      <div className="tournament-podium">
        {runnerUp && (
          <div className="tournament-podium-place tournament-podium-silver">
            <span className="tournament-podium-medal">🥈</span>
            <span className="tournament-podium-rank">2ND PLACE</span>
            <div className="tournament-podium-avatar">
              {runnerUp.username.charAt(0).toUpperCase()}
            </div>
            <strong className="tournament-podium-name">
              {runnerUp.username}
            </strong>
            <span className="tournament-podium-description">
              Runner-up
            </span>
            <div className="tournament-podium-base">2</div>
          </div>
        )}

        {champion && (
          <div className="tournament-podium-place tournament-podium-gold">
            <span className="tournament-podium-medal">🏆</span>
            <span className="tournament-podium-rank">CHAMPION</span>
            <div className="tournament-podium-avatar">
              {champion.username.charAt(0).toUpperCase()}
            </div>
            <strong className="tournament-podium-name">
              {champion.username}
            </strong>
            <span className="tournament-podium-description">
              Tournament winner
            </span>
            <div className="tournament-podium-base">1</div>
          </div>
        )}

        {semifinalists.length > 0 && (
          <div className="tournament-podium-place tournament-podium-bronze">
            <span className="tournament-podium-medal">🥉</span>
            <span className="tournament-podium-rank">3RD PLACE</span>
            <div className="tournament-podium-bronze-players">
              {semifinalists.map((player) => (
                <div
                  className="tournament-podium-bronze-player"
                  key={player.userId}
                >
                  <div className="tournament-podium-avatar">
                    {player.username.charAt(0).toUpperCase()}
                  </div>
                  <strong className="tournament-podium-name">
                    {player.username}
                  </strong>
                </div>
              ))}
            </div>
            <span className="tournament-podium-description">
              Semifinalists
            </span>
            <div className="tournament-podium-base">3</div>
          </div>
        )}
      </div>
    </section>
  );
}
