import { Clock, Trophy, Users } from "lucide-react";
import { Page } from "../components/ui/Page";
import { tournaments } from "../data/mockData";
export function TournamentsPage() {
  return (
    <Page
      title="Tournaments"
      sub="Join the competition and climb the leaderboard"
    >
      <div className="grid">
        {tournaments.map((t, i) => (
          <div className="card tournament" key={t.name}>
            <Trophy />
            <small>{t.mode}</small>
            <h3>{t.name}</h3>
            <p>
              <Users size={15} />
              {t.players}
            </p>
            <p>
              <Clock size={15} />
              {t.startsAt}
            </p>
            <button className="primary">{i ? "View details" : "Join"}</button>
          </div>
        ))}
      </div>
    </Page>
  );
}
