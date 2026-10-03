jest.mock('../../src/lib/prisma.js', () => {
  const { mockDeep } = require('jest-mock-extended');
  return { __esModule: true, default: mockDeep() };
});

jest.mock('../../src/lib/logger.js', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/services/ledger.js', () => ({
  postCharge: jest.fn(),
}));

jest.mock('../../src/services/email.js', () => ({
  __esModule: true,
  emailService: {
    sendLedgerEntryAlert: jest.fn(),
  },
}));

import prisma from '../../src/lib/prisma.js';
import { postCharge } from '../../src/services/ledger.js';
import {
  calculateProratedChargeAmount,
  generateRecurringUnitChargesForDate,
  getBillingPeriodWindow,
  shouldGenerateRecurringCharge,
} from '../../src/services/recurringCharges.js';

describe('recurring charge rule helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

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

  it('uses the unit rent due day as the monthly cycle boundary', () => {
    const window = getBillingPeriodWindow({
      date: new Date('2026-10-03T00:00:00.000Z'),
      dueDay: 15,
      frequency: 'MONTHLY',
    });

    expect(window.start.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-10-14T23:59:59.999Z');
  });

  it('clamps monthly cycle boundaries to the last day of short months', () => {
    const window = getBillingPeriodWindow({
      date: new Date('2026-02-28T00:00:00.000Z'),
      dueDay: 31,
      frequency: 'MONTHLY',
    });

    expect(window.start.toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-03-30T23:59:59.999Z');
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

  it('posts the effective-cycle charge prorated from the effective date', async () => {
    const rule = {
      id: 'rule-1',
      amount: 50,
      frequency: 'MONTHLY',
      dueDay: 1,
      effectiveDate: new Date('2026-10-03T00:00:00.000Z'),
      endDate: null,
      active: true,
      description: 'Parking',
      unit: {
        dueDay: 15,
        tenantMemberships: [{
          id: 'membership-1',
          moveInDate: new Date('2026-09-01T00:00:00.000Z'),
        }],
      },
      chargeType: { code: 'PARK', name: 'Parking' },
    };
    jest.mocked(prisma.unitRecurringChargeRule.findMany).mockResolvedValue([rule] as never);
    jest.mocked(postCharge).mockResolvedValue({ id: 'ledger-1' } as never);

    await generateRecurringUnitChargesForDate(new Date('2026-10-03T12:00:00.000Z'), 'rule-1');

    expect(postCharge).toHaveBeenCalledWith(expect.objectContaining({
      tenantMembershipId: 'membership-1',
      effectiveDate: new Date('2026-10-03T00:00:00.000Z'),
      amount: 20,
      referenceId: 'RC-rule-1-membership-1-2026-09-15',
    }));
  });

  it('posts the full amount on the next unit rent due day', async () => {
    const rule = {
      id: 'rule-1',
      amount: 50,
      frequency: 'MONTHLY',
      dueDay: 1,
      effectiveDate: new Date('2026-10-03T00:00:00.000Z'),
      endDate: null,
      active: true,
      description: 'Parking',
      unit: {
        dueDay: 15,
        tenantMemberships: [{
          id: 'membership-1',
          moveInDate: new Date('2026-09-01T00:00:00.000Z'),
        }],
      },
      chargeType: { code: 'PARK', name: 'Parking' },
    };
    jest.mocked(prisma.unitRecurringChargeRule.findMany).mockResolvedValue([rule] as never);
    jest.mocked(postCharge).mockResolvedValue({ id: 'ledger-2' } as never);

    await generateRecurringUnitChargesForDate(new Date('2026-11-15T12:00:00.000Z'), 'rule-1');

    expect(postCharge).toHaveBeenCalledWith(expect.objectContaining({
      tenantMembershipId: 'membership-1',
      effectiveDate: new Date('2026-11-15T00:00:00.000Z'),
      amount: 50,
      referenceId: 'RC-rule-1-membership-1-2026-11-15',
    }));
  });

  it('posts the full first-cycle amount when effective on the unit rent due day', async () => {
    const rule = {
      id: 'rule-1',
      amount: 50,
      frequency: 'MONTHLY',
      dueDay: 1,
      effectiveDate: new Date('2026-10-15T00:00:00.000Z'),
      endDate: null,
      active: true,
      description: 'Parking',
      unit: {
        dueDay: 15,
        tenantMemberships: [{
          id: 'membership-1',
          moveInDate: new Date('2026-09-01T00:00:00.000Z'),
        }],
      },
      chargeType: { code: 'PARK', name: 'Parking' },
    };
    jest.mocked(prisma.unitRecurringChargeRule.findMany).mockResolvedValue([rule] as never);
    jest.mocked(postCharge).mockResolvedValue({ id: 'ledger-3' } as never);

    await generateRecurringUnitChargesForDate(new Date('2026-10-15T12:00:00.000Z'), 'rule-1');

    expect(postCharge).toHaveBeenCalledWith(expect.objectContaining({
      effectiveDate: new Date('2026-10-15T00:00:00.000Z'),
      amount: 50,
      referenceId: 'RC-rule-1-membership-1-2026-10-15',
    }));
  });

  it('starts proration no earlier than the tenant move-in date', async () => {
    const rule = {
      id: 'rule-1',
      amount: 50,
      frequency: 'MONTHLY',
      dueDay: 1,
      effectiveDate: new Date('2026-10-03T00:00:00.000Z'),
      endDate: null,
      active: true,
      description: 'Parking',
      unit: {
        dueDay: 15,
        tenantMemberships: [{
          id: 'membership-1',
          moveInDate: new Date('2026-10-08T00:00:00.000Z'),
        }],
      },
      chargeType: { code: 'PARK', name: 'Parking' },
    };
    jest.mocked(prisma.unitRecurringChargeRule.findMany).mockResolvedValue([rule] as never);
    jest.mocked(postCharge).mockResolvedValue({ id: 'ledger-4' } as never);

    await generateRecurringUnitChargesForDate(new Date('2026-10-09T12:00:00.000Z'), 'rule-1');

    expect(postCharge).toHaveBeenCalledWith(expect.objectContaining({
      effectiveDate: new Date('2026-10-08T00:00:00.000Z'),
      amount: 11.67,
    }));
  });

  it('does not post when there is no eligible tenant on the unit', async () => {
    const rule = {
      id: 'rule-1',
      amount: 50,
      frequency: 'MONTHLY',
      dueDay: 1,
      effectiveDate: new Date('2026-10-03T00:00:00.000Z'),
      endDate: null,
      active: true,
      description: 'Parking',
      unit: { dueDay: 15, tenantMemberships: [] },
      chargeType: { code: 'PARK', name: 'Parking' },
    };
    jest.mocked(prisma.unitRecurringChargeRule.findMany).mockResolvedValue([rule] as never);

    const result = await generateRecurringUnitChargesForDate(new Date('2026-10-03T12:00:00.000Z'));

    expect(postCharge).not.toHaveBeenCalled();
    expect(result.generated).toEqual([]);
  });
});
