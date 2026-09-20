/**
 * tests/jobs/autopay.test.ts
 *
 * Focused regression tests for ledger-first autopay behavior.
 */

import { Prisma } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

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
  paymentsTotal: { inc: jest.fn() },
  paymentsAmountCents: { inc: jest.fn() },
}));

jest.mock('../../src/services/email.js', () => ({
  __esModule: true,
  emailService: {
    sendAutopayAttemptEmail: jest.fn(),
  },
}));

const mockCreatePaymentIntent = jest.fn();
jest.mock('../../src/services/stripe.js', () => ({
  stripeService: {
    calculateProcessingFee: jest.fn((amount: number) => ({
      processingFee: Number((amount * 0.029 + 0.3).toFixed(2)),
      totalAmount: Number((amount + amount * 0.029 + 0.3).toFixed(2)),
      rentAmount: Number(amount.toFixed(2)),
    })),
    createPaymentIntent: (...args: any[]) => mockCreatePaymentIntent(...args),
  },
}));

const mockGetOutstandingBalance = jest.fn();
jest.mock('../../src/services/ledger.js', () => ({
  getOutstandingBalance: (...args: any[]) => mockGetOutstandingBalance(...args),
}));

import prismaMock_ from '../../src/lib/prisma.js';
const prismaMock = prismaMock_ as unknown as DeepMockProxy<PrismaClient>;
import { getAutopayWindow, processAutopayCharges } from '../../src/jobs/autopay.js';

beforeEach(() => {
  const { mockReset } = require('jest-mock-extended');
  mockReset(prismaMock);
  mockCreatePaymentIntent.mockReset();
  mockGetOutstandingBalance.mockReset();
});

function makeTenant(overrides: Partial<any> = {}) {
  const today = new Date();
  const dueDay = today.getDate();

  return {
    id: 'tenant-1',
    user: {
      name: 'Test Tenant',
      email: 'tenant@example.com',
      notificationEmail: 'alerts@example.com',
    },
    autopayEnabled: true,
    status: 'ACTIVE',
    defaultPaymentMethodId: 'pm_123',
    stripeCustomerId: 'cus_123',
    autopayFailureCount: 0,
    paymentMethodType: 'card',
    unit: {
      dueDay,
      gracePeriodDays: 5,
      rentAmount: new Prisma.Decimal(1200),
      property: {
        acceptOnlinePayments: true,
        landlord: {
          id: 'landlord-1',
          stripeAccountId: 'acct_123',
          user: { country: 'CA' },
        },
      },
    },
    payments: [],
    ...overrides,
  };
}

describe('processAutopayCharges', () => {
  it('resolves a grace period that crosses into the next month', () => {
    const window = getAutopayWindow(new Date('2026-10-02T12:00:00'), 28, 5);

    expect(window.billingMonth).toBe('2026-09');
    expect(window.isWithinWindow).toBe(true);
  });

  it('does not treat a successful partial payment as a completed Autopay cycle', async () => {
    prismaMock.tenantMembership.findMany.mockResolvedValue([
      makeTenant({
        payments: [{ status: 'SUCCEEDED' }],
      }),
    ] as any);
    mockGetOutstandingBalance.mockResolvedValue(900);
    mockCreatePaymentIntent.mockResolvedValue({ status: 'succeeded', id: 'pi_123' });

    const result = await processAutopayCharges();

    expect(result.succeeded).toBe(1);
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('skips tenants with no outstanding ledger balance', async () => {
    prismaMock.tenantMembership.findMany.mockResolvedValue([makeTenant()] as any);
    mockGetOutstandingBalance.mockResolvedValue(0);

    const result = await processAutopayCharges();

    expect(result.skipped).toBe(1);
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it('creates a payment intent for the outstanding ledger balance', async () => {
    prismaMock.tenantMembership.findMany.mockResolvedValue([makeTenant()] as any);
    mockGetOutstandingBalance.mockResolvedValue(900);
    mockCreatePaymentIntent.mockResolvedValue({ status: 'succeeded', id: 'pi_123' });

    const result = await processAutopayCharges();

    expect(result.succeeded).toBe(1);
    expect(mockCreatePaymentIntent).toHaveBeenCalledWith(expect.objectContaining({
      amount: expect.any(Number),
      idempotencyKey: expect.stringMatching(/^autopay-tenant-1-/),
      metadata: expect.objectContaining({
        ledgerBalance: '900.00',
        rentAmount: '900.00',
      }),
    }));
  });
});
