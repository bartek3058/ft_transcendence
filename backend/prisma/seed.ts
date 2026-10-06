import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@transcendence.local').trim().toLowerCase();
  const adminUsername = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin_Password123!';

  console.log(`[Seed] Checking for existing admin: ${adminEmail} (${adminUsername})...`);

  const existingUser = await prisma.user.findFirst({
    where: {
      OR: [
        { email: adminEmail },
        { username: adminUsername },
      ],
    },
  });

  if (existingUser) {
    console.log(`[Seed] User already exists (id: ${existingUser.id}, role: ${existingUser.role}). Skipping seed.`);
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
    console.error('[Seed] Error seeding admin user:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
