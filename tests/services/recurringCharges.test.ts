jest.mock('../../src/lib/prisma.js', () => {
  const { mockDeep } = require('jest-mock-extended');
  return { __esModule: true, default: mockDeep() };
});

jest.mock('../../src/lib/logger.js', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/services/email.js', () => ({
  __esModule: true,
  emailService: {
    sendLedgerEntryAlert: jest.fn(),
  },
}));

import { calculateProratedChargeAmount, getBillingPeriodWindow, shouldGenerateRecurringCharge } from '../../src/services/recurringCharges.js';

describe('recurring charge rule helpers', () => {
  it('prorates from an effective date when the rule starts mid-cycle', () => {
    const periodStart = new Date('2026-10-01T00:00:00.000Z');
    const periodEnd = new Date('2026-10-31T23:59:59.999Z');
    const effectiveDate = new Date('2026-10-12T00:00:00.000Z');

    const amount = calculateProratedChargeAmount({
      amount: 100,
      effectiveDate,
      periodStart,
      periodEnd,
    });

    expect(amount).toBeCloseTo(64.52, 2);
  });

  it('returns a full billing window for a monthly cycle using a fixed due day', () => {
    const window = getBillingPeriodWindow({
      date: new Date('2026-10-15T00:00:00.000Z'),
      dueDay: 15,
      frequency: 'MONTHLY',
    });

    expect(window.start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-10-31T23:59:59.999Z');
  });

  it('does not generate a charge until the rule is active and the date matches the billing day', () => {
    const today = new Date('2026-10-15T12:00:00.000Z');

    expect(shouldGenerateRecurringCharge({
      ruleStartDate: new Date('2026-10-01T00:00:00.000Z'),
      ruleEndDate: null,
      isActive: true,
      today,
      dueDay: 15,
    })).toBe(true);

    expect(shouldGenerateRecurringCharge({
      ruleStartDate: new Date('2026-10-16T00:00:00.000Z'),
      ruleEndDate: null,
      isActive: true,
      today,
      dueDay: 15,
    })).toBe(false);
  });
});
