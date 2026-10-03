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

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function getMonthlyDueDate(year: number, month: number, dueDay: number): Date {
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(Math.max(dueDay, 1), lastDayOfMonth)));
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

  let start = getMonthlyDueDate(year, month, dueDay);
  if (start > startOfUtcDay(utcDate)) {
    start = getMonthlyDueDate(year, month - 1, dueDay);
  }

  const nextStart = getMonthlyDueDate(start.getUTCFullYear(), start.getUTCMonth() + 1, dueDay);
  const end = new Date(nextStart.getTime() - 1);

  return { start, end };
}

function isMonthlyDueDate(date: Date, dueDay: number): boolean {
  return date.getUTCDate() === getMonthlyDueDate(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    dueDay,
  ).getUTCDate();
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

export async function generateRecurringUnitChargesForDate(date: Date, ruleId?: string) {
  const activeRules = await prisma.unitRecurringChargeRule.findMany({
    where: {
      active: true,
      effectiveDate: { lte: date },
      ...(ruleId ? { id: ruleId } : {}),
    },
    include: {
      unit: {
        include: {
          tenantMemberships: {
            where: {
              status: 'ACTIVE',
              moveInDate: { lte: date },
              OR: [{ moveOutDate: null }, { moveOutDate: { gt: date } }],
            },
          },
        },
      },
      chargeType: true,
    },
  });

  const generated: Array<{ id: string; tenantMembershipId: string; amount: number; effectiveDate: Date }> = [];
  const errors: Array<{ ruleId: string; error: string }> = [];

  for (const rule of activeRules) {
    try {
      const todayDate = startOfUtcDay(date);
      const ruleStartDate = startOfUtcDay(new Date(rule.effectiveDate));
      const ruleEndDate = rule.endDate ? startOfUtcDay(new Date(rule.endDate)) : null;
      if (!rule.active || todayDate < ruleStartDate || (ruleEndDate && todayDate > ruleEndDate)) continue;

      const activeTenant = rule.unit.tenantMemberships[0];
      if (!activeTenant) continue;

      const amount = Number(rule.amount);
      let effectiveDate: Date;
      let ruleAmount: number;
      let referenceId: string;

      if (rule.frequency === 'MONTHLY') {
        const unitDueDay = rule.unit.dueDay;
        const currentWindow = getBillingPeriodWindow({
          date: todayDate,
          dueDay: unitDueDay,
          frequency: 'MONTHLY',
        });
        const effectiveWindow = getBillingPeriodWindow({
          date: ruleStartDate,
          dueDay: unitDueDay,
          frequency: 'MONTHLY',
        });
        const isInitialCycle = currentWindow.start.getTime() === effectiveWindow.start.getTime();
        const isDueDate = isMonthlyDueDate(todayDate, unitDueDay);
        if (!isInitialCycle && !isDueDate) continue;

        const chargeStart = new Date(Math.max(
          ruleStartDate.getTime(),
          startOfUtcDay(new Date(activeTenant.moveInDate)).getTime(),
        ));
        if (chargeStart > currentWindow.end) continue;

        effectiveDate = isInitialCycle ? chargeStart : todayDate;
        ruleAmount = isInitialCycle
          ? calculateProratedChargeAmount({
              amount,
              effectiveDate,
              periodStart: currentWindow.start,
              periodEnd: currentWindow.end,
            })
          : amount;
        referenceId = `RC-${rule.id}-${activeTenant.id}-${currentWindow.start.toISOString().slice(0, 10)}`;
      } else {
        const shouldGenerate = shouldGenerateRecurringCharge({
          ruleStartDate,
          ruleEndDate,
          isActive: rule.active,
          today: date,
          dueDay: rule.dueDay,
        });
        if (!shouldGenerate) continue;

        effectiveDate = todayDate;
        ruleAmount = getRuleChargeAmount({
          amount,
          effectiveDate,
          dueDay: rule.dueDay,
          frequency: rule.frequency,
        });
        referenceId = `RC-${rule.id}-${effectiveDate.toISOString().slice(0, 10)}`;
      }

      if (ruleAmount <= 0) continue;

      const entry = await postCharge({
        tenantMembershipId: activeTenant.id,
        effectiveDate,
        code: String(rule.chargeType.code),
        description: rule.description || rule.chargeType.name,
        amount: ruleAmount,
        source: 'SYSTEM',
        referenceId,
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
      errors.push({ ruleId: rule.id, error: error.message });
      logger.error({ error: error.message, ruleId: rule.id }, 'Failed to generate recurring charge');
    }
  }

  return { generated, errors };
}
