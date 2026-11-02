import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { isExistingAdmin, validateAdminPassword } from './admin-bootstrap';

const prisma = new PrismaClient();

async function main() {
  // --- Phase 1: Admin user bootstrap (requires ADMIN_PASSWORD) ---
  const configuredPassword = process.env.ADMIN_PASSWORD;
  if (configuredPassword !== undefined && configuredPassword !== '') {
    const adminPassword = validateAdminPassword(configuredPassword);

    const adminEmail = (process.env.ADMIN_EMAIL || 'admin@transcendence.local').trim().toLowerCase();
    const adminUsername = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();

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
}

main()
  .catch((e) => {
    // Prisma errors can include query inputs; never log a credential/hash payload.
    console.error('[Seed] Admin bootstrap failed:', e.constructor === Error ? e.message : 'Database operation failed. Check connectivity and bootstrap identity configuration.');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
