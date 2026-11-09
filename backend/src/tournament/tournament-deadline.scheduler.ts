import { HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { TournamentLifecycleService } from './tournament-lifecycle.service';

export const DEADLINE_SCHEDULER_INTERVAL_MS = 60_000;
// after this many failed starts the tournament is cancelled
export const MAX_START_ATTEMPTS = 5;

export interface SchedulerTickResult {
  skipped: boolean;
  closed: number;
  restarted: number;
  failed: number;
  cancelled: number;
}

// Closes expired registrations and retries stuck starts. Failure counts are in memory only.
@Injectable()
export class TournamentDeadlineScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TournamentDeadlineScheduler.name);
  private readonly failures = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private isExecuting = false;

  constructor(private readonly prisma: PrismaService,
    private readonly lifecycle: TournamentLifecycleService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.tick(); }, DEADLINE_SCHEDULER_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<SchedulerTickResult> {
    const result: SchedulerTickResult = { skipped: false, closed: 0, restarted: 0, failed: 0, cancelled: 0 };
    if (this.isExecuting) return { ...result, skipped: true };
    this.isExecuting = true;
    try {
      const expired = await this.prisma.tournament.findMany({
        where: { status: 'OPEN_FOR_SIGNUP', registrationDeadline: { lte: new Date() } },
        orderBy: [{ registrationDeadline: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      for (const { id } of expired) {
        await this.run(id, () => this.lifecycle.closeAndStart(id, 'SCHEDULER'), 'closed', result);
      }

      const stuck = await this.prisma.tournament.findMany({
        where: { status: 'REGISTRATION_CLOSED' },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      for (const { id } of stuck) {
        await this.run(id, () => this.lifecycle.startClosed(id), 'restarted', result);
      }
    } catch (error) {
      this.logger.error(`Deadline scan failed: ${describe(error)}`);
    } finally {
      this.isExecuting = false;
    }
    return result;
  }

  // never throws, one bad tournament can't stop the tick
  private async run(id: string, action: () => Promise<unknown>,
    counter: 'closed' | 'restarted', result: SchedulerTickResult): Promise<void> {
    try {
      await action();
      this.failures.delete(id);
      result[counter]++;
      return;
    } catch (error) {
      result.failed++;
      if (error instanceof HttpException && (error.getStatus() === 404 || error.getStatus() === 409)) {
        // lost a race, someone else handled it
        this.failures.delete(id);
        this.logger.log(`Tournament ${id} already handled elsewhere (${error.getStatus()}).`);
        return;
      }
      const attempts = (this.failures.get(id) ?? 0) + 1;
      this.failures.set(id, attempts);
      this.logger.error(`Tournament ${id} could not be started (attempt ${attempts}/${MAX_START_ATTEMPTS}): ${describe(error)}`);
      if (attempts < MAX_START_ATTEMPTS) return;
    }
    try {
      if (await this.lifecycle.cancelUnstartable(id)) result.cancelled++;
      this.failures.delete(id);
    } catch (error) {
        // counter stays at the limit, so the cancel is retried next tick
      this.logger.error(`Tournament ${id} could not be cancelled: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
