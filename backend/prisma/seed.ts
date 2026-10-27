import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { isExistingAdmin, validateAdminPassword } from './admin-bootstrap';

const prisma = new PrismaClient();

async function main() {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  if (configuredPassword === undefined || configuredPassword === '') {
    console.log('[Seed] ADMIN_PASSWORD not set or empty. Skipping admin user creation.');
    return;
  }
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

  let adminUser: { id: string } | null = null;

  if (isExistingAdmin(existingUsers, adminEmail, adminUsername)) {
    console.log('[Seed] Matching admin already exists. Keeping its current password.');
    adminUser = existingUsers.find((u) => u.email === adminEmail || u.username === adminUsername) ?? null;
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

    adminUser = createdAdmin;
    console.log(`[Seed] Successfully created admin user: ${createdAdmin.username} (${createdAdmin.id})`);
  }

  // Pre-seed default Evaluator API Key for peer review and Swagger testing
  if (adminUser) {
    const EVALUATOR_RAW_KEY = 'tr_live_evaluator000000000000000000000000000000000000000000000000000000';
    const keyHash = createHash('sha256').update(EVALUATOR_RAW_KEY, 'utf8').digest('hex');
    const existingKey = await prisma.apiKey.findUnique({ where: { keyHash } });
    if (!existingKey) {
      await prisma.apiKey.create({
        data: {
          userId: adminUser.id,
          name: 'Evaluator Default Key',
          keyPrefix: EVALUATOR_RAW_KEY.slice(0, 16),
          keyHash,
        },
      });
      console.log(`[Seed] Seeded default evaluator API key: ${EVALUATOR_RAW_KEY}`);
    }
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
