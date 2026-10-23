import { BarChart3, Swords, Trophy } from "lucide-react";
import { Page } from "../components/ui/Page";
import { games } from "../data/mockData";

export function HistoryPage() {
  return (
    <Page title="Game History" sub="Your recent results and rating changes.">
      <div className="stats">
        <div className="card">
          <BarChart3 />
          <b>1542</b>
          <small>Current ELO</small>
        </div>
        <div className="card">
          <Swords />
          <b>58%</b>
          <small>Wins</small>
        </div>
        <div className="card">
          <Trophy />
          <b>126</b>
          <small>Games</small>
        </div>
      </div>
      <div className="card table games">
        {games.map((g, i) => (
          <div key={i}>
            <b>
              {g.white} <span>vs</span> {g.black}
            </b>
            <small>{g.mode}</small>
            <strong>{g.result}</strong>
            <em className={g.elo.startsWith("-") ? "loss" : "win"}>
              {g.elo} ELO
            </em>
          </div>
        ))}
      </div>
    </Page>
  );
}
