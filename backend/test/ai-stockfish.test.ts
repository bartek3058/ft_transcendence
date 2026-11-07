import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { clampSkill, parseBestMove, parseInfoScore } from '../src/ai/uci-engine';
import { StockfishService } from '../src/ai/stockfish.service';

// A legal move in UCI long algebraic notation: from-square, to-square, optional
// promotion piece. e.g. "e2e4", "e7e8q".
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

describe('UCI output parsing (pure)', () => {
  describe('parseBestMove', () => {
    it('reads a bestmove with a ponder move', () => {
      assert.deepEqual(parseBestMove('bestmove e2e4 ponder e7e5'), {
        bestMove: 'e2e4',
        ponder: 'e7e5',
      });
    });

    it('reads a bestmove without a ponder move', () => {
      assert.deepEqual(parseBestMove('bestmove g1f3'), {
        bestMove: 'g1f3',
        ponder: null,
      });
    });

    it('reports a terminal position ("(none)") as a null move', () => {
      assert.deepEqual(parseBestMove('bestmove (none)'), {
        bestMove: null,
        ponder: null,
      });
    });

    it('keeps a promotion suffix on the move', () => {
      assert.equal(parseBestMove('bestmove e7e8q').bestMove, 'e7e8q');
    });
  });

  describe('parseInfoScore', () => {
    it('reads a centipawn score and depth', () => {
      const line = 'info depth 18 seldepth 24 score cp 35 nodes 1000 pv e2e4';
      assert.deepEqual(parseInfoScore(line), { scoreCp: 35, mateIn: null, depth: 18 });
    });

    it('reads a negative centipawn score', () => {
      assert.equal(parseInfoScore('info depth 10 score cp -120 pv a7a6')?.scoreCp, -120);
    });

    it('reads a forced-mate score', () => {
      assert.deepEqual(parseInfoScore('info depth 20 score mate 3 pv a1a8'), {
        scoreCp: null,
        mateIn: 3,
        depth: 20,
      });
    });

    it('returns null for a line with no score', () => {
      assert.equal(parseInfoScore('info depth 1 currmove e2e4 currmovenumber 1'), null);
    });
  });

  describe('clampSkill', () => {
    it('defaults to full strength (20) when no level is given', () => {
      assert.equal(clampSkill(undefined), 20);
      assert.equal(clampSkill(NaN), 20);
    });

    it('clamps out-of-range levels into 0..20', () => {
      assert.equal(clampSkill(-5), 0);
      assert.equal(clampSkill(99), 20);
    });

    it('passes a valid level straight through', () => {
      assert.equal(clampSkill(8), 8);
    });
  });
});

// These talk to a real Stockfish process, so they only run where the binary is
// installed (i.e. inside the backend Docker image). Elsewhere they are skipped so
// the pure tests above still pass on a plain checkout.
const STOCKFISH_PATH = process.env.STOCKFISH_PATH?.trim() || '/usr/games/stockfish';
const hasEngine = existsSync(STOCKFISH_PATH);

describe('StockfishService (needs the engine binary)', { skip: !hasEngine ? 'Stockfish binary not found' : false }, () => {
  const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  // White to move; Re1-e8 is the only mate in one (back-rank mate).
  const MATE_IN_ONE = '6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1';
  // Black to move, not in check, no legal move -> stalemate.
  const STALEMATE = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';

  it('returns a legal-looking move for the opening position', async () => {
    const service = new StockfishService();
    try {
      const move = await service.bestMove(STARTPOS, 'hard');
      assert.ok(move.bestMove && UCI_MOVE.test(move.bestMove), `expected a UCI move, got ${move.bestMove}`);
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('finds the mate in one when asked for a hint (full strength)', async () => {
    const service = new StockfishService();
    try {
      const hint = await service.hint(MATE_IN_ONE);
      assert.equal(hint.bestMove, 'e1e8');
      assert.equal(hint.evaluation.mateIn, 1);
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('reports a null move in a terminal (stalemate) position', async () => {
    const service = new StockfishService();
    try {
      const move = await service.bestMove(STALEMATE, 'easy');
      assert.equal(move.bestMove, null);
    } finally {
      await service.onModuleDestroy();
    }
  });
});
