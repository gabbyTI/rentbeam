import prisma from '../lib/prisma.js';
import { postCharge } from './ledger.js';
import logger from '../lib/logger.js';

export type ChargeFrequency = 'MONTHLY' | 'WEEKLY';

export interface BillingWindow {
  start: Date;
  end: Date;
}

export interface ProratedChargeInput {
  amount: number;
  effectiveDate: Date;
  periodStart: Date;
  periodEnd: Date;
}

export interface ShouldGenerateInput {
  ruleStartDate: Date;
  ruleEndDate: Date | null;
  isActive: boolean;
  today: Date;
  dueDay: number;
}

function getInclusiveDayCount(start: Date, end: Date): number {
  const startUtc = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  const endUtc = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate(),
  );

  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.floor((endUtc - startUtc) / msPerDay) + 1);
}

export function calculateProratedChargeAmount({
  amount,
  effectiveDate,
  periodStart,
  periodEnd,
}: ProratedChargeInput): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  const effectiveTime = new Date(effectiveDate).getTime();
  const periodStartTime = new Date(periodStart).getTime();
  const periodEndTime = new Date(periodEnd).getTime();

  if (effectiveTime > periodEndTime) return 0;

  const proratedStart = new Date(Math.max(periodStartTime, effectiveTime));
  const totalDays = getInclusiveDayCount(new Date(periodStart), new Date(periodEnd));
  const activeDays = getInclusiveDayCount(proratedStart, new Date(periodEnd));

  return Number(((amount * activeDays) / totalDays).toFixed(2));
}

export function getBillingPeriodWindow({
  date,
  dueDay,
  frequency,
}: {
  date: Date;
  dueDay: number;
  frequency: ChargeFrequency;
}): BillingWindow {
  const utcDate = new Date(date);
  const year = utcDate.getUTCFullYear();
  const month = utcDate.getUTCMonth();

  if (frequency === 'WEEKLY') {
    const dayOfWeek = utcDate.getUTCDay();
    const start = new Date(Date.UTC(year, month, utcDate.getUTCDate() - dayOfWeek, 0, 0, 0, 0));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    end.setUTCHours(23, 59, 59, 999);
    return { start, end };
  }

  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));

  const normalizedDueDay = Math.min(Math.max(dueDay, 1), 31);
  const periodStart = new Date(start);
  periodStart.setUTCDate(normalizedDueDay <= 1 ? 1 : 1);

  if (normalizedDueDay > 1) {
    const nextMonth = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
    const nextBillingDate = new Date(Date.UTC(year, month, normalizedDueDay, 0, 0, 0, 0));
    if (nextBillingDate > end) {
      return { start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)), end };
    }
  }

  return { start, end };
}

export function shouldGenerateRecurringCharge({
  ruleStartDate,
  ruleEndDate,
  isActive,
  today,
  dueDay,
}: ShouldGenerateInput): boolean {
  if (!isActive) return false;

  const dayOfMonth = today.getUTCDate();
  if (dayOfMonth !== dueDay) return false;
  if (today < ruleStartDate) return false;
  if (ruleEndDate && today > ruleEndDate) return false;

  return true;
}

export function getRuleChargeAmount({
  amount,
  effectiveDate,
  dueDay,
  frequency,
}: {
  amount: number;
  effectiveDate: Date;
  dueDay: number;
  frequency: ChargeFrequency;
}): number {
  const window = getBillingPeriodWindow({
    date: effectiveDate,
    dueDay,
    frequency,
  });

  const proratedAmount = calculateProratedChargeAmount({
    amount,
    effectiveDate,
    periodStart: window.start,
    periodEnd: window.end,
  });

  return Number(proratedAmount.toFixed(2));
}

export async function generateRecurringUnitChargesForDate(date: Date) {
  const activeRules = await prisma.unitRecurringChargeRule.findMany({
    where: {
      active: true,
      effectiveDate: { lte: date },
    },
    include: {
      unit: {
        include: {
          tenantMemberships: {
            where: { status: 'ACTIVE', moveInDate: { lte: date }, OR: [{ moveOutDate: null }, { moveOutDate: { gt: date } }] },
          },
        },
      },
      chargeType: true,
    },
  });

  const generated: Array<{ id: string; tenantMembershipId: string; amount: number; effectiveDate: Date }> = [];

  for (const rule of activeRules) {
    try {
      const todayDate = new Date(date);
      const shouldGenerate = shouldGenerateRecurringCharge({
        ruleStartDate: new Date(rule.effectiveDate),
        ruleEndDate: rule.endDate ? new Date(rule.endDate) : null,
        isActive: rule.active,
        today: todayDate,
        dueDay: rule.dueDay,
      });

      if (!shouldGenerate) continue;

      const activeTenant = rule.unit.tenantMemberships[0];
      if (!activeTenant) continue;

      const effectiveDate = new Date(todayDate);
      const ruleAmount = getRuleChargeAmount({
        amount: Number(rule.amount),
        effectiveDate,
        dueDay: rule.dueDay,
        frequency: rule.frequency,
      });

      if (ruleAmount <= 0) continue;

      const entry = await postCharge({
        tenantMembershipId: activeTenant.id,
        effectiveDate,
        code: String(rule.chargeType.code),
        description: rule.description || rule.chargeType.name,
        amount: ruleAmount,
        source: 'SYSTEM',
        referenceId: `RC-${rule.id}-${effectiveDate.toISOString().slice(0, 10)}`,
      });

      generated.push({
        id: entry.id,
        tenantMembershipId: activeTenant.id,
        amount: ruleAmount,
        effectiveDate,
      });

      await prisma.unitRecurringChargeRule.update({
        where: { id: rule.id },
        data: { lastGeneratedAt: effectiveDate },
      });

      logger.info({ ruleId: rule.id, tenantMembershipId: activeTenant.id, amount: ruleAmount }, 'Generated recurring charge from unit rule');
    } catch (error: any) {
      logger.error({ error: error.message, ruleId: rule.id }, 'Failed to generate recurring charge');
    }
  }

  return { generated };
}
