import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';
import { ValidationError } from '../lib/errors.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { parsePagination, parseSort, buildPaginationResult } from '../utils/pagination.js';

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

// POST /api/payments (mark payment as paid)
router.post('/', catchAsync(async (req: AuthRequest, res) => {
  const { tenantMembershipId, amount, method, date, month, note } = req.body;

  if (!tenantMembershipId || !amount || !method || !date || !month) {
    throw new ValidationError('Missing required fields');
  }

  const payment = await prisma.payment.create({
    data: {
      tenantMembershipId,
      amount,
      method,
      date: new Date(date),
      month,
      note
    }
  });

  res.status(201).json(apiResponse(payment, 'Payment recorded successfully'));
}));

export default router;
