import { HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { TournamentLifecycleService } from './tournament-lifecycle.service';

export const DEADLINE_SCHEDULER_INTERVAL_MS = 60_000;

export interface SchedulerTickResult {
  skipped: boolean;
  closed: number;
  restarted: number;
  failed: number;
}

/**
 * Closes expired registrations and retries tournaments left in REGISTRATION_CLOSED.
 * Zero-dependency setInterval (same pattern as SessionService). All state is in the DB,
 * so a restart loses nothing; each tournament runs in its own transaction, and the
 * conditional status updates make concurrent ticks / manual closes / other instances safe.
 */
@Injectable()
export class TournamentDeadlineScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TournamentDeadlineScheduler.name);
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
    const result: SchedulerTickResult = { skipped: false, closed: 0, restarted: 0, failed: 0 };
    if (this.isExecuting) return { ...result, skipped: true };
    this.isExecuting = true;
    try {
      const expired = await this.prisma.tournament.findMany({
        where: { status: 'OPEN_FOR_SIGNUP', registrationDeadline: { lte: new Date() } },
        orderBy: [{ registrationDeadline: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      for (const { id } of expired) {
        if (await this.run(id, () => this.lifecycle.closeAndStart(id, 'SCHEDULER'))) result.closed++;
        else result.failed++;
      }

      const stuck = await this.prisma.tournament.findMany({
        where: { status: 'REGISTRATION_CLOSED' },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      for (const { id } of stuck) {
        if (await this.run(id, () => this.lifecycle.startClosed(id))) result.restarted++;
        else result.failed++;
      }
    } catch (error) {
      this.logger.error(`Deadline scan failed: ${describe(error)}`);
    } finally {
      this.isExecuting = false;
    }
    return result;
  }

  /** One tournament; never throws, so a failure cannot stop the rest of the tick. */
  private async run(id: string, action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (error) {
      if (error instanceof HttpException && (error.getStatus() === 404 || error.getStatus() === 409)) {
        // Lost a race (manual close, cancel, another tick or instance): nothing to do.
        this.logger.log(`Tournament ${id} already handled elsewhere (${error.getStatus()}).`);
      } else {
        this.logger.error(`Tournament ${id} could not be started: ${describe(error)}`);
      }
      return false;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
