import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { paymentsTotal, paymentsAmountCents } from '../lib/metrics.js';
import { postPayment as postLedgerPayment } from '../services/ledger.js';
import prisma from '../lib/prisma.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { parsePagination, parseSort, buildPaginationResult } from '../utils/pagination.js';
import logger from '../lib/logger.js';

const router = Router();

router.use(authenticate);

// GET /api/payments
router.get('/', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;

  // Check if landlord or tenant
  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id }
  });

  // Parse pagination and sort
  const { page, limit, skip } = parsePagination(req.query);
  const { orderBy } = parseSort(req.query, '-date');

  let where;
  if (landlord) {
    where = {
      tenantMembership: {
        landlordId: landlord.id
      }
    };
  } else {
    where = {
      tenantMembership: {
        userId: user.id
      }
    };
  }

  // Get payments with pagination
  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        tenantMembership: {
          include: {
            user: landlord ? true : false,
            unit: true
          }
        }
      },
      orderBy,
      take: limit,
      skip,
    }),
    prisma.payment.count({ where }),
  ]);

  const pagination = buildPaginationResult(page, limit, total);

  res.json(apiResponse(payments, null, pagination));
}));

// POST /api/payments (record manual payment - landlord only)
router.post('/', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { tenantMembershipId, amount, date, note, paymentMethod } = req.body;

  // Validate required fields
  if (!tenantMembershipId || !amount || !date) {
    throw new ValidationError('Missing required fields: tenantMembershipId, amount, date');
  }

  // Verify user is a landlord
  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id }
  });

  if (!landlord) {
    throw new ForbiddenError('Only landlords can record payments');
  }

  // Validate tenant membership exists and belongs to this landlord
  const membership = await prisma.tenantMembership.findUnique({
    where: { id: tenantMembershipId },
    include: { unit: true }
  });

  if (!membership) {
    throw new NotFoundError('Tenant membership not found');
  }

  if (membership.landlordId !== landlord.id) {
    throw new ForbiddenError('You do not own this tenant membership');
  }

  // Validate amount
  const parsedAmount = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    throw new ValidationError('Amount must be a positive number');
  }

  // Generate month from date (format: "2026-01")
  const paymentDate = new Date(date);
  const month = `${paymentDate.getFullYear()}-${String(paymentDate.getMonth() + 1).padStart(2, '0')}`;

  // Check for duplicate payment for this month (exclude FAILED payments - allow retry)
  const existingPayment = await prisma.payment.findFirst({
    where: {
      tenantMembershipId,
      month,
      status: {
        in: ['SUCCEEDED', 'PROCESSING', 'PENDING']
      }
    }
  });

  if (existingPayment) {
    throw new ValidationError(`Payment already recorded for ${month}. Delete the existing payment first if you need to correct it.`);
  }

  // Validate amount matches tenant's rent (allow small variance for rounding)
  const rentAmount = parseFloat(membership.unit.rentAmount.toString());
  const difference = Math.abs(parsedAmount - rentAmount);
  if (difference > 1) { // Allow $1 difference for rounding
    logger.warn({
      tenantId: tenantMembershipId,
      expectedRent: rentAmount,
      paidAmount: parsedAmount
    }, 'Payment amount does not match rent amount');
  }

  // Create payment record
  const payment = await prisma.payment.create({
    data: {
      tenantMembershipId,
      amount: parsedAmount,
      method: paymentMethod || 'MANUAL',
      date: paymentDate,
      month,
      note: note || null
    },
    include: {
      tenantMembership: {
        include: {
          user: true,
          unit: {
            include: {
              property: true
            }
          }
        }
      }
    }
  });

  logger.info({
    paymentId: payment.id,
    tenantId: tenantMembershipId,
    amount: parsedAmount,
    month
  }, 'Manual payment recorded');

  // Record metrics
  paymentsTotal.inc({ method: 'MANUAL', status: 'success' });
  paymentsAmountCents.inc({ method: 'MANUAL' }, parsedAmount * 100);

  // Post payment to ledger (idempotent — skips if referenceId already recorded)
  try {
    const method = (paymentMethod || 'MANUAL') as string;
    const methodLabel = method === 'CARD' ? 'Card' : 'Cheque/Cash';
    await postLedgerPayment({
      tenantMembershipId,
      effectiveDate: paymentDate,
      description: `${methodLabel} Payment${note ? ' – ' + note : ''}`,
      amount: parsedAmount,
      source: 'MANUAL',
      referenceId: `PMNT-MANUAL-${payment.id}`,
      postedBy: user.id,
    });
  } catch (ledgerError: any) {
    logger.warn({ error: ledgerError.message, paymentId: payment.id }, 'Failed to post manual payment to ledger');
  }

  res.status(201).json(apiResponse(payment, 'Payment recorded successfully'));
}));

export default router;
