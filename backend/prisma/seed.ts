import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { isExistingAdmin, validateAdminPassword } from './admin-bootstrap';
import {
  AI_BOT_USER_ID,
  AI_BOT_USERNAME,
  AI_BOT_EMAIL,
  AI_BOT_ROLE,
  AI_BOT_DISPLAY_RATING,
} from '../src/ai/ai.constants';

const prisma = new PrismaClient();

async function main() {
  // --- Phase 1: Admin user bootstrap (requires ADMIN_PASSWORD) ---
  const configuredPassword = process.env.ADMIN_PASSWORD;
  if (configuredPassword !== undefined && configuredPassword !== '') {
    const adminPassword = validateAdminPassword(configuredPassword);

    const adminEmail = (process.env.ADMIN_EMAIL || 'admin@transcendence.local').trim().toLowerCase();
    const adminUsername = (process.env.ADMIN_USERNAME || 'admin').trim();

    console.log(`[Seed] Checking for existing admin: ${adminEmail} (${adminUsername})...`);

    const existingUsers = await prisma.user.findMany({
      where: {
        OR: [
          { email: adminEmail },
          { username: adminUsername },
        ],
      },
      select: { id: true, email: true, username: true, role: true },
    });

    if (isExistingAdmin(existingUsers, adminEmail, adminUsername)) {
      console.log('[Seed] Matching admin already exists. Keeping its current password.');
    } else {
      const passwordHash = await argon2.hash(adminPassword, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
      });

      const createdAdmin = await prisma.user.create({
        data: {
          email: adminEmail,
          username: adminUsername,
          passwordHash,
          role: 'admin',
          status: 'offline',
          rating: 1500,
        },
      });

      console.log(`[Seed] Successfully created admin user: ${createdAdmin.username} (${createdAdmin.id})`);
    }
  } else {
    console.log('[Seed] ADMIN_PASSWORD not set or empty. Skipping admin user creation.');
  }

  // --- Phase 2: Evaluator API key bootstrap (always runs, independent of admin) ---
  // Uses 4 repetitions of the standard hex sequence 1234567890abcdef (64 hex characters = 256 bits)
  const EVALUATOR_RAW_KEY = 'tr_live_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const EVALUATOR_EMAIL = 'evaluator@transcendence.local';
  const EVALUATOR_USERNAME = 'evaluator';

  let evalUser = await prisma.user.findFirst({
    where: { OR: [{ email: EVALUATOR_EMAIL }, { username: EVALUATOR_USERNAME }] },
    select: { id: true },
  });

  if (!evalUser) {
    // Create a standard non-admin evaluator account with a dummy hash
    // (this account is for API key testing only; it cannot log in interactively)
    evalUser = await prisma.user.create({
      data: {
        email: EVALUATOR_EMAIL,
        username: EVALUATOR_USERNAME,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$dW51c2FibGVfZXZhbHVhdG9y$0000000000000000000000000000000000000000000',
        role: 'user',
        status: 'offline',
        rating: 1200,
      },
      select: { id: true },
    });
    console.log(`[Seed] Created evaluator user: ${EVALUATOR_USERNAME}`);
  }

  const keyHash = createHash('sha256').update(EVALUATOR_RAW_KEY, 'utf8').digest('hex');
  const existingKey = await prisma.apiKey.findUnique({ where: { keyHash } });
  if (!existingKey) {
    await prisma.apiKey.create({
      data: {
        userId: evalUser.id,
        name: 'Evaluator Default Key',
        keyPrefix: EVALUATOR_RAW_KEY.slice(0, 16),
        keyHash,
      },
    });
    console.log(`[Seed] Seeded evaluator API key: ${EVALUATOR_RAW_KEY}`);
  }

  // --- Phase 3: AI opponent bootstrap (always runs) ---
  // The Stockfish bot is a normal user row so games against it can use the usual
  // white_id/black_id foreign keys. Its role is "bot" (RatingService uses that to
  // keep AI games out of ELO) and its password hash is intentionally unusable, so
  // nobody can log in as it. Fixed id, matched on, so re-seeding is idempotent.
  const existingBot = await prisma.user.findUnique({
    where: { id: AI_BOT_USER_ID },
    select: { id: true },
  });
  if (!existingBot) {
    await prisma.user.create({
      data: {
        id: AI_BOT_USER_ID,
        email: AI_BOT_EMAIL,
        username: AI_BOT_USERNAME,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$dW51c2FibGVfYWlfYm90$0000000000000000000000000000000000000000000',
        role: AI_BOT_ROLE,
        status: 'online',
        rating: AI_BOT_DISPLAY_RATING,
      },
    });
    console.log(`[Seed] Created AI bot user: ${AI_BOT_USERNAME} (${AI_BOT_USER_ID})`);
  } else {
    console.log('[Seed] AI bot user already exists. Skipping.');
  }
}

main()
  .catch((e) => {
    // Prisma errors can include query inputs; never log a credential/hash payload.
    // The error code and the constraint it hit are safe, though, and tell us
    // exactly what failed, so surface those.
    const code = e && typeof e === 'object' && 'code' in e ? ` [${(e as any).code}]` : '';
    const target =
      e && typeof e === 'object' && (e as any).meta?.target
        ? ` on ${JSON.stringify((e as any).meta.target)}`
        : '';
    const detail =
      e && e.constructor === Error
        ? e.message
        : 'Database operation failed. Check connectivity and bootstrap identity configuration.';
    const kind = e && typeof e === 'object' ? (e.constructor?.name ?? 'unknown') : typeof e;
    console.error(`[Seed] Seeding failed (${kind})${code}${target}: ${detail}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
