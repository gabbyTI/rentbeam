import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';
import { ForbiddenError, ValidationError, NotFoundError } from '../lib/errors.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { parsePagination, parseSort, buildPaginationResult } from '../utils/pagination.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// GET /api/properties
router.get('/', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;

  // Find landlord account
  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id }
  });

  if (!landlord) {
    throw new ForbiddenError('Not authorized as landlord');
  }

  // Parse pagination and sort
  const { page, limit, skip } = parsePagination(req.query);
  const { orderBy } = parseSort(req.query, '-createdAt');

  const where = { landlordId: landlord.id };

  // Get properties with pagination
  const [properties, total] = await Promise.all([
    prisma.property.findMany({
      where,
      include: {
        units: true
      },
      orderBy,
      take: limit,
      skip,
    }),
    prisma.property.count({ where }),
  ]);

  const pagination = buildPaginationResult(page, limit, total);

  res.json(apiResponse(properties, null, pagination));
}));

// POST /api/properties
router.post('/', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { name, address } = req.body;

  if (!name || !address) {
    throw new ValidationError('Name and address are required');
  }

  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id }
  });

  if (!landlord) {
    throw new ForbiddenError('Not authorized as landlord');
  }

  const property = await prisma.property.create({
    data: {
      landlordId: landlord.id,
      name,
      address
    }
  });

  res.status(201).json(apiResponse(property, 'Property created successfully'));
}));

// PATCH /api/properties/:id
router.patch('/:id', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { id } = req.params;
  const { name, address, acceptOnlinePayments } = req.body;

  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id }
  });

  if (!landlord) {
    throw new ForbiddenError('Not authorized');
  }

  // Verify ownership
  const property = await prisma.property.findFirst({
    where: { id, landlordId: landlord.id }
  });

  if (!property) {
    throw new NotFoundError('Property not found');
  }

  // Build update data
  const updateData: any = {};
  if (name !== undefined) updateData.name = name;
  if (address !== undefined) updateData.address = address;
  if (acceptOnlinePayments !== undefined) {
    updateData.acceptOnlinePayments = acceptOnlinePayments;
    
    // If disabling online payments, auto-disable autopay for all tenants in this property
    if (acceptOnlinePayments === false) {
      await prisma.tenantMembership.updateMany({
        where: {
          unit: {
            propertyId: id
          },
          autopayEnabled: true,
          status: 'ACTIVE'
        },
        data: {
          autopayEnabled: false,
          autopayDisabledAt: new Date(),
          autopayDisableReason: 'Property no longer accepts online payments'
        }
      });
    }
  }

  const updated = await prisma.property.update({
    where: { id },
    data: updateData
  });

  res.json(apiResponse(updated, 'Property updated successfully'));
}));

// DELETE /api/properties/:id
router.delete('/:id', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { id } = req.params;

  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id }
  });

  if (!landlord) {
    throw new ForbiddenError('Not authorized');
  }

  const property = await prisma.property.findFirst({
    where: { id, landlordId: landlord.id }
  });

  if (!property) {
    throw new NotFoundError('Property not found');
  }

  await prisma.property.delete({ where: { id } });

  res.json(apiResponse(null, 'Property deleted successfully'));
}));

export default router;
