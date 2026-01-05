import { Router } from 'express';
import crypto from 'crypto';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';
import { ForbiddenError, ValidationError, NotFoundError } from '../lib/errors.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { parsePagination, parseSort, buildPaginationResult } from '../utils/pagination.js';
import { emailService } from '../services/email.js';
import { cognitoService } from '../services/cognito.js';
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
  const { orderBy: rawOrderBy } = parseSort(req.query, '-createdAt');
  
  // Validate and filter orderBy fields
  const allowedFields = ['createdAt', 'updatedAt', 'moveInDate'];
  const orderBy = rawOrderBy.filter(order => {
    const field = Object.keys(order)[0];
    return allowedFields.includes(field);
  });

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
  const { email, name, phone, unitId, moveInDate } = req.body;

  if (!email || !name || !unitId) {
    throw new ValidationError('Missing required fields');
  }

  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id }
  });

  if (!landlord) {
    throw new ForbiddenError('Not authorized');
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new ValidationError('Invalid email format');
  }

  // Validate unit exists and landlord owns it
  const unit = await prisma.unit.findUnique({
    where: { id: unitId },
    include: {
      property: true
    }
  });

  if (!unit) {
    throw new NotFoundError('Unit not found');
  }

  if (unit.property.landlordId !== landlord.id) {
    throw new ForbiddenError('You do not own this unit');
  }

  // Check if unit already has an active tenant
  const existingActiveTenant = await prisma.tenantMembership.findFirst({
    where: {
      unitId,
      status: 'ACTIVE'
    }
  });

  if (existingActiveTenant) {
    throw new ValidationError('This unit already has an active tenant');
  }

  // Check if user exists
  let tenantUser = await prisma.user.findUnique({
    where: { email }
  });

  // Check for duplicate active membership if user exists
  if (tenantUser) {
    const existingMembership = await prisma.tenantMembership.findFirst({
      where: {
        userId: tenantUser.id,
        landlordId: landlord.id,
        status: 'ACTIVE'
      }
    });

    if (existingMembership) {
      throw new ValidationError('This tenant already has an active membership with you');
    }
  }

  // If user doesn't exist, create placeholder
  if (!tenantUser) {
    tenantUser = await prisma.user.create({
      data: { email, name, phone }
    });
  }

  // Generate invite token
  const inviteToken = crypto.randomBytes(32).toString('hex');

  // Parse and validate data
  const parsedMoveInDate = moveInDate ? new Date(moveInDate) : new Date();

  // Create tenant membership
  const membership = await prisma.tenantMembership.create({
    data: {
      userId: tenantUser.id,
      unitId,
      landlordId: landlord.id,
      moveInDate: parsedMoveInDate,
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

// POST /api/tenants/:id/resend-invite
router.post('/:id/resend-invite', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { id } = req.params;

  const membership = await prisma.tenantMembership.findUnique({
    where: { id },
    include: { user: true }
  });

  if (!membership) {
    throw new NotFoundError('Tenant not found');
  }

  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id }
  });

  if (!landlord || membership.landlordId !== landlord.id) {
    throw new ForbiddenError('Not authorized');
  }

  // Validation checks
  if (membership.inviteStatus === 'ACCEPTED') {
    throw new ValidationError('Invite already accepted');
  }

  if (membership.status !== 'ACTIVE') {
    throw new ValidationError('Cannot resend invite for inactive tenant');
  }

  if (membership.user.cognitoId) {
    throw new ValidationError('User has already registered');
  }

  // Generate new invite token
  const inviteToken = crypto.randomBytes(32).toString('hex');
  
  await prisma.tenantMembership.update({
    where: { id },
    data: { inviteToken }
  });

  // Send invite email
  try {
    await emailService.sendTenantInvite(membership.user.email, user.name, inviteToken);
  } catch (error) {
    logger.error({ error, email: membership.user.email }, 'Failed to resend invite email');
    throw new Error('Failed to send invite email');
  }

  res.json(apiResponse(null, 'Invite resent successfully'));
}));

// POST /api/tenants/:id/move-out (move out tenant)
router.post('/:id/move-out', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { id } = req.params;
  const { moveOutDate, note } = req.body;

  if (!moveOutDate) {
    throw new ValidationError('Move-out date is required');
  }

  // Fetch tenant membership
  const membership = await prisma.tenantMembership.findUnique({
    where: { id },
    include: {
      user: true,
      unit: {
        include: {
          property: true
        }
      }
    }
  });

  if (!membership) {
    throw new NotFoundError('Tenant not found');
  }

  // Verify landlord ownership
  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id }
  });

  if (!landlord || membership.landlordId !== landlord.id) {
    throw new ForbiddenError('Not authorized to move out this tenant');
  }

  // Validate tenant is ACTIVE
  if (membership.status === 'INACTIVE') {
    // Idempotent - already moved out
    return res.json(apiResponse({
      alreadyMovedOut: true,
      moveOutDate: membership.moveOutDate,
      movedOutAt: membership.movedOutAt,
    }, 'Tenant already moved out'));
  }

  // Validate moveOutDate >= moveInDate
  const parsedMoveOutDate = new Date(moveOutDate);
  if (parsedMoveOutDate < membership.moveInDate) {
    throw new ValidationError('Move-out date cannot be before move-in date');
  }

  // Check for unpaid rent
  const currentMonth = new Date().toISOString().slice(0, 7); // "2026-01"
  const unpaidPayment = await prisma.payment.findFirst({
    where: {
      tenantMembershipId: id,
      month: currentMonth,
    }
  });

  const hasOutstandingBalance = !unpaidPayment;

  // Update membership: set INACTIVE, disable autopay, set move-out dates, null invite token
  const updatedMembership = await prisma.tenantMembership.update({
    where: { id },
    data: {
      status: 'INACTIVE',
      moveOutDate: parsedMoveOutDate,
      movedOutAt: new Date(),
      autopayEnabled: false,
      autopayDisabledAt: new Date(),
      autopayDisableReason: 'MOVE_OUT',
      inviteToken: null, // Security: remove invite token
    },
    include: {
      user: true,
      unit: {
        include: {
          property: true
        }
      }
    }
  });

  // Delete Cognito user if exists
  if (membership.user.cognitoId) {
    try {
      await cognitoService.deleteUser(membership.user.email);
      logger.info({ email: membership.user.email, cognitoId: membership.user.cognitoId }, 'Deleted Cognito user on move-out');
    } catch (error) {
      logger.error({ error, email: membership.user.email }, 'Failed to delete Cognito user on move-out');
      // Don't fail the move-out if Cognito deletion fails
    }
  }

  res.json(apiResponse({
    membership: updatedMembership,
    outstandingBalance: hasOutstandingBalance,
    unpaidPeriods: hasOutstandingBalance ? [currentMonth] : [],
  }, 'Tenant moved out successfully'));
}));

// GET /api/tenants/:id (get single tenant membership details)
router.get('/:id', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { id } = req.params;

  const membership = await prisma.tenantMembership.findUnique({
    where: { id },
    include: {
      user: true,
      unit: {
        include: {
          property: {
            include: {
              landlord: {
                include: {
                  user: true
                }
              }
            }
          }
        }
      }
    }
  });

  if (!membership) {
    throw new NotFoundError('Tenant membership not found');
  }

  // Check authorization: landlord owns this tenant OR user is the tenant
  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id }
  });

  const isLandlord = landlord && membership.landlordId === landlord.id;
  const isTenant = membership.userId === user.id;

  if (!isLandlord && !isTenant) {
    throw new ForbiddenError('Not authorized to view this tenant');
  }

  res.json(apiResponse(membership));
}));

// PATCH /api/tenants/:id
router.patch('/:id', catchAsync(async (req: AuthRequest, res) => {
  const { id } = req.params;
  const { autopayEnabled, paymentMethodLabel } = req.body;

  const updatedMembership = await prisma.tenantMembership.update({
    where: { id },
    data: { autopayEnabled, paymentMethodLabel }
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
      moveInDate: new Date(),
      inviteStatus: 'ACCEPTED',
      status: 'ACTIVE'
    }
  });

  res.json(apiResponse(newMembership, 'Tenant transferred successfully'));
}));

// PATCH /api/tenants/:id/autopay (toggle autopay)
router.patch('/:id/autopay', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { id } = req.params;
  const { autopayEnabled } = req.body;

  if (typeof autopayEnabled !== 'boolean') {
    throw new ValidationError('autopayEnabled must be a boolean');
  }

  // Fetch tenant membership
  const membership = await prisma.tenantMembership.findUnique({
    where: { id },
    include: {
      user: true,
      unit: {
        include: {
          property: true
        }
      }
    }
  });

  if (!membership) {
    throw new NotFoundError('Tenant membership not found');
  }

  // Verify ownership (user is either the tenant or the landlord)
  const isOwner = membership.userId === user.id;
  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id }
  });
  const isLandlord = landlord?.id === membership.landlordId;

  if (!isOwner && !isLandlord) {
    throw new ForbiddenError('Not authorized to modify this tenant membership');
  }

  // If enabling autopay, require payment method
  if (autopayEnabled && !membership.defaultPaymentMethodId) {
    throw new ValidationError('Cannot enable autopay without a payment method');
  }

  // Update autopay status
  const updateData: any = {
    autopayEnabled,
  };

  if (autopayEnabled) {
    // Record consent timestamp when enabling
    updateData.autopayConsentAt = new Date();
    updateData.autopayDisabledAt = null;
    updateData.autopayDisableReason = null;
  } else {
    // Record disabled timestamp when disabling
    updateData.autopayDisabledAt = new Date();
  }

  const updatedMembership = await prisma.tenantMembership.update({
    where: { id },
    data: updateData,
    include: {
      user: true,
      unit: {
        include: {
          property: {
            include: {
              landlord: {
                include: {
                  user: true
                }
              }
            }
          }
        }
      }
    }
  });

  logger.info({ 
    tenantMembershipId: id, 
    autopayEnabled,
    userId: user.id 
  }, `Autopay ${autopayEnabled ? 'enabled' : 'disabled'}`);

  res.json(apiResponse(updatedMembership, `Autopay ${autopayEnabled ? 'enabled' : 'disabled'} successfully`));
}));

export default router;
