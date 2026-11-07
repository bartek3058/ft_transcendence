import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { Logger } from '@nestjs/common';
import { EngineEvaluation, EngineMove, UciSearchOptions } from './ai.types';

export class UciEngine {
  private readonly logger = new Logger(UciEngine.name);

  private child: ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<void> | null = null;

  private stdoutBuffer = '';
  private readonly lineListeners = new Set<(line: string) => void>();

  private chain: Promise<unknown> = Promise.resolve();

  private static readonly HARD_TIMEOUT_MS = 20_000;

  constructor(private readonly binaryPath: string) {}

  private ensureReady(): Promise<void> {
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.binaryPath, [], { stdio: 'pipe' });
      } catch (error) {
        this.readyPromise = null;
        reject(new Error(`Failed to spawn Stockfish at "${this.binaryPath}": ${(error as Error).message}`));
        return;
      }

      this.child = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

      child.once('error', (error) => {
        this.logger.error(`Stockfish process error: ${error.message}`);
        this.teardown();
        reject(error);
      });
      child.once('exit', (code, signal) => {
        this.logger.warn(`Stockfish process exited (code=${code}, signal=${signal}).`);
        this.teardown();
      });

      const handshake = async () => {
        await this.waitForLine((line) => line === 'uciok', 'uciok', 5_000, () => this.send('uci'));
        await this.waitForLine((line) => line === 'readyok', 'readyok', 5_000, () => this.send('isready'));
      };

      handshake().then(resolve, (error) => {
        this.teardown();
        reject(error);
      });
    });

    return this.readyPromise;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '').trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        // Copy before iterating: a listener may remove itself on the matching line.
        for (const listener of [...this.lineListeners]) {
          listener(line);
        }
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private send(command: string): void {
    if (!this.child || this.child.stdin.destroyed) {
      throw new Error('Cannot send to Stockfish: the process is not running.');
    }
    this.child.stdin.write(`${command}\n`);
  }

  /**
   * Resolves with the first output line matching `predicate`. Registers the
   * listener first, then runs `trigger` (the command that will produce the line),
   * so we can never miss an answer that comes back faster than we subscribe.
   */
  private waitForLine(
    predicate: (line: string) => boolean,
    label: string,
    timeoutMs: number,
    trigger?: () => void,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.lineListeners.delete(listener);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for "${label}" from Stockfish.`));
      }, timeoutMs);
      timer.unref();

      const listener = (line: string) => {
        if (!predicate(line)) {
          return;
        }
        clearTimeout(timer);
        this.lineListeners.delete(listener);
        resolve(line);
      };

      this.lineListeners.add(listener);
      try {
        trigger?.();
      } catch (error) {
        clearTimeout(timer);
        this.lineListeners.delete(listener);
        reject(error as Error);
      }
    });
  }

  /**
   * Searches `options.fen` and resolves with the engine's best move and the
   * evaluation it reported for it. Requests are serialized, so this is safe to
   * call from many places at once.
   */
  search(options: UciSearchOptions): Promise<EngineMove> {
    const run = () => this.runSearch(options);
    // Chain onto the previous request regardless of whether it resolved or threw,
    // so one failed search never blocks the queue forever.
    const result = this.chain.then(run, run);
    // Keep the chain alive but swallow this result's rejection on the chain copy
    // (the caller still gets the real promise, errors and all).
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async runSearch(options: UciSearchOptions): Promise<EngineMove> {
    await this.ensureReady();

    // Apply (or clear) the strength limit for this move. Skill Level is a global
    // option, so we always set it explicitly rather than assume the last value.
    const skill = clampSkill(options.skillLevel);
    this.send(`setoption name Skill Level value ${skill}`);

    // Fresh search context so a previous game's transposition table can't leak in.
    this.send('ucinewgame');
    await this.waitForLine((line) => line === 'readyok', 'readyok', 5_000, () => this.send('isready'));

    this.send(`position fen ${options.fen}`);

    const goParts: string[] = ['go'];
    if (typeof options.depth === 'number') {
      goParts.push('depth', String(Math.max(1, Math.floor(options.depth))));
    }
    if (typeof options.movetimeMs === 'number') {
      goParts.push('movetime', String(Math.max(1, Math.floor(options.movetimeMs))));
    }
    if (goParts.length === 1) {
      // No explicit budget given: fall back to a sane fixed depth.
      goParts.push('depth', '12');
    }

    // Collect the latest score line until "bestmove" tells us the search is done.
    let latest: EngineEvaluation = { scoreCp: null, mateIn: null, depth: null };
    const scoreListener = (line: string) => {
      if (line.startsWith('info ') && line.includes(' score ')) {
        const parsed = parseInfoScore(line);
        if (parsed) {
          latest = parsed;
        }
      }
    };
    this.lineListeners.add(scoreListener);

    const timeout = Math.min(
      UciEngine.HARD_TIMEOUT_MS,
      (options.movetimeMs ?? 3_000) + 5_000,
    );

    try {
      const bestLine = await this.waitForLine(
        (line) => line.startsWith('bestmove'),
        'bestmove',
        timeout,
        () => this.send(goParts.join(' ')),
      );
      return { ...parseBestMove(bestLine), evaluation: latest };
    } finally {
      this.lineListeners.delete(scoreListener);
    }
  }

  /** Stops the engine cleanly (best-effort). Safe to call more than once. */
  async quit(): Promise<void> {
    if (!this.child) {
      return;
    }
    try {
      this.send('quit');
    } catch {
      // Process already gone; the kill below is the fallback.
    }
    const child = this.child;
    this.teardown();
    // Give it a moment to exit on its own, then make sure it's really gone.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 500);
      timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private teardown(): void {
    this.readyPromise = null;
    this.stdoutBuffer = '';
    this.lineListeners.clear();
    this.child = null;
  }
}

/** Clamps a requested Skill Level into Stockfish's valid 0..20 range. */
export function clampSkill(skillLevel: number | undefined): number {
  if (typeof skillLevel !== 'number' || Number.isNaN(skillLevel)) {
    return 20; // full strength by default (used for hints)
  }
  return Math.max(0, Math.min(20, Math.floor(skillLevel)));
}

/**
 * Parses a "bestmove" line. Shapes seen in the wild:
 *   "bestmove e2e4 ponder e7e5"
 *   "bestmove e2e4"
 *   "bestmove (none)"   (terminal position - nothing to play)
 */
export function parseBestMove(line: string): Pick<EngineMove, 'bestMove' | 'ponder'> {
  const tokens = line.trim().split(/\s+/);
  const best = tokens[1];
  const bestMove = !best || best === '(none)' ? null : best;

  let ponder: string | null = null;
  const ponderIndex = tokens.indexOf('ponder');
  if (ponderIndex !== -1 && tokens[ponderIndex + 1] && tokens[ponderIndex + 1] !== '(none)') {
    ponder = tokens[ponderIndex + 1];
  }

  return { bestMove, ponder };
}

/**
 * Pulls the score out of an "info ... score cp <n> ..." / "... score mate <n> ..."
 * line. Returns null if the line carries no score we understand.
 */
export function parseInfoScore(line: string): EngineEvaluation | null {
  const tokens = line.trim().split(/\s+/);

  const depthIndex = tokens.indexOf('depth');
  const depth = depthIndex !== -1 ? toInt(tokens[depthIndex + 1]) : null;

  const scoreIndex = tokens.indexOf('score');
  if (scoreIndex === -1) {
    return null;
  }
  const kind = tokens[scoreIndex + 1];
  const value = toInt(tokens[scoreIndex + 2]);
  if (value === null) {
    return null;
  }

  if (kind === 'cp') {
    return { scoreCp: value, mateIn: null, depth };
  }
  if (kind === 'mate') {
    return { scoreCp: null, mateIn: value, depth };
  }
  return null;
}

function toInt(token: string | undefined): number | null {
  if (token === undefined) {
    return null;
  }
  const n = Number.parseInt(token, 10);
  return Number.isNaN(n) ? null : n;
}
