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
  const { name, address, streetAddress, city, province, postalCode, country, acceptOnlinePayments } = req.body;

  if (!name) {
    throw new ValidationError('Property name is required');
  }

  // Require either structured address fields or legacy address string
  if (!streetAddress && !address) {
    throw new ValidationError('Address is required');
  }

  if (streetAddress && (!city || !province || !postalCode)) {
    throw new ValidationError('City, province, and postal code are required');
  }

  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id }
  });

  if (!landlord) {
    throw new ForbiddenError('Not authorized as landlord');
  }

  // If enabling online payments, require Stripe onboarding
  if (acceptOnlinePayments === true && !landlord.payoutsEnabled) {
    throw new ForbiddenError('Complete bank account setup to accept online payments');
  }

  // Build computed display address
  const displayAddress = streetAddress
    ? `${streetAddress}, ${city}, ${province} ${postalCode}, ${country ?? 'CA'}`
    : address;

  const property = await prisma.property.create({
    data: {
      landlordId: landlord.id,
      name,
      address: displayAddress,
      streetAddress: streetAddress ?? '',
      city: city ?? '',
      province: province ?? '',
      postalCode: postalCode ?? '',
      country: country ?? 'CA',
      acceptOnlinePayments: acceptOnlinePayments ?? false
    }
  });

  res.status(201).json(apiResponse(property, 'Property created successfully'));
}));

// PATCH /api/properties/:id
router.patch('/:id', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { id } = req.params;
  const { name, address, streetAddress, city, province, postalCode, country, acceptOnlinePayments } = req.body;

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

  // Handle structured address update
  if (streetAddress !== undefined) {
    if (!city || !province || !postalCode) {
      throw new ValidationError('City, province, and postal code are required');
    }
    updateData.streetAddress = streetAddress;
    updateData.city = city;
    updateData.province = province;
    updateData.postalCode = postalCode;
    updateData.country = country ?? 'CA';
    updateData.address = `${streetAddress}, ${city}, ${province} ${postalCode}, ${country ?? 'CA'}`;
  } else if (address !== undefined) {
    // Legacy fallback: plain string address
    updateData.address = address;
  }

  if (acceptOnlinePayments !== undefined) {
    // Require Stripe onboarding to enable online payments
    if (acceptOnlinePayments === true && !landlord.payoutsEnabled) {
      throw new ForbiddenError('Complete bank account setup to accept online payments');
    }

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
