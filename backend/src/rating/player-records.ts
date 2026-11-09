import { PrismaService } from '../database/prisma.service';
import { AI_BOT_USER_ID } from '../ai/ai.constants';

//Results that count towards a player's record (IN_PROGRESS and ABORTED excluded)
export const FINISHED_RESULTS = ['WHITE_WON', 'BLACK_WON', 'DRAW'] as const;

export interface PlayerRecord {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
}

export function emptyRecord(): PlayerRecord {
  return { games: 0, wins: 0, losses: 0, draws: 0, winRate: 0 };
}

export function winRateOf(wins: number, games: number): number {
  return games > 0 ? Number(((wins / games) * 100).toFixed(1)) : 0;
}

/*
Win/loss/draw records for a bounded set of players, aggregated in PostgreSQL
(two GROUP BY queries) instead of loading every game row into Node memory.
*/
export async function loadPlayerRecords(
  prisma: PrismaService,
  userIds: string[],
): Promise<Map<string, PlayerRecord>> {
  const records = new Map<string, PlayerRecord>(userIds.map((id) => [id, emptyRecord()]));
  if (userIds.length === 0) return records;

  const finished = { in: [...FINISHED_RESULTS] };
  const [asWhite, asBlack] = await Promise.all([
    /*Games against the AI bot are excluded, so playing the AI
    never pads a player's win/loss record. They still appear in match history*/
    prisma.game.groupBy({
      by: ['whiteId', 'result'],
      where: { whiteId: { in: userIds }, blackId: { not: AI_BOT_USER_ID }, result: finished },
      _count: { _all: true },
    }),
    prisma.game.groupBy({
      by: ['blackId', 'result'],
      where: { blackId: { in: userIds }, whiteId: { not: AI_BOT_USER_ID }, result: finished },
      _count: { _all: true },
    }),
  ]);

  const add = (userId: string | null, result: string, winningResult: string, count: number) => {
    const record = userId ? records.get(userId) : undefined;
    if (!record) return;
    record.games += count;
    if (result === 'DRAW') record.draws += count;
    else if (result === winningResult) record.wins += count;
    else record.losses += count;
  };

  for (const row of asWhite) add(row.whiteId, row.result, 'WHITE_WON', row._count._all);
  for (const row of asBlack) add(row.blackId, row.result, 'BLACK_WON', row._count._all);

  for (const record of records.values()) record.winRate = winRateOf(record.wins, record.games);
  return records;
}
