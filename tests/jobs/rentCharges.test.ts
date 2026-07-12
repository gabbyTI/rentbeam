/**
 * tests/jobs/rentCharges.test.ts
 *
 * Unit tests for the postMonthlyRentCharges job.
 * Verifies tenant filtering, idempotency, error isolation, and result counts.
 */

import { Prisma } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

// Mock prisma and ledger service BEFORE any imports that use them
jest.mock('../../src/lib/prisma.js', () => {
  const { mockDeep } = require('jest-mock-extended');
  return { __esModule: true, default: mockDeep() };
});
jest.mock('../../src/lib/logger.js', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../src/lib/metrics.js', () => ({
  cronExecutionsTotal: { inc: jest.fn() },
  cronLastRunTimestamp: { set: jest.fn() },
}));

// Mock the ledger service so we can control postCharge behaviour
const mockPostCharge = jest.fn();
jest.mock('../../src/services/ledger.js', () => ({
  postCharge: (...args: any[]) => mockPostCharge(...args),
}));

import prismaMock_ from '../../src/lib/prisma.js';
const prismaMock = prismaMock_ as unknown as DeepMockProxy<PrismaClient>;
import { postMonthlyRentCharges } from '../../src/jobs/rentCharges.js';

// ─── Reset mock state between tests ────────────────────────────────
beforeEach(() => {
  const { mockReset } = require('jest-mock-extended');
  mockReset(prismaMock);
  mockPostCharge.mockReset();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTenant(id: string, dueDay: number, rentAmount: number) {
  return {
    id,
    status: 'ACTIVE',
    unit: {
      id: `unit-${id}`,
      dueDay,
      rentAmount: new Prisma.Decimal(rentAmount),
    },
  };
}

/** Build a fake just-created ledger entry (createdAt = now) */
function freshEntry(id: string) {
  return {
    id,
    createdAt: new Date(), // brand new — will not be flagged as skipped
  };
}

/** Build a stale entry (createdAt > 5s ago) — simulates already-posted idempotency hit */
function staleEntry(id: string) {
  return {
    id,
    createdAt: new Date(Date.now() - 10_000), // 10 seconds ago
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('postMonthlyRentCharges', () => {
  beforeEach(() => {
    mockPostCharge.mockReset();
  });

  it('posts rent charges for all active tenants due today', async () => {
    const today = new Date();
    const dueDay = today.getDate();
    const t1 = makeTenant('t1', dueDay, 1000);
    const t2 = makeTenant('t2', dueDay, 1200);

    prismaMock.tenantMembership.findMany.mockResolvedValue([t1, t2] as any);
    mockPostCharge
      .mockResolvedValueOnce(freshEntry('e1'))
      .mockResolvedValueOnce(freshEntry('e2'));

    const result = await postMonthlyRentCharges();

    expect(prismaMock.tenantMembership.findMany).toHaveBeenCalledTimes(1);
    expect(mockPostCharge).toHaveBeenCalledTimes(2);
    expect(result.processed).toBe(2);
    expect(result.posted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('passes the correct referenceId for idempotency', async () => {
    const today = new Date();
    const dueDay = today.getDate();
    const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

    const t1 = makeTenant('tenant-abc', dueDay, 800);
    prismaMock.tenantMembership.findMany.mockResolvedValue([t1] as any);
    mockPostCharge.mockResolvedValue(freshEntry('e1'));

    await postMonthlyRentCharges();

    const call = mockPostCharge.mock.calls[0][0] as any;
    expect(call.referenceId).toBe(`RNTA-tenant-abc-${currentMonth}`);
    expect(call.code).toBe('RNTA');
    expect(call.source).toBe('SYSTEM');
    expect(call.amount).toBe(800);
  });

  it('counts as skipped when postCharge returns a stale (already-existing) entry', async () => {
    const today = new Date();
    const dueDay = today.getDate();
    const t1 = makeTenant('t1', dueDay, 1000);

    prismaMock.tenantMembership.findMany.mockResolvedValue([t1] as any);
    // Return entry that was created > 5s ago → treated as existing/skipped
    mockPostCharge.mockResolvedValue(staleEntry('e-existing'));

    const result = await postMonthlyRentCharges();

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.posted).toBe(0);
  });

  it('does nothing and returns zeros when no tenants are due today', async () => {
    prismaMock.tenantMembership.findMany.mockResolvedValue([]);

    const result = await postMonthlyRentCharges();

    expect(mockPostCharge).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
    expect(result.posted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('isolates errors per tenant — continues processing remaining tenants', async () => {
    const today = new Date();
    const dueDay = today.getDate();
    const t1 = makeTenant('t1', dueDay, 1000);
    const t2 = makeTenant('t2', dueDay, 1200);
    const t3 = makeTenant('t3', dueDay, 900);

    prismaMock.tenantMembership.findMany.mockResolvedValue([t1, t2, t3] as any);
    mockPostCharge
      .mockResolvedValueOnce(freshEntry('e1'))
      .mockRejectedValueOnce(new Error('Prisma connection error')) // t2 fails
      .mockResolvedValueOnce(freshEntry('e3'));

    const result = await postMonthlyRentCharges();

    expect(result.processed).toBe(3);
    expect(result.posted).toBe(2);    // t1 and t3 succeed
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].tenantMembershipId).toBe('t2');
    expect(result.errors[0].error).toBe('Prisma connection error');
  });

  it('includes the correct description with the current month', async () => {
    const today = new Date();
    const dueDay = today.getDate();
    const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

    const t1 = makeTenant('t1', dueDay, 1000);
    prismaMock.tenantMembership.findMany.mockResolvedValue([t1] as any);
    mockPostCharge.mockResolvedValue(freshEntry('e1'));

    await postMonthlyRentCharges();

    const call = mockPostCharge.mock.calls[0][0] as any;
    expect(call.description).toBe(`Apartment Rent (${currentMonth})`);
  });

  it('queries with moveInDate lte today to exclude future tenants', async () => {
    prismaMock.tenantMembership.findMany.mockResolvedValue([]);

    await postMonthlyRentCharges();

    const query = prismaMock.tenantMembership.findMany.mock.calls[0][0] as any;
    expect(query.where.moveInDate).toEqual({ lte: expect.any(Date) });
    // The lte date must not be in the future
    expect(query.where.moveInDate.lte.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
