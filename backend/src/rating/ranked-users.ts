import { Prisma } from '@prisma/client';

export const RANKED_USER_WHERE: Prisma.UserWhereInput = { role: { notIn: ['admin', 'bot'] } };

//lowercase letters, digits, underscore, 3-20 chars
export const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;
