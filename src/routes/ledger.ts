import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import {
  postCharge,
  postPayment,
  postCredit,
  getStatement,
  getLedgerSummary,
} from '../services/ledger.js';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { toCsv } from '../utils/csv.js';

const router = Router();
router.use(authenticate);

// ─── Guard helpers ────────────────────────────────────────────────────────────

/**
 * Resolve a tenantMembershipId and verify the requesting user is either:
 *   - The landlord who owns the membership, or
 *   - The tenant who holds the membership
 */
async function resolveMembership(tenantMembershipId: string, userId: string) {
  const membership = await prisma.tenantMembership.findUnique({
    where: { id: tenantMembershipId },
    include: {
      user: { select: { name: true } },
      unit: { include: { property: true } },
    },
  });

  if (!membership) throw new NotFoundError('Tenant membership not found');

  const landlord = await prisma.landlordAccount.findUnique({ where: { userId } });

  const isLandlord = landlord && membership.landlordId === landlord.id;
  const isTenant = membership.userId === userId;

  if (!isLandlord && !isTenant) {
    throw new ForbiddenError('Access denied to this ledger');
  }

  return { membership, isLandlord: !!isLandlord, landlord };
}

function parseExportDate(value: unknown, fieldName: string): Date | undefined {
  if (!value) return undefined;
  const rawValue = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawValue)
    ? new Date(`${rawValue}T00:00:00.000Z`)
    : new Date(rawValue);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`${fieldName} must be a valid date`);
  }
  return date;
}

function validateDateRange(fromDate?: Date, toDate?: Date) {
  if (fromDate && toDate && fromDate > toDate) {
    throw new ValidationError('fromDate cannot be after toDate');
  }
}

function getExclusiveToDate(toDate?: Date): Date | undefined {
  if (!toDate) return undefined;
  const exclusiveToDate = new Date(toDate);
  exclusiveToDate.setUTCDate(exclusiveToDate.getUTCDate() + 1);
  return exclusiveToDate;
}

const ledgerCsvHeaders = [
  'Date',
  'Type',
  'Code',
  'Description',
  'Charge',
  'Payment / Credit',
  'Balance',
  'Source',
  'Reference',
];

const landlordLedgerCsvHeaders = [
  'Tenant',
  'Property',
  'Unit',
  ...ledgerCsvHeaders,
];

function formatLedgerRow(row: Awaited<ReturnType<typeof getStatement>>[number]) {
  return [
    row.effectiveDate.toISOString().slice(0, 10),
    row.type,
    row.code,
    row.description,
    row.chargeAmount === null ? '' : row.chargeAmount.toFixed(2),
    row.paymentAmount === null ? '' : row.paymentAmount.toFixed(2),
    row.balanceAfter.toFixed(2),
    row.source,
    row.referenceId,
  ];
}

function ledgerRowsToCsv(rows: Awaited<ReturnType<typeof getStatement>>) {
  return toCsv(ledgerCsvHeaders, rows.map(formatLedgerRow));
}

// ─── GET /api/ledger/export ──────────────────────────────────────────────────
// Download posted statements for one or more tenants owned by the landlord.
router.get('/export', catchAsync(async (req: AuthRequest, res) => {
  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: req.user!.id },
  });

  if (!landlord) {
    throw new ForbiddenError('Only landlords can export multiple tenant ledgers');
  }

  const fromDate = parseExportDate(req.query.fromDate, 'fromDate');
  const toDate = parseExportDate(req.query.toDate, 'toDate');
  validateDateRange(fromDate, toDate);

  const tenantMembershipId = req.query.tenantMembershipId ? String(req.query.tenantMembershipId) : undefined;
  const propertyId = req.query.propertyId ? String(req.query.propertyId) : undefined;
  const type = req.query.type ? String(req.query.type).toUpperCase() : undefined;
  if (type && !['CHARGE', 'PAYMENT', 'CREDIT'].includes(type)) {
    throw new ValidationError('type must be CHARGE, PAYMENT, or CREDIT');
  }

  const memberships = await prisma.tenantMembership.findMany({
    where: {
      landlordId: landlord.id,
      status: 'ACTIVE',
      ...(tenantMembershipId ? { id: tenantMembershipId } : {}),
      ...(propertyId ? { unit: { propertyId } } : {}),
    },
    include: {
      user: { select: { name: true } },
      unit: { include: { property: { select: { name: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const rows = (await Promise.all(memberships.map(async (membership) => {
    const statement = await getStatement(membership.id, {
      fromDate,
      toDate: getExclusiveToDate(toDate),
    });
    return statement
      .filter((entry) => !type || entry.type === type)
      .map((entry) => [
        membership.user.name,
        membership.unit.property.name,
        membership.unit.name,
        ...formatLedgerRow(entry),
      ]);
  }))).flat();

  const dateSuffix = fromDate || toDate
    ? `${fromDate?.toISOString().slice(0, 10) || 'start'}-to-${toDate?.toISOString().slice(0, 10) || 'end'}`
    : 'all';

  sendLedgerCsv(res, toCsv(landlordLedgerCsvHeaders, rows), `rentbeam-ledger-${dateSuffix}.csv`);
}));

function sendLedgerCsv(res: any, csv: string, filename: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

// ─── GET /api/ledger/:tenantMembershipId/export ─────────────────────────────
// Download a posted statement for a tenant membership.
router.get('/:tenantMembershipId/export', catchAsync(async (req: AuthRequest, res) => {
  const { tenantMembershipId } = req.params as { tenantMembershipId: string };
  const fromDate = parseExportDate(req.query.fromDate, 'fromDate');
  const toDate = parseExportDate(req.query.toDate, 'toDate');
  validateDateRange(fromDate, toDate);

  const { membership } = await resolveMembership(tenantMembershipId, req.user!.id);
  const rows = await getStatement(tenantMembershipId, { fromDate, toDate });
  const tenantName = membership.user.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'tenant';
  const dateSuffix = fromDate || toDate
    ? `${fromDate?.toISOString().slice(0, 10) || 'start'}-to-${toDate?.toISOString().slice(0, 10) || 'end'}`
    : 'all';

  sendLedgerCsv(res, ledgerRowsToCsv(rows), `rentbeam-ledger-${tenantName}-${dateSuffix}.csv`);
}));

// ─── GET /api/ledger/:tenantMembershipId ──────────────────────────────────────
// Full statement — accessible by landlord or the tenant themselves
router.get('/:tenantMembershipId', catchAsync(async (req: AuthRequest, res) => {
  const { tenantMembershipId } = req.params as { tenantMembershipId: string };
  const { fromDate, toDate, includePending } = req.query;

  await resolveMembership(tenantMembershipId, req.user!.id);

  const rows = await getStatement(tenantMembershipId, {
    includePending: includePending === 'true',
    fromDate: fromDate ? new Date(fromDate as string) : undefined,
    toDate: toDate ? new Date(toDate as string) : undefined,
  });

  res.json(apiResponse(rows));
}));

// ─── GET /api/ledger/:tenantMembershipId/balance ──────────────────────────────
// Current balance summary
router.get('/:tenantMembershipId/balance', catchAsync(async (req: AuthRequest, res) => {
  const { tenantMembershipId } = req.params as { tenantMembershipId: string };

  await resolveMembership(tenantMembershipId, req.user!.id);

  const summary = await getLedgerSummary(tenantMembershipId);

  res.json(apiResponse(summary));
}));

// ─── POST /api/ledger/:tenantMembershipId/charge ──────────────────────────────
// Landlord manually posts a charge (rent, fee, deposit, special, etc.)
router.post('/:tenantMembershipId/charge', catchAsync(async (req: AuthRequest, res) => {
  const { tenantMembershipId } = req.params as { tenantMembershipId: string };
  const { code, description, amount, effectiveDate } = req.body;

  const { isLandlord } = await resolveMembership(tenantMembershipId, req.user!.id);

  if (!isLandlord) throw new ForbiddenError('Only landlords can post charges');

  if (!code || !description || !amount) {
    throw new ValidationError('Required: code, description, amount');
  }

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    throw new ValidationError('Amount must be a positive number');
  }

  const entry = await postCharge({
    tenantMembershipId,
    effectiveDate: effectiveDate ? new Date(effectiveDate) : new Date(),
    code: code.toUpperCase(),
    description,
    amount: parsedAmount,
    source: 'MANUAL',
    postedBy: req.user!.id,
  });

  logger.info({ entryId: entry.id, tenantMembershipId, code, amount: parsedAmount }, 'Manual charge posted via API');

  res.status(201).json(apiResponse(entry, 'Charge posted successfully'));
}));

// ─── POST /api/ledger/:tenantMembershipId/payment ────────────────────────────
// Landlord manually posts a payment (cheque, cash, e-transfer)
router.post('/:tenantMembershipId/payment', catchAsync(async (req: AuthRequest, res) => {
  const { tenantMembershipId } = req.params as { tenantMembershipId: string };
  const { description, amount, effectiveDate, referenceId } = req.body;

  const { isLandlord } = await resolveMembership(tenantMembershipId, req.user!.id);

  if (!isLandlord) throw new ForbiddenError('Only landlords can post manual payments');

  if (!description || !amount) {
    throw new ValidationError('Required: description, amount');
  }

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    throw new ValidationError('Amount must be a positive number');
  }

  const entry = await postPayment({
    tenantMembershipId,
    effectiveDate: effectiveDate ? new Date(effectiveDate) : new Date(),
    description,
    amount: parsedAmount,
    source: 'MANUAL',
    referenceId: referenceId ?? undefined,
    postedBy: req.user!.id,
  });

  logger.info({ entryId: entry.id, tenantMembershipId, amount: parsedAmount }, 'Manual payment posted via API');

  res.status(201).json(apiResponse(entry, 'Payment posted successfully'));
}));

// ─── POST /api/ledger/:tenantMembershipId/credit ─────────────────────────────
// Landlord manually posts a credit/concession (reduces balance)
router.post('/:tenantMembershipId/credit', catchAsync(async (req: AuthRequest, res) => {
  const { tenantMembershipId } = req.params as { tenantMembershipId: string };
  const { code, description, amount, effectiveDate } = req.body;

  const { isLandlord } = await resolveMembership(tenantMembershipId, req.user!.id);

  if (!isLandlord) throw new ForbiddenError('Only landlords can post credits');

  if (!description || !amount) {
    throw new ValidationError('Required: description, amount');
  }

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    throw new ValidationError('Amount must be a positive number');
  }

  const entry = await postCredit({
    tenantMembershipId,
    effectiveDate: effectiveDate ? new Date(effectiveDate) : new Date(),
    code: code ? code.toUpperCase() : 'ADJ',
    description,
    amount: parsedAmount,
    source: 'MANUAL',
    postedBy: req.user!.id,
  });

  logger.info({ entryId: entry.id, tenantMembershipId, amount: parsedAmount }, 'Manual credit posted via API');

  res.status(201).json(apiResponse(entry, 'Credit posted successfully'));
}));

export default router;
