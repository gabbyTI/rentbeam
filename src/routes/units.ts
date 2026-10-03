import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';
import { ForbiddenError, ValidationError, NotFoundError } from '../lib/errors.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { parsePagination, parseSort, buildPaginationResult } from '../utils/pagination.js';

const router = Router();

router.use(authenticate);

// GET /api/units/recurring-charge-types
router.get('/recurring-charge-types', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const landlord = await prisma.landlordAccount.findUnique({ where: { userId: user.id } });

  if (!landlord) throw new ForbiddenError('Not authorized');

  const chargeTypes = await prisma.recurringChargeType.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
  });

  res.json(apiResponse(chargeTypes, 'Recurring charge types loaded successfully'));
}));

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
        property: true,
        recurringChargeRules: {
          include: { chargeType: true },
          orderBy: { effectiveDate: 'asc' },
        },
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
router.post('/', catchAsync(async (req: AuthRequest, res) => {
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
  const { id } = req.params as { id: string };
  const { name, rentAmount, dueDay, gracePeriodDays } = req.body;

  const updated = await prisma.unit.update({
    where: { id },
    data: { name, rentAmount, dueDay, gracePeriodDays }
  });

  res.json(apiResponse(updated, 'Unit updated successfully'));
}));

// GET /api/units/:id/recurring-charges
router.get('/:id/recurring-charges', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { id } = req.params as { id: string };

  const landlord = await prisma.landlordAccount.findUnique({ where: { userId: user.id } });
  if (!landlord) throw new ForbiddenError('Not authorized');

  const unit = await prisma.unit.findFirst({
    where: { id, property: { landlordId: landlord.id } },
    include: {
      recurringChargeRules: {
        include: { chargeType: true },
        orderBy: { effectiveDate: 'asc' },
      },
    },
  });

  if (!unit) throw new NotFoundError('Unit not found');

  res.json(apiResponse(unit.recurringChargeRules, 'Recurring charges loaded successfully'));
}));

// POST /api/units/:id/recurring-charges
router.post('/:id/recurring-charges', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { id } = req.params as { id: string };
  const { chargeTypeId, amount, frequency, dueDay, effectiveDate, endDate, description, active } = req.body;

  const landlord = await prisma.landlordAccount.findUnique({ where: { userId: user.id } });
  if (!landlord) throw new ForbiddenError('Not authorized');

  const unit = await prisma.unit.findFirst({
    where: { id, property: { landlordId: landlord.id } },
  });

  if (!unit) throw new NotFoundError('Unit not found');
  if (!chargeTypeId || amount === undefined || !effectiveDate) {
    throw new ValidationError('chargeTypeId, amount, and effectiveDate are required');
  }

  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new ValidationError('Amount must be a positive number');
  }

  const chargeType = await prisma.recurringChargeType.findUnique({ where: { id: chargeTypeId } });
  if (!chargeType) throw new NotFoundError('Charge type not found');

  const normalizedFrequency = String(frequency || 'MONTHLY').toUpperCase();
  if (!['MONTHLY', 'WEEKLY'].includes(normalizedFrequency)) {
    throw new ValidationError('frequency must be MONTHLY or WEEKLY');
  }

  const parsedDueDay = Number(dueDay ?? 1);
  if (!Number.isInteger(parsedDueDay) || parsedDueDay < 1 || parsedDueDay > 31) {
    throw new ValidationError('dueDay must be an integer from 1 to 31');
  }

  const parsedEffectiveDate = new Date(effectiveDate);
  if (Number.isNaN(parsedEffectiveDate.getTime())) {
    throw new ValidationError('effectiveDate must be a valid date');
  }

  const parsedEndDate = endDate ? new Date(endDate) : null;
  if (parsedEndDate && Number.isNaN(parsedEndDate.getTime())) {
    throw new ValidationError('endDate must be a valid date');
  }
  if (parsedEndDate && parsedEndDate < parsedEffectiveDate) {
    throw new ValidationError('endDate cannot be before effectiveDate');
  }

  const rule = await prisma.unitRecurringChargeRule.create({
    data: {
      unitId: unit.id,
      chargeTypeId: chargeType.id,
      amount: parsedAmount,
      frequency: normalizedFrequency as 'MONTHLY' | 'WEEKLY',
      dueDay: parsedDueDay,
      effectiveDate: parsedEffectiveDate,
      endDate: parsedEndDate,
      active: active ?? true,
      description: description || chargeType.name,
    },
    include: { chargeType: true },
  });

  res.status(201).json(apiResponse(rule, 'Recurring charge created successfully'));
}));

// PATCH /api/units/:id/recurring-charges/:ruleId
router.patch('/:id/recurring-charges/:ruleId', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { id, ruleId } = req.params as { id: string; ruleId: string };
  const { amount, frequency, dueDay, effectiveDate, endDate, description, active } = req.body;

  const landlord = await prisma.landlordAccount.findUnique({ where: { userId: user.id } });
  if (!landlord) throw new ForbiddenError('Not authorized');

  const unit = await prisma.unit.findFirst({
    where: { id, property: { landlordId: landlord.id } },
  });

  if (!unit) throw new NotFoundError('Unit not found');

  const rule = await prisma.unitRecurringChargeRule.findFirst({
    where: { id: ruleId, unitId: unit.id },
  });

  if (!rule) throw new NotFoundError('Recurring charge rule not found');

  const updateData: any = {};
  if (amount !== undefined) {
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw new ValidationError('Amount must be a positive number');
    }
    updateData.amount = parsedAmount;
  }

  if (frequency !== undefined) {
    const normalizedFrequency = String(frequency).toUpperCase();
    if (!['MONTHLY', 'WEEKLY'].includes(normalizedFrequency)) {
      throw new ValidationError('frequency must be MONTHLY or WEEKLY');
    }
    updateData.frequency = normalizedFrequency;
  }

  if (dueDay !== undefined) {
    const parsedDueDay = Number(dueDay);
    if (!Number.isInteger(parsedDueDay) || parsedDueDay < 1 || parsedDueDay > 31) {
      throw new ValidationError('dueDay must be an integer from 1 to 31');
    }
    updateData.dueDay = parsedDueDay;
  }

  if (effectiveDate !== undefined) {
    const parsedEffectiveDate = new Date(effectiveDate);
    if (Number.isNaN(parsedEffectiveDate.getTime())) {
      throw new ValidationError('effectiveDate must be a valid date');
    }
    updateData.effectiveDate = parsedEffectiveDate;
  }

  if (endDate !== undefined) {
    const parsedEndDate = endDate ? new Date(endDate) : null;
    if (parsedEndDate && Number.isNaN(parsedEndDate.getTime())) {
      throw new ValidationError('endDate must be a valid date');
    }
    if (parsedEndDate && parsedEndDate < (effectiveDate !== undefined ? new Date(effectiveDate) : rule.effectiveDate)) {
      throw new ValidationError('endDate cannot be before effectiveDate');
    }
    updateData.endDate = parsedEndDate;
  }

  if (description !== undefined) updateData.description = description;
  if (active !== undefined) updateData.active = Boolean(active);

  const updated = await prisma.unitRecurringChargeRule.update({
    where: { id: ruleId },
    data: updateData,
    include: { chargeType: true },
  });

  res.json(apiResponse(updated, 'Recurring charge updated successfully'));
}));

// DELETE /api/units/:id/recurring-charges/:ruleId
router.delete('/:id/recurring-charges/:ruleId', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { id, ruleId } = req.params as { id: string; ruleId: string };

  const landlord = await prisma.landlordAccount.findUnique({ where: { userId: user.id } });
  if (!landlord) throw new ForbiddenError('Not authorized');

  const unit = await prisma.unit.findFirst({
    where: { id, property: { landlordId: landlord.id } },
  });

  if (!unit) throw new NotFoundError('Unit not found');

  const rule = await prisma.unitRecurringChargeRule.findFirst({
    where: { id: ruleId, unitId: unit.id },
  });

  if (!rule) throw new NotFoundError('Recurring charge rule not found');

  await prisma.unitRecurringChargeRule.delete({ where: { id: ruleId } });

  res.json(apiResponse(null, 'Recurring charge deleted successfully'));
}));

// DELETE /api/units/:id
router.delete('/:id', catchAsync(async (req: AuthRequest, res) => {
  const { id } = req.params as { id: string };

  await prisma.unit.delete({ where: { id } });

  res.json(apiResponse(null, 'Unit deleted successfully'));
}));

export default router;
