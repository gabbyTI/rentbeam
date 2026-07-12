/**
 * tests/services/ledger.test.ts
 *
 * Unit tests for the ledger service.
 * Covers balance math, idempotency, all entry types, and edge cases.
 * Prisma is fully mocked — no database required.
 */

import { Prisma } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

// ─── Mock prisma BEFORE importing the service ────────────────────────────────
// Self-contained CJS factory — require() works because ts-jest compiles to CJS
jest.mock('../../src/lib/prisma.js', () => {
  const { mockDeep } = require('jest-mock-extended');
  return { __esModule: true, default: mockDeep() };
});
jest.mock('../../src/lib/logger.js', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import prismaMock_ from '../../src/lib/prisma.js';
const prismaMock = prismaMock_ as unknown as DeepMockProxy<PrismaClient>;
import {
  postCharge,
  postPayment,
  postCredit,
  getCurrentBalance,
  getStatement,
  getLedgerSummary,
} from '../../src/services/ledger.js';

// ─── Reset mock state between tests ────────────────────────────────
beforeEach(() => {
  const { mockReset } = require('jest-mock-extended');
  mockReset(prismaMock);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MEMBERSHIP_ID = 'membership-001';
const TODAY = new Date('2026-07-01T00:00:00Z');

/** Build a minimal LedgerEntry-shaped object the mock can return */
function makeEntry(overrides: Partial<{
  id: string;
  tenantMembershipId: string;
  effectiveDate: Date;
  type: 'CHARGE' | 'PAYMENT' | 'CREDIT';
  status: 'POSTED' | 'PENDING' | 'REVERSED';
  source: 'SYSTEM' | 'STRIPE' | 'MANUAL';
  code: string | null;
  description: string;
  chargeAmount: Prisma.Decimal | null;
  paymentAmount: Prisma.Decimal | null;
  balanceAfter: Prisma.Decimal;
  referenceId: string | null;
  postedBy: string | null;
  createdAt: Date;
}> = {}) {
  return {
    id: 'entry-1',
    tenantMembershipId: MEMBERSHIP_ID,
    effectiveDate: TODAY,
    type: 'CHARGE' as const,
    status: 'POSTED' as const,
    source: 'SYSTEM' as const,
    code: 'RNTA',
    description: 'Apartment Rent',
    chargeAmount: new Prisma.Decimal(1000),
    paymentAmount: null,
    balanceAfter: new Prisma.Decimal(1000),
    referenceId: null,
    postedBy: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// ─── postCharge ───────────────────────────────────────────────────────────────

describe('postCharge', () => {
  it('creates a charge entry when no previous entries exist (balance starts at 0)', async () => {
    // No prior balance
    prismaMock.ledgerEntry.findFirst.mockResolvedValue(null);
    prismaMock.ledgerEntry.findUnique.mockResolvedValue(null); // no idempotency hit
    const created = makeEntry({ balanceAfter: new Prisma.Decimal(500) });
    prismaMock.ledgerEntry.create.mockResolvedValue(created as any);

    const result = await postCharge({
      tenantMembershipId: MEMBERSHIP_ID,
      effectiveDate: TODAY,
      code: 'RNTA',
      description: 'Apartment Rent (2026-07)',
      amount: 500,
      source: 'SYSTEM',
    });

    expect(prismaMock.ledgerEntry.create).toHaveBeenCalledTimes(1);
    const callData = prismaMock.ledgerEntry.create.mock.calls[0][0].data;
    expect(callData.type).toBe('CHARGE');
    expect(callData.code).toBe('RNTA');
    expect(Number(callData.chargeAmount)).toBe(500);
    expect(Number(callData.balanceAfter)).toBe(500); // 0 + 500
    expect(callData.paymentAmount).toBeNull();
  });

  it('adds charge on top of existing balance', async () => {
    // Existing balance of 200 (tenant already owes 200)
    const existing = makeEntry({ balanceAfter: new Prisma.Decimal(200) });
    prismaMock.ledgerEntry.findFirst.mockResolvedValue(existing as any);
    prismaMock.ledgerEntry.findUnique.mockResolvedValue(null);
    const created = makeEntry({ balanceAfter: new Prisma.Decimal(700) });
    prismaMock.ledgerEntry.create.mockResolvedValue(created as any);

    await postCharge({
      tenantMembershipId: MEMBERSHIP_ID,
      effectiveDate: TODAY,
      code: 'RNTA',
      description: 'Apartment Rent',
      amount: 500,
    });

    const callData = prismaMock.ledgerEntry.create.mock.calls[0][0].data;
    expect(Number(callData.balanceAfter)).toBe(700); // 200 + 500
  });

  it('is idempotent — returns existing entry without creating a duplicate', async () => {
    const existing = makeEntry({ referenceId: 'RNTA-m-2026-07' });
    prismaMock.ledgerEntry.findUnique.mockResolvedValue(existing as any);

    const result = await postCharge({
      tenantMembershipId: MEMBERSHIP_ID,
      effectiveDate: TODAY,
      code: 'RNTA',
      description: 'Rent',
      amount: 500,
      referenceId: 'RNTA-m-2026-07',
    });

    expect(prismaMock.ledgerEntry.create).not.toHaveBeenCalled();
    expect(result.id).toBe('entry-1');
  });

  it('throws if amount is zero or negative', async () => {
    await expect(
      postCharge({
        tenantMembershipId: MEMBERSHIP_ID,
        effectiveDate: TODAY,
        code: 'FEE',
        description: 'Bad fee',
        amount: 0,
      })
    ).rejects.toThrow('Charge amount must be positive');

    await expect(
      postCharge({
        tenantMembershipId: MEMBERSHIP_ID,
        effectiveDate: TODAY,
        code: 'FEE',
        description: 'Negative fee',
        amount: -100,
      })
    ).rejects.toThrow('Charge amount must be positive');
  });
});

// ─── postPayment ──────────────────────────────────────────────────────────────

describe('postPayment', () => {
  it('creates a payment entry and reduces the balance', async () => {
    const existingBalance = makeEntry({ balanceAfter: new Prisma.Decimal(1000) });
    prismaMock.ledgerEntry.findFirst.mockResolvedValue(existingBalance as any);
    prismaMock.ledgerEntry.findUnique.mockResolvedValue(null);
    const created = makeEntry({
      type: 'PAYMENT',
      chargeAmount: null,
      paymentAmount: new Prisma.Decimal(600),
      balanceAfter: new Prisma.Decimal(400),
    });
    prismaMock.ledgerEntry.create.mockResolvedValue(created as any);

    await postPayment({
      tenantMembershipId: MEMBERSHIP_ID,
      effectiveDate: TODAY,
      description: 'Cheque #1234',
      amount: 600,
      source: 'MANUAL',
    });

    const callData = prismaMock.ledgerEntry.create.mock.calls[0][0].data;
    expect(callData.type).toBe('PAYMENT');
    expect(callData.code).toBeNull(); // payments never have codes
    expect(Number(callData.paymentAmount)).toBe(600);
    expect(Number(callData.balanceAfter)).toBe(400); // 1000 - 600
    expect(callData.chargeAmount).toBeNull();
  });

  it('allows overpayment — balance becomes negative (credit carry-forward)', async () => {
    const existingBalance = makeEntry({ balanceAfter: new Prisma.Decimal(500) });
    prismaMock.ledgerEntry.findFirst.mockResolvedValue(existingBalance as any);
    prismaMock.ledgerEntry.findUnique.mockResolvedValue(null);
    const created = makeEntry({
      type: 'PAYMENT',
      paymentAmount: new Prisma.Decimal(600),
      balanceAfter: new Prisma.Decimal(-100),
    });
    prismaMock.ledgerEntry.create.mockResolvedValue(created as any);

    await postPayment({
      tenantMembershipId: MEMBERSHIP_ID,
      effectiveDate: TODAY,
      description: 'Overpayment',
      amount: 600,
      source: 'MANUAL',
    });

    const callData = prismaMock.ledgerEntry.create.mock.calls[0][0].data;
    // Balance goes to -100 (credit). No error — this is correct behaviour.
    expect(Number(callData.balanceAfter)).toBe(-100);
  });

  it('credit carry-forward: next rent charge adds on top of negative balance', async () => {
    // Balance is -100 (tenant has a $100 credit)
    const creditBalance = makeEntry({ balanceAfter: new Prisma.Decimal(-100) });
    prismaMock.ledgerEntry.findFirst.mockResolvedValue(creditBalance as any);
    prismaMock.ledgerEntry.findUnique.mockResolvedValue(null);
    const created = makeEntry({ balanceAfter: new Prisma.Decimal(400) });
    prismaMock.ledgerEntry.create.mockResolvedValue(created as any);

    await postCharge({
      tenantMembershipId: MEMBERSHIP_ID,
      effectiveDate: TODAY,
      code: 'RNTA',
      description: 'Rent next month',
      amount: 500,
    });

    const callData = prismaMock.ledgerEntry.create.mock.calls[0][0].data;
    expect(Number(callData.balanceAfter)).toBe(400); // -100 + 500 = 400
  });

  it('is idempotent — returns existing entry without creating a duplicate', async () => {
    const existing = makeEntry({ type: 'PAYMENT', referenceId: 'PMNT-STRIPE-pi_abc' });
    prismaMock.ledgerEntry.findUnique.mockResolvedValue(existing as any);

    await postPayment({
      tenantMembershipId: MEMBERSHIP_ID,
      effectiveDate: TODAY,
      description: 'Online Payment',
      amount: 500,
      source: 'STRIPE',
      referenceId: 'PMNT-STRIPE-pi_abc',
    });

    expect(prismaMock.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('throws if amount is zero or negative', async () => {
    await expect(
      postPayment({
        tenantMembershipId: MEMBERSHIP_ID,
        effectiveDate: TODAY,
        description: 'Nothing',
        amount: 0,
        source: 'MANUAL',
      })
    ).rejects.toThrow('Payment amount must be positive');
  });
});

// ─── postCredit ───────────────────────────────────────────────────────────────

describe('postCredit', () => {
  it('reduces the balance by the credit amount', async () => {
    const existingBalance = makeEntry({ balanceAfter: new Prisma.Decimal(500) });
    prismaMock.ledgerEntry.findFirst.mockResolvedValue(existingBalance as any);
    prismaMock.ledgerEntry.findUnique.mockResolvedValue(null);
    const created = makeEntry({
      type: 'CREDIT',
      code: 'CONC',
      chargeAmount: null,
      paymentAmount: new Prisma.Decimal(300),
      balanceAfter: new Prisma.Decimal(200),
    });
    prismaMock.ledgerEntry.create.mockResolvedValue(created as any);

    await postCredit({
      tenantMembershipId: MEMBERSHIP_ID,
      effectiveDate: TODAY,
      code: 'CONC',
      description: 'Concession August 2026',
      amount: 300,
    });

    const callData = prismaMock.ledgerEntry.create.mock.calls[0][0].data;
    expect(callData.type).toBe('CREDIT');
    expect(callData.code).toBe('CONC');
    expect(Number(callData.paymentAmount)).toBe(300);
    expect(Number(callData.balanceAfter)).toBe(200); // 500 - 300
  });

  it('concession on zero balance creates a credit (negative balance)', async () => {
    prismaMock.ledgerEntry.findFirst.mockResolvedValue(null); // balance = 0
    prismaMock.ledgerEntry.findUnique.mockResolvedValue(null);
    const created = makeEntry({
      type: 'CREDIT',
      paymentAmount: new Prisma.Decimal(300),
      balanceAfter: new Prisma.Decimal(-300),
    });
    prismaMock.ledgerEntry.create.mockResolvedValue(created as any);

    await postCredit({
      tenantMembershipId: MEMBERSHIP_ID,
      effectiveDate: TODAY,
      code: 'CONC',
      description: 'Free month',
      amount: 300,
    });

    const callData = prismaMock.ledgerEntry.create.mock.calls[0][0].data;
    expect(Number(callData.balanceAfter)).toBe(-300);
  });

  it('throws if amount is zero or negative', async () => {
    await expect(
      postCredit({
        tenantMembershipId: MEMBERSHIP_ID,
        effectiveDate: TODAY,
        code: 'CONC',
        description: 'Bad credit',
        amount: -50,
      })
    ).rejects.toThrow('Credit amount must be positive');
  });
});

// ─── getCurrentBalance ────────────────────────────────────────────────────────

describe('getCurrentBalance', () => {
  it('returns 0 when there are no ledger entries', async () => {
    prismaMock.ledgerEntry.findFirst.mockResolvedValue(null);
    const balance = await getCurrentBalance(MEMBERSHIP_ID);
    expect(balance).toBe(0);
  });

  it('returns the balanceAfter of the most recent POSTED entry', async () => {
    const lastEntry = makeEntry({ balanceAfter: new Prisma.Decimal(1234.56) });
    // findFirst called twice: once to check if any exist, once for last
    prismaMock.ledgerEntry.findFirst
      .mockResolvedValueOnce(lastEntry as any)  // first call: exists check
      .mockResolvedValueOnce(lastEntry as any); // second call: get latest

    const balance = await getCurrentBalance(MEMBERSHIP_ID);
    expect(balance).toBe(1234.56);
  });

  it('returns negative balance (credit) when tenant has overpaid', async () => {
    const creditEntry = makeEntry({ balanceAfter: new Prisma.Decimal(-150) });
    prismaMock.ledgerEntry.findFirst
      .mockResolvedValueOnce(creditEntry as any)
      .mockResolvedValueOnce(creditEntry as any);

    const balance = await getCurrentBalance(MEMBERSHIP_ID);
    expect(balance).toBe(-150);
  });
});

// ─── getStatement ─────────────────────────────────────────────────────────────

describe('getStatement', () => {
  const entries = [
    makeEntry({ id: 'e1', effectiveDate: new Date('2026-06-01'), balanceAfter: new Prisma.Decimal(1000) }),
    makeEntry({
      id: 'e2',
      effectiveDate: new Date('2026-06-05'),
      type: 'PAYMENT',
      chargeAmount: null,
      paymentAmount: new Prisma.Decimal(600),
      balanceAfter: new Prisma.Decimal(400),
    }),
  ];

  it('returns posted entries mapped to statement rows', async () => {
    prismaMock.ledgerEntry.findMany.mockResolvedValue(entries as any);

    const rows = await getStatement(MEMBERSHIP_ID);

    expect(rows).toHaveLength(2);
    expect(rows[0].balanceAfter).toBe(1000);
    expect(rows[1].balanceAfter).toBe(400);
    expect(rows[0].chargeAmount).toBe(1000);
    expect(rows[1].paymentAmount).toBe(600);
  });

  it('queries only POSTED entries by default', async () => {
    prismaMock.ledgerEntry.findMany.mockResolvedValue([]);

    await getStatement(MEMBERSHIP_ID);

    const where = prismaMock.ledgerEntry.findMany.mock.calls[0][0]?.where;
    expect(where?.status).toEqual({ equals: 'POSTED' });
  });

  it('includes PENDING entries when includePending flag is set', async () => {
    prismaMock.ledgerEntry.findMany.mockResolvedValue([]);

    await getStatement(MEMBERSHIP_ID, { includePending: true });

    const where = prismaMock.ledgerEntry.findMany.mock.calls[0][0]?.where;
    expect(where?.status).toEqual({ in: ['POSTED', 'PENDING'] });
  });

  it('applies date range filters when provided', async () => {
    prismaMock.ledgerEntry.findMany.mockResolvedValue([]);
    const from = new Date('2026-06-01');
    const to = new Date('2026-06-30');

    await getStatement(MEMBERSHIP_ID, { fromDate: from, toDate: to });

    const where = prismaMock.ledgerEntry.findMany.mock.calls[0][0]?.where;
    expect(where?.effectiveDate).toEqual({ gte: from, lte: to });
  });

  it('returns an empty array when no entries exist', async () => {
    prismaMock.ledgerEntry.findMany.mockResolvedValue([]);
    const rows = await getStatement(MEMBERSHIP_ID);
    expect(rows).toEqual([]);
  });
});

// ─── getLedgerSummary ─────────────────────────────────────────────────────────

describe('getLedgerSummary', () => {
  it('returns zeros and null when no entries', async () => {
    prismaMock.ledgerEntry.findMany.mockResolvedValue([]);
    const summary = await getLedgerSummary(MEMBERSHIP_ID);
    expect(summary).toEqual({
      currentBalance: 0,
      lastPostedDate: null,
      totalCharged: 0,
      totalPaid: 0,
    });
  });

  it('computes totalCharged, totalPaid, and currentBalance from entries', async () => {
    const entries = [
      makeEntry({
        id: 'e1',
        type: 'CHARGE',
        chargeAmount: new Prisma.Decimal(1000),
        paymentAmount: null,
        balanceAfter: new Prisma.Decimal(1000),
        effectiveDate: new Date('2026-06-01'),
      }),
      makeEntry({
        id: 'e2',
        type: 'CHARGE',
        chargeAmount: new Prisma.Decimal(1000),
        paymentAmount: null,
        balanceAfter: new Prisma.Decimal(2000),
        effectiveDate: new Date('2026-07-01'),
      }),
      makeEntry({
        id: 'e3',
        type: 'PAYMENT',
        chargeAmount: null,
        paymentAmount: new Prisma.Decimal(1500),
        balanceAfter: new Prisma.Decimal(500),
        effectiveDate: new Date('2026-07-05'),
      }),
    ];
    // findMany returns entries ordered by effectiveDate DESC (first element is the latest)
    prismaMock.ledgerEntry.findMany.mockResolvedValue([entries[2], entries[1], entries[0]] as any);

    const summary = await getLedgerSummary(MEMBERSHIP_ID);

    expect(summary.currentBalance).toBe(500);   // latest balanceAfter
    expect(summary.totalCharged).toBe(2000);    // 1000 + 1000
    expect(summary.totalPaid).toBe(1500);       // 1500
    expect(summary.lastPostedDate).toEqual(new Date('2026-07-05'));
  });

  it('reflects credit when overpayment exists', async () => {
    const entries = [
      makeEntry({
        id: 'e1',
        type: 'PAYMENT',
        chargeAmount: null,
        paymentAmount: new Prisma.Decimal(600),
        balanceAfter: new Prisma.Decimal(-100), // overpaid
        effectiveDate: new Date('2026-07-03'),
      }),
    ];
    prismaMock.ledgerEntry.findMany.mockResolvedValue(entries as any);

    const summary = await getLedgerSummary(MEMBERSHIP_ID);
    expect(summary.currentBalance).toBe(-100);
  });
});
