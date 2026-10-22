import { Page } from "../components/ui/Page";
import { ranking } from "../data/mockData";
export function RankingPage() {
  return (
    <Page title="ELO Ranking" sub="The best players on the platform.">
      <div className="card table">
        {ranking.map(([name, elo], i) => (
          <div key={name}>
            <strong>#{i + 1}</strong>
            <span className="avatar small">{name[0]}</span>
            <b>{name}</b>
            <em>{elo}</em>
          </div>
        ))}
      </div>
    </Page>
  );
}
