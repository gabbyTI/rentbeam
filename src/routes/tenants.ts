import { Router } from 'express';
import crypto from 'crypto';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';
import { ForbiddenError, ValidationError, NotFoundError } from '../lib/errors.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { parsePagination, parseSort, buildPaginationResult } from '../utils/pagination.js';
import { emailService } from '../services/email.js';
import logger from '../lib/logger.js';

const router = Router();

router.use(authenticate);

// GET /api/tenants (landlord gets their tenants)
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

  const where = { landlordId: landlord.id };

  // Get tenants with pagination
  const [memberships, total] = await Promise.all([
    prisma.tenantMembership.findMany({
      where,
      include: {
        user: true,
        unit: {
          include: {
            property: true
          }
        }
      },
      orderBy,
      take: limit,
      skip,
    }),
    prisma.tenantMembership.count({ where }),
  ]);

  const pagination = buildPaginationResult(page, limit, total);

  res.json(apiResponse(memberships, null, pagination));
}));

// POST /api/tenants (create tenant + send invite)
router.post('/', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { email, name, phone, unitId, rentAmount, moveInDate } = req.body;

  if (!email || !name || !unitId || !rentAmount) {
    throw new ValidationError('Missing required fields');
  }

  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id }
  });

  if (!landlord) {
    throw new ForbiddenError('Not authorized');
  }

  // Check if user exists
  let tenantUser = await prisma.user.findUnique({
    where: { email }
  });

  // If user doesn't exist, create placeholder
  if (!tenantUser) {
    tenantUser = await prisma.user.create({
      data: { email, name, phone }
    });
  }

  // Generate invite token
  const inviteToken = crypto.randomBytes(32).toString('hex');

  // Create tenant membership
  const membership = await prisma.tenantMembership.create({
    data: {
      userId: tenantUser.id,
      unitId,
      landlordId: landlord.id,
      rentAmount,
      moveInDate: moveInDate || new Date(),
      inviteToken,
      inviteStatus: 'PENDING'
    },
    include: {
      user: true,
      unit: true
    }
  });

  // Send invite email
  try {
    await emailService.sendTenantInvite(email, user.name, inviteToken);
  } catch (error) {
    logger.error({ error, email }, 'Failed to send invite email, but tenant was created');
    // Don't fail the request if email fails - tenant is still created
  }

  res.status(201).json(apiResponse({
    membership,
    inviteLink: `${process.env.FRONTEND_URL}/invite/${inviteToken}`
  }, 'Tenant created successfully'));
}));

// PATCH /api/tenants/:id
router.patch('/:id', catchAsync(async (req: AuthRequest, res) => {
  const { id } = req.params;
  const { rentAmount, autopayEnabled, paymentMethodLabel } = req.body;

  const updated = await prisma.tenantMembership.update({
    where: { id },
    data: { rentAmount, autopayEnabled, paymentMethodLabel }
  });

  res.json(apiResponse(updated, 'Tenant updated successfully'));
}));

// DELETE /api/tenants/:id
router.delete('/:id', catchAsync(async (req: AuthRequest, res) => {
  const { id } = req.params;

  await prisma.tenantMembership.delete({ where: { id } });

  res.json(apiResponse(null, 'Tenant removed successfully'));
}));

// POST /api/tenants/transfer (transfer tenant to new unit)
router.post('/transfer', catchAsync(async (req: AuthRequest, res) => {
  const { tenantId, newUnitId } = req.body;

  if (!tenantId || !newUnitId) {
    throw new ValidationError('Missing required fields');
  }

  const oldMembership = await prisma.tenantMembership.findUnique({
    where: { id: tenantId },
    include: { unit: true }
  });

  if (!oldMembership) {
    throw new NotFoundError('Tenant not found');
  }

  const newUnit = await prisma.unit.findUnique({
    where: { id: newUnitId }
  });

  if (!newUnit) {
    throw new NotFoundError('Unit not found');
  }

  // Mark old membership as inactive
  await prisma.tenantMembership.update({
    where: { id: tenantId },
    data: {
      status: 'INACTIVE',
      moveOutDate: new Date()
    }
  });

  // Create new membership
  const newMembership = await prisma.tenantMembership.create({
    data: {
      userId: oldMembership.userId,
      unitId: newUnitId,
      landlordId: oldMembership.landlordId,
      rentAmount: newUnit.rentAmount,
      moveInDate: new Date(),
      inviteStatus: 'ACCEPTED',
      status: 'ACTIVE'
    }
  });

  res.json(apiResponse(newMembership, 'Tenant transferred successfully'));
}));

export default router;
