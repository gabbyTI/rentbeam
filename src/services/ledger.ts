import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emailService } from './email.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PostChargeParams {
  tenantMembershipId: string;
  effectiveDate: Date;
  code: string;               // e.g. RNTA, FEE, CONC, DEPO, ADJ
  description: string;
  amount: number;
  source?: 'SYSTEM' | 'MANUAL' | 'STRIPE';
  referenceId?: string;       // idempotency key — if supplied, skip if already exists
  postedBy?: string;          // userId of landlord
}

export interface PostPaymentParams {
  tenantMembershipId: string;
  effectiveDate: Date;
  description: string;
  amount: number;
  source: 'STRIPE' | 'MANUAL';
  referenceId?: string;       // Stripe paymentIntentId / eventId / manual ref
  postedBy?: string;
}

export interface PostCreditParams {
  tenantMembershipId: string;
  effectiveDate: Date;
  code: string;               // e.g. CONC, ADJ
  description: string;
  amount: number;
  source?: 'SYSTEM' | 'MANUAL';
  referenceId?: string;
  postedBy?: string;
}

export interface LedgerStatementRow {
  id: string;
  effectiveDate: Date;
  type: string;
  status: string;
  source: string;
  code: string | null;
  description: string;
  chargeAmount: number | null;
  paymentAmount: number | null;
  balanceAfter: number;
  referenceId: string | null;
  createdAt: Date;
}

export interface LedgerSummary {
  currentBalance: number;       // Positive = tenant owes. Negative = tenant has credit.
  lastPostedDate: Date | null;
  totalCharged: number;
  totalPaid: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get the last POSTED balance for a tenant membership.
 * Returns 0 if no entries exist yet.
 */
async function getLastPostedBalance(tenantMembershipId: string): Promise<number> {
  const entries = await prisma.ledgerEntry.findMany({
    where: {
      tenantMembershipId,
      status: 'POSTED',
    },
    orderBy: [{ createdAt: 'asc' }, { effectiveDate: 'asc' }],
  });

  return calculateBalance(entries);
}

function calculateBalance(entries: Array<{
  type: string;
  chargeAmount: Prisma.Decimal | null;
  paymentAmount: Prisma.Decimal | null;
}>): number {
  return entries.reduce((balance, entry) => {
    if (entry.type === 'CHARGE') return balance + Number(entry.chargeAmount ?? 0);
    if (entry.type === 'PAYMENT' || entry.type === 'CREDIT') {
      return balance - Number(entry.paymentAmount ?? 0);
    }
    return balance;
  }, 0);
}

// ─── Core Service ─────────────────────────────────────────────────────────────

/**
 * Post a charge (increases balance).
 * Charge rows have codes (RNTA, FEE, DEPO, ADJ, etc.).
 * Idempotent: if referenceId already exists, returns the existing entry.
 */
export async function postCharge(params: PostChargeParams) {
  const { tenantMembershipId, effectiveDate, code, description, amount, source = 'MANUAL', referenceId, postedBy } = params;

  if (amount <= 0) throw new Error('Charge amount must be positive');

  // Idempotency check
  if (referenceId) {
    const existing = await prisma.ledgerEntry.findUnique({ where: { referenceId } });
    if (existing) {
      logger.info({ referenceId, entryId: existing.id }, 'Ledger charge already posted (idempotency), skipping');
      return existing;
    }
  }

  const previousBalance = await getLastPostedBalance(tenantMembershipId);
  const balanceAfter = previousBalance + amount;

  const entry = await prisma.ledgerEntry.create({
    data: {
      tenantMembershipId,
      effectiveDate,
      type: 'CHARGE',
      status: 'POSTED',
      source,
      code,
      description,
      chargeAmount: new Prisma.Decimal(amount),
      paymentAmount: null,
      balanceAfter: new Prisma.Decimal(balanceAfter),
      referenceId: referenceId ?? null,
      postedBy: postedBy ?? null,
    },
  });

  logger.info({
    entryId: entry.id,
    tenantMembershipId,
    code,
    amount,
    balanceAfter,
  }, 'Ledger charge posted');

  await notifyTenantOfLedgerEntry({
    tenantMembershipId,
    entryType: 'CHARGE',
    description,
    amount,
    balanceAfter,
  });

  return entry;
}

/**
 * Post a payment (decreases balance).
 * Payment rows have NO code.
 * Idempotent: if referenceId already exists, returns existing entry.
 * Overpayment (balance goes negative) is allowed — it becomes a credit.
 */
export async function postPayment(params: PostPaymentParams) {
  const { tenantMembershipId, effectiveDate, description, amount, source, referenceId, postedBy } = params;

  if (amount <= 0) throw new Error('Payment amount must be positive');

  // Idempotency check
  if (referenceId) {
    const existing = await prisma.ledgerEntry.findUnique({ where: { referenceId } });
    if (existing) {
      logger.info({ referenceId, entryId: existing.id }, 'Ledger payment already posted (idempotency), skipping');
      return existing;
    }
  }

  const previousBalance = await getLastPostedBalance(tenantMembershipId);
  const balanceAfter = previousBalance - amount; // Can go negative (credit)

  const entry = await prisma.ledgerEntry.create({
    data: {
      tenantMembershipId,
      effectiveDate,
      type: 'PAYMENT',
      status: 'POSTED',
      source,
      code: null,             // Payments never have codes
      description,
      chargeAmount: null,
      paymentAmount: new Prisma.Decimal(amount),
      balanceAfter: new Prisma.Decimal(balanceAfter),
      referenceId: referenceId ?? null,
      postedBy: postedBy ?? null,
    },
  });

  logger.info({
    entryId: entry.id,
    tenantMembershipId,
    amount,
    balanceAfter,
    source,
  }, 'Ledger payment posted');

  await notifyTenantOfLedgerEntry({
    tenantMembershipId,
    entryType: 'PAYMENT',
    description,
    amount,
    balanceAfter,
  });

  return entry;
}

/**
 * Post a credit (decreases balance — concession, write-off, adjustment).
 * Credit rows have codes but are displayed in the Charge column as a negative,
 * or in a separate "Credit" area depending on UI choice.
 * Balance effect: reduces what tenant owes.
 */
export async function postCredit(params: PostCreditParams) {
  const { tenantMembershipId, effectiveDate, code, description, amount, source = 'MANUAL', referenceId, postedBy } = params;

  if (amount <= 0) throw new Error('Credit amount must be positive');

  // Idempotency check
  if (referenceId) {
    const existing = await prisma.ledgerEntry.findUnique({ where: { referenceId } });
    if (existing) {
      logger.info({ referenceId, entryId: existing.id }, 'Ledger credit already posted (idempotency), skipping');
      return existing;
    }
  }

  const previousBalance = await getLastPostedBalance(tenantMembershipId);
  const balanceAfter = previousBalance - amount; // Credits reduce balance, can go negative

  const entry = await prisma.ledgerEntry.create({
    data: {
      tenantMembershipId,
      effectiveDate,
      type: 'CREDIT',
      status: 'POSTED',
      source,
      code,
      description,
      chargeAmount: null,
      paymentAmount: new Prisma.Decimal(amount), // Store in paymentAmount so balance math is consistent
      balanceAfter: new Prisma.Decimal(balanceAfter),
      referenceId: referenceId ?? null,
      postedBy: postedBy ?? null,
    },
  });

  logger.info({
    entryId: entry.id,
    tenantMembershipId,
    code,
    amount,
    balanceAfter,
  }, 'Ledger credit posted');

  await notifyTenantOfLedgerEntry({
    tenantMembershipId,
    entryType: 'CREDIT',
    description,
    amount,
    balanceAfter,
  });

  return entry;
}

async function notifyTenantOfLedgerEntry(params: {
  tenantMembershipId: string;
  entryType: 'CHARGE' | 'PAYMENT' | 'CREDIT';
  description: string;
  amount: number;
  balanceAfter: number;
}) {
  try {
    const membership = await prisma.tenantMembership.findUnique({
      where: { id: params.tenantMembershipId },
      include: {
        user: true,
        unit: { include: { property: true } },
      },
    });

    if (!membership || !membership.user) return;

    const recipientEmail = membership.user.notificationEmail || membership.user.email;
    if (!recipientEmail) return;

    await emailService.sendLedgerEntryAlert({
      email: recipientEmail,
      tenantName: membership.user.name,
      propertyName: membership.unit.property.name,
      unitName: membership.unit.name,
      entryType: params.entryType,
      description: params.description,
      amount: params.amount.toFixed(2),
      balanceAfter: params.balanceAfter.toFixed(2),
    });
  } catch (error) {
    logger.error({ error, tenantMembershipId: params.tenantMembershipId }, 'Failed to notify tenant of ledger update');
  }
}

/**
 * Get the current posted balance for a tenant.
 * Positive = tenant owes money.
 * Negative = tenant has a credit.
 */
export async function getCurrentBalance(tenantMembershipId: string): Promise<number> {
  const entries = await prisma.ledgerEntry.findMany({
    where: { tenantMembershipId, status: 'POSTED' },
    orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
  });

  return calculateBalance(entries);
}

/**
 * Return the positive outstanding amount currently due from a tenant.
 * Negative balances represent credits, which should not be charged again.
 */
export async function getOutstandingBalance(tenantMembershipId: string): Promise<number> {
  const entries = await prisma.ledgerEntry.findMany({
    where: { tenantMembershipId, status: 'POSTED' },
    orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
  });

  const currentBalance = calculateBalance(entries);
  return Math.max(currentBalance, 0);
}

/**
 * Get the full ledger statement for a tenant.
 * Returns all POSTED entries ordered by posting time ASC.
 * effectiveDate remains the accounting date displayed on each row.
 * Pending entries excluded from statement by default.
 */
export async function getStatement(
  tenantMembershipId: string,
  options?: { includePending?: boolean; fromDate?: Date; toDate?: Date }
): Promise<LedgerStatementRow[]> {
  const statusFilter = options?.includePending
    ? { in: ['POSTED', 'PENDING'] as ('POSTED' | 'PENDING')[] }
    : { equals: 'POSTED' as const };

  const entries = await prisma.ledgerEntry.findMany({
    where: {
      tenantMembershipId,
      status: statusFilter,
      ...(options?.fromDate || options?.toDate
        ? {
            effectiveDate: {
              ...(options.fromDate ? { gte: options.fromDate } : {}),
              ...(options.toDate ? { lte: options.toDate } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { effectiveDate: 'asc' }],
  });

  let runningBalance = 0;
  return entries.map((e) => {
    if (e.type === 'CHARGE') runningBalance += Number(e.chargeAmount ?? 0);
    if (e.type === 'PAYMENT' || e.type === 'CREDIT') runningBalance -= Number(e.paymentAmount ?? 0);

    return {
    id: e.id,
    effectiveDate: e.effectiveDate,
    type: e.type,
    status: e.status,
    source: e.source,
    code: e.code,
    description: e.description,
    chargeAmount: e.chargeAmount ? Number(e.chargeAmount) : null,
    paymentAmount: e.paymentAmount ? Number(e.paymentAmount) : null,
    balanceAfter: runningBalance,
    referenceId: e.referenceId,
    createdAt: e.createdAt,
    };
  });
}

/**
 * Get a summary of current balance and totals for a tenant.
 */
export async function getLedgerSummary(tenantMembershipId: string): Promise<LedgerSummary> {
  const entries = await prisma.ledgerEntry.findMany({
    where: { tenantMembershipId, status: 'POSTED' },
    orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
  });

  if (entries.length === 0) {
    return { currentBalance: 0, lastPostedDate: null, totalCharged: 0, totalPaid: 0 };
  }

  const currentBalance = calculateBalance(entries);
  const lastPostedDate = entries.reduce(
    (latest, entry) => entry.createdAt > latest.createdAt ? entry : latest,
    entries[0]
  ).effectiveDate;

  const totalCharged = entries
    .filter((e) => e.type === 'CHARGE')
    .reduce((sum, e) => sum + Number(e.chargeAmount ?? 0), 0);

  const totalPaid = entries
    .filter((e) => e.type === 'PAYMENT')
    .reduce((sum, e) => sum + Number(e.paymentAmount ?? 0), 0);

  return { currentBalance, lastPostedDate, totalCharged, totalPaid };
}
