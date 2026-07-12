import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PostChargeParams {
  tenantMembershipId: string;
  effectiveDate: Date;
  code: string;               // e.g. RNTA, FEE, CONC, DEPO, ADJ
  description: string;
  amount: number;
  source?: 'SYSTEM' | 'MANUAL';
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
  const last = await prisma.ledgerEntry.findFirst({
    where: {
      tenantMembershipId,
      status: 'POSTED',
    },
    orderBy: [
      { effectiveDate: 'asc' },
      { createdAt: 'asc' },
    ],
    // Get the very last one
  });

  if (!last) return 0;

  // Find the true last posted entry
  const lastPosted = await prisma.ledgerEntry.findFirst({
    where: {
      tenantMembershipId,
      status: 'POSTED',
    },
    orderBy: [
      { effectiveDate: 'desc' },
      { createdAt: 'desc' },
    ],
  });

  return lastPosted ? Number(lastPosted.balanceAfter) : 0;
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

  return entry;
}

/**
 * Get the current posted balance for a tenant.
 * Positive = tenant owes money.
 * Negative = tenant has a credit.
 */
export async function getCurrentBalance(tenantMembershipId: string): Promise<number> {
  return getLastPostedBalance(tenantMembershipId);
}

/**
 * Get the full ledger statement for a tenant.
 * Returns all POSTED entries ordered by effectiveDate ASC, createdAt ASC.
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
    orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
  });

  return entries.map((e) => ({
    id: e.id,
    effectiveDate: e.effectiveDate,
    type: e.type,
    status: e.status,
    source: e.source,
    code: e.code,
    description: e.description,
    chargeAmount: e.chargeAmount ? Number(e.chargeAmount) : null,
    paymentAmount: e.paymentAmount ? Number(e.paymentAmount) : null,
    balanceAfter: Number(e.balanceAfter),
    referenceId: e.referenceId,
    createdAt: e.createdAt,
  }));
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

  const currentBalance = Number(entries[0].balanceAfter);
  const lastPostedDate = entries[0].effectiveDate;

  const totalCharged = entries
    .filter((e) => e.type === 'CHARGE')
    .reduce((sum, e) => sum + Number(e.chargeAmount ?? 0), 0);

  const totalPaid = entries
    .filter((e) => e.type === 'PAYMENT')
    .reduce((sum, e) => sum + Number(e.paymentAmount ?? 0), 0);

  return { currentBalance, lastPostedDate, totalCharged, totalPaid };
}
