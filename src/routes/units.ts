import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { checkUnitLimit } from '../middleware/subscriptionGuard.js';
import prisma from '../lib/prisma.js';
import { ForbiddenError, ValidationError } from '../lib/errors.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { parsePagination, parseSort, buildPaginationResult } from '../utils/pagination.js';

const router = Router();

router.use(authenticate);

// GET /api/units
router.get('/', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id }
  });

  if (!landlord) {
    throw new ForbiddenError('Not authorized');
  }

  // Parse pagination and sort
  const { page, limit, skip } = parsePagination(req.query);
  const { orderBy } = parseSort(req.query, '-createdAt');

  const where = {
    property: {
      landlordId: landlord.id
    }
  };

  // Get units with pagination
  const [units, total] = await Promise.all([
    prisma.unit.findMany({
      where,
      include: {
        property: true
      },
      orderBy,
      take: limit,
      skip,
    }),
    prisma.unit.count({ where }),
  ]);

  const pagination = buildPaginationResult(page, limit, total);

  res.json(apiResponse(units, null, pagination));
}));

// POST /api/units
router.post('/', checkUnitLimit, catchAsync(async (req: AuthRequest, res) => {
  const { propertyId, name, rentAmount, dueDay, gracePeriodDays } = req.body;

  if (!propertyId || !name || !rentAmount || !dueDay) {
    throw new ValidationError('Missing required fields');
  }

  const unit = await prisma.unit.create({
    data: {
      propertyId,
      name,
      rentAmount,
      dueDay,
      gracePeriodDays: gracePeriodDays || 5
    }
  });

  res.status(201).json(apiResponse(unit, 'Unit created successfully'));
}));

// PATCH /api/units/:id
router.patch('/:id', catchAsync(async (req: AuthRequest, res) => {
  const { id } = req.params;
  const { name, rentAmount, dueDay, gracePeriodDays } = req.body;

  const updated = await prisma.unit.update({
    where: { id },
    data: { name, rentAmount, dueDay, gracePeriodDays }
  });

  res.json(apiResponse(updated, 'Unit updated successfully'));
}));

// DELETE /api/units/:id
router.delete('/:id', catchAsync(async (req: AuthRequest, res) => {
  const { id } = req.params;

  await prisma.unit.delete({ where: { id } });

  res.json(apiResponse(null, 'Unit deleted successfully'));
}));

export default router;
