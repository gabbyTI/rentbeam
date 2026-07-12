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
    include: { unit: { include: { property: true } } },
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

// ─── GET /api/ledger/:tenantMembershipId ──────────────────────────────────────
// Full statement — accessible by landlord or the tenant themselves
router.get('/:tenantMembershipId', catchAsync(async (req: AuthRequest, res) => {
  const { tenantMembershipId } = req.params;
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
  const { tenantMembershipId } = req.params;

  await resolveMembership(tenantMembershipId, req.user!.id);

  const summary = await getLedgerSummary(tenantMembershipId);

  res.json(apiResponse(summary));
}));

// ─── POST /api/ledger/:tenantMembershipId/charge ──────────────────────────────
// Landlord manually posts a charge (rent, fee, deposit, special, etc.)
router.post('/:tenantMembershipId/charge', catchAsync(async (req: AuthRequest, res) => {
  const { tenantMembershipId } = req.params;
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
  const { tenantMembershipId } = req.params;
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
  const { tenantMembershipId } = req.params;
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
