import { Prisma } from '@prisma/client';

export const RANKED_USER_WHERE: Prisma.UserWhereInput = { role: { notIn: ['admin', 'bot'] } };

// letters (any case), digits, underscore, 3-20 chars
export { USERNAME_PATTERN as USERNAME_REGEX } from '../auth/validation/input-rules';
