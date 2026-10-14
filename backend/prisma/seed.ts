import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
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
    select: { email: true, username: true, role: true },
  });

  if (isExistingAdmin(existingUsers, adminEmail, adminUsername)) {
    console.log('[Seed] Matching admin already exists. Keeping its current password.');
    return;
  }

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

main()
  .catch((e) => {
    // Prisma errors can include query inputs; never log a credential/hash payload.
    console.error('[Seed] Admin bootstrap failed:', e.constructor === Error ? e.message : 'Database operation failed. Check connectivity and bootstrap identity configuration.');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
