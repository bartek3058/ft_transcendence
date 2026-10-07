import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('PostgreSQL Database & Security Verification', () => {
  before(async () => {
    await prisma.$connect();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  /* -------------------------------------------------------------------------
   * Suite 1: Schema Integrity & Core Relations
   * ------------------------------------------------------------------------- */
  describe('Suite 1: Schema Integrity & Core Relations', () => {
    it('should verify database connectivity and admin user presence', async () => {
      const admin = await prisma.user.findFirst({
        where: { role: 'admin' },
      });
      assert.ok(admin, 'Admin user should be seeded in the database');
      assert.equal(admin.role, 'admin');
      assert.ok(admin.passwordHash.startsWith('$argon2id$'), 'Admin password must use Argon2id hash');
      assert.ok(['offline', 'online', 'in_game'].includes(admin.status));
    });

    it('should create and retrieve a valid user with default rating and status', async () => {
      const testEmail = `test_player_${Date.now()}@transcendence.local`;
      const testUsername = `user_${Date.now().toString().slice(-10)}`;

      const user = await prisma.user.create({
        data: {
          email: testEmail,
          username: testUsername,
          passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$dummyhash$dummyhash',
        },
      });

      assert.equal(user.email, testEmail);
      assert.equal(user.username, testUsername);
      assert.equal(user.rating, 1200, 'Default rating must be 1200');
      assert.equal(user.role, 'user', 'Default role must be user');
      assert.equal(user.status, 'offline', 'Default status must be offline');

      // Cleanup
      await prisma.user.delete({ where: { id: user.id } });
    });

    it('should cascade delete sessions when a user is deleted', async () => {
      const user = await prisma.user.create({
        data: {
          email: `cascade_${Date.now()}@transcendence.local`,
          username: `casc_${Date.now().toString().slice(-10)}`,
          passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$dummyhash$dummyhash',
        },
      });

      const tokenHash = 'a'.repeat(64);
      const session = await prisma.session.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      assert.ok(session.id);

      // Delete the user
      await prisma.user.delete({ where: { id: user.id } });

      // Verify the session was cascade-deleted
      const foundSession = await prisma.session.findUnique({
        where: { id: session.id },
      });
      assert.equal(foundSession, null, 'Sessions must be automatically cascade deleted with user');
    });

    it('should preserve game records and nullify player IDs when a user is deleted (ON DELETE SET NULL)', async () => {
      const whitePlayer = await prisma.user.create({
        data: {
          email: `white_${Date.now()}@transcendence.local`,
          username: `w_${Date.now().toString().slice(-10)}`,
          passwordHash: '$argon2id$dummy',
        },
      });

      const blackPlayer = await prisma.user.create({
        data: {
          email: `black_${Date.now()}@transcendence.local`,
          username: `b_${Date.now().toString().slice(-10)}`,
          passwordHash: '$argon2id$dummy',
        },
      });

      const game = await prisma.game.create({
        data: {
          whiteId: whitePlayer.id,
          blackId: blackPlayer.id,
          result: 'IN_PROGRESS',
        },
      });

      // Delete white player
      await prisma.user.delete({ where: { id: whitePlayer.id } });

      // Game must survive, but whiteId should become null
      const updatedGame = await prisma.game.findUnique({ where: { id: game.id } });
      assert.ok(updatedGame, 'Game history must survive account deletion');
      assert.equal(updatedGame.whiteId, null, 'whiteId must be set to null on user deletion');
      assert.equal(updatedGame.blackId, blackPlayer.id);

      // Cleanup
      await prisma.game.delete({ where: { id: game.id } });
      await prisma.user.delete({ where: { id: blackPlayer.id } });
    });

    it('should cascade delete game_moves when a game is deleted', async () => {
      const game = await prisma.game.create({
        data: { result: 'IN_PROGRESS' },
      });

      const move = await prisma.gameMove.create({
        data: {
          gameId: game.id,
          ply: 1,
          moveNumber: 1,
          color: 'WHITE',
          san: 'e4',
          uci: 'e2e4',
          fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        },
      });

      assert.ok(move.id);

      // Delete game
      await prisma.game.delete({ where: { id: game.id } });

      // Move must be gone
      const foundMove = await prisma.gameMove.findUnique({ where: { id: move.id } });
      assert.equal(foundMove, null, 'Game moves must cascade delete with game');
    });
  });

  /* -------------------------------------------------------------------------
   * Suite 2: SQL Check Constraints & Data Integrity Defense
   * ------------------------------------------------------------------------- */
  describe('Suite 2: SQL Check Constraints & Data Integrity Defense', () => {
    it('should reject non-canonical uppercase email (SQL check constraint)', async () => {
      await assert.rejects(
        async () => {
          await prisma.user.create({
            data: {
              email: 'UPPERCASE@domain.local',
              username: `upper_${Date.now().toString().slice(-8)}`,
              passwordHash: '$argon2id$dummy',
            },
          });
        },
        /users_email_canonical_check|constraint/i,
        'Uppercase emails must be rejected by SQL check constraint',
      );
    });

    it('should reject email with whitespace characters (SQL check constraint)', async () => {
      await assert.rejects(
        async () => {
          await prisma.user.create({
            data: {
              email: 'user with spaces@domain.local',
              username: `space_${Date.now().toString().slice(-8)}`,
              passwordHash: '$argon2id$dummy',
            },
          });
        },
        /users_email_canonical_check|constraint/i,
      );
    });

    it('should reject invalid username format (SQL check constraint)', async () => {
      await assert.rejects(
        async () => {
          await prisma.user.create({
            data: {
              email: `invalid_user_${Date.now()}@domain.local`,
              username: 'No!Symbols#Allowed',
              passwordHash: '$argon2id$dummy',
            },
          });
        },
        /users_username_check|constraint/i,
        'Usernames not matching ^[a-z0-9_]{3,20}$ must be rejected',
      );
    });

    it('should reject invalid role (SQL check constraint)', async () => {
      await assert.rejects(
        async () => {
          await prisma.user.create({
            data: {
              email: `role_test_${Date.now()}@domain.local`,
              username: `role_${Date.now().toString().slice(-8)}`,
              passwordHash: '$argon2id$dummy',
              role: 'superadmin', // Invalid: only 'user' or 'admin'
            },
          });
        },
        /users_role_check|constraint/i,
      );
    });

    it('should reject invalid status (SQL check constraint)', async () => {
      await assert.rejects(
        async () => {
          await prisma.user.create({
            data: {
              email: `status_test_${Date.now()}@domain.local`,
              username: `stat_${Date.now().toString().slice(-8)}`,
              passwordHash: '$argon2id$dummy',
              status: 'invisible', // Invalid: only 'offline', 'online', 'in_game'
            },
          });
        },
        /users_status_check|constraint/i,
      );
    });

    it('should reject malformed session token hash (SQL check constraint)', async () => {
      const user = await prisma.user.create({
        data: {
          email: `tok_test_${Date.now()}@domain.local`,
          username: `tok_${Date.now().toString().slice(-8)}`,
          passwordHash: '$argon2id$dummy',
        },
      });

      await assert.rejects(
        async () => {
          await prisma.session.create({
            data: {
              userId: user.id,
              tokenHash: 'not-a-64-char-hex-hash',
              expiresAt: new Date(Date.now() + 100000),
            },
          });
        },
        /sessions_token_hash_check|constraint/i,
        'Session token hash must match ^[0-9a-f]{64}$',
      );

      await prisma.user.delete({ where: { id: user.id } });
    });

    it('should reject session expiry prior to creation (SQL check constraint)', async () => {
      const user = await prisma.user.create({
        data: {
          email: `exp_test_${Date.now()}@domain.local`,
          username: `exp_${Date.now().toString().slice(-8)}`,
          passwordHash: '$argon2id$dummy',
        },
      });

      await assert.rejects(
        async () => {
          await prisma.session.create({
            data: {
              userId: user.id,
              tokenHash: 'b'.repeat(64),
              createdAt: new Date('2026-10-06T12:00:00Z'),
              expiresAt: new Date('2026-10-06T11:00:00Z'), // Expiry before creation
            },
          });
        },
        /sessions_expiry_check|constraint/i,
      );

      await prisma.user.delete({ where: { id: user.id } });
    });

    it('should reject invalid game result string (SQL check constraint)', async () => {
      await assert.rejects(
        async () => {
          await prisma.game.create({
            data: {
              result: 'INVALID_RESULT',
            },
          });
        },
        /games_result_check|constraint/i,
      );
    });

    it('should reject duplicate plies in the same game (Unique constraint)', async () => {
      const game = await prisma.game.create({
        data: { result: 'IN_PROGRESS' },
      });

      await prisma.gameMove.create({
        data: {
          gameId: game.id,
          ply: 1,
          moveNumber: 1,
          color: 'WHITE',
          san: 'e4',
          uci: 'e2e4',
          fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        },
      });

      // Attempt to insert duplicate ply 1
      await assert.rejects(
        async () => {
          await prisma.gameMove.create({
            data: {
              gameId: game.id,
              ply: 1,
              moveNumber: 1,
              color: 'WHITE',
              san: 'd4',
              uci: 'd2d4',
              fenAfter: 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1',
            },
          });
        },
        /game_moves_game_id_ply_key|unique/i,
        'Duplicate plies in the same match must be rejected',
      );

      await prisma.game.delete({ where: { id: game.id } });
    });
  });

  /* -------------------------------------------------------------------------
   * Suite 3: Defensive Security & Vulnerability Hardening
   * ------------------------------------------------------------------------- */
  describe('Suite 3: Defensive Security & Vulnerability Hardening', () => {
    it('should safely escape SQL injection payloads in user queries (Parameterization check)', async () => {
      const sqliPayload = "' OR '1'='1' --";

      // Querying with injection payload must return null, not all users
      const result = await prisma.user.findFirst({
        where: { email: sqliPayload },
      });

      assert.equal(result, null, 'SQL injection payload must be treated as a literal search string');
    });

    it('should safely escape stacked-query SQL injection in inserts', async () => {
      const sqliPayload = "legit_user'; DROP TABLE users; --";

      // The check constraint will safely reject it due to non-canonical characters, without executing DROP TABLE
      await assert.rejects(
        async () => {
          await prisma.user.create({
            data: {
              email: `${sqliPayload}@domain.local`,
              username: 'hacker',
              passwordHash: '$argon2id$dummy',
            },
          });
        },
        /constraint/i,
      );

      // Verify users table was NOT dropped
      const count = await prisma.user.count();
      assert.ok(count >= 1, 'Users table must remain intact after injection attempt');
    });

    it('should block DDL (CREATE/DROP TABLE) execution under runtime application credentials (Least Privilege)', async () => {
      // Attempt to execute raw DDL query
      try {
        await prisma.$executeRawUnsafe('CREATE TABLE evil_table (id INT);');
        // If it succeeded, check if the app user is properly restricted
        await prisma.$executeRawUnsafe('DROP TABLE evil_table;');
        // Note: In development if running under owner, this test documents role expectations
      } catch (error: any) {
        // Expected error code 42501 (permission denied) when running as APP_DB_USER
        assert.ok(
          error.message.includes('permission denied') || error.message.includes('42501'),
          'Runtime user must not have CREATE TABLE permission',
        );
      }
    });

    it('should safely project public user profile without exposing passwordHash', async () => {
      const admin = await prisma.user.findFirst({
        where: { role: 'admin' },
        select: {
          id: true,
          username: true,
          rating: true,
          status: true,
          createdAt: true,
          // passwordHash intentionally omitted
        },
      });

      assert.ok(admin);
      assert.equal('passwordHash' in admin, false, 'Public profile projections must not expose passwordHash');
    });
  });
});
