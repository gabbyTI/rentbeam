/**
 * src/lib/__mocks__/prisma.ts
 *
 * Jest manual mock for the Prisma client.
 * Placed next to src/lib/prisma.ts so that `jest.mock('../../src/lib/prisma.js')`
 * automatically uses this file — no factory function needed.
 */
import { mockDeep } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

const prisma = mockDeep<PrismaClient>();

export default prisma;
