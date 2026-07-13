import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { invitesTotal, updateTenantMetrics } from '../lib/metrics.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { ForbiddenError, ValidationError, NotFoundError } from '../lib/errors.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { parsePagination, parseSort, buildPaginationResult } from '../utils/pagination.js';
import { emailService } from '../services/email.js';
import { cognitoService } from '../services/cognito.js';
import { postCharge, postCredit, postPayment, getCurrentBalance } from '../services/ledger.js';
import logger from '../lib/logger.js';

const router = Router();

router.use(authenticate);

type OpeningLedgerEntryInput = {
  type: 'CHARGE' | 'PAYMENT' | 'CREDIT';
  amount: number;
  description: string;
  code?: string;
  effectiveDate?: string;
};

function validateOpeningEntries(entries: unknown): OpeningLedgerEntryInput[] {
  if (!entries) return [];
  if (!Array.isArray(entries)) {
    throw new ValidationError('openingLedgerEntries must be an array');
  }

  const normalized = entries.map((entry: any, index: number) => {
    if (!entry || typeof entry !== 'object') {
      throw new ValidationError(`openingLedgerEntries[${index}] must be an object`);
    }

    const type = String(entry.type || '').toUpperCase();
    if (!['CHARGE', 'PAYMENT', 'CREDIT'].includes(type)) {
      throw new ValidationError(`openingLedgerEntries[${index}].type must be CHARGE, PAYMENT, or CREDIT`);
    }

    const amount = typeof entry.amount === 'string' ? parseFloat(entry.amount) : entry.amount;
    if (typeof amount !== 'number' || Number.isNaN(amount) || amount <= 0) {
      throw new ValidationError(`openingLedgerEntries[${index}].amount must be a positive number`);
    }

    const description = String(entry.description || '').trim();
    if (!description) {
      throw new ValidationError(`openingLedgerEntries[${index}].description is required`);
    }

    const normalizedEntry: OpeningLedgerEntryInput = {
      type: type as OpeningLedgerEntryInput['type'],
      amount,
      description,
      effectiveDate: entry.effectiveDate,
    };

    if (type === 'CHARGE' || type === 'CREDIT') {
      const code = String(entry.code || '').trim().toUpperCase();
      if (!code) {
        throw new ValidationError(`openingLedgerEntries[${index}].code is required for ${type}`);
      }
      normalizedEntry.code = code;
    }

    return normalizedEntry;
  });

  return normalized;
}

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
  const {
    email, firstName, lastName, phone, unitId, moveInDate,
    // New profile fields (all optional)
    leaseStartDate, leaseEndDate, leaseType,
    rentDeposit, dateOfBirth,
    emergencyContactName, emergencyContactPhone,
    notes, openingLedgerEntries,
  } = req.body;

  if (!email || !firstName || !lastName || !unitId) {
    throw new ValidationError('Missing required fields: email, firstName, lastName, and unitId are required');
  }

  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id },
    include: { user: true }
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
      data: {
        email,
        firstName,
        lastName,
        name: `${firstName} ${lastName}`,
        phone
      }
    });
  }

  // Generate invite token
  const inviteToken = crypto.randomBytes(32).toString('hex');

  // Parse and validate data
  // Append T12:00:00 to prevent UTC midnight from shifting to previous day in local time
  const parsedMoveInDate = moveInDate ? new Date(moveInDate + 'T12:00:00') : new Date();
  const parsedOpeningEntries = validateOpeningEntries(openingLedgerEntries);

  // Create tenant membership
  const membership = await prisma.tenantMembership.create({
    data: {
      userId: tenantUser.id,
      unitId,
      landlordId: landlord.id,
      moveInDate: parsedMoveInDate,
      inviteToken,
      inviteStatus: 'PENDING',
      // Optional profile fields
      leaseStartDate: leaseStartDate ? new Date(leaseStartDate + 'T12:00:00') : undefined,
      leaseEndDate: leaseEndDate ? new Date(leaseEndDate + 'T12:00:00') : undefined,
      leaseType: leaseType || 'FIXED_TERM',
      rentDeposit: rentDeposit ? parseFloat(rentDeposit) : undefined,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth + 'T12:00:00') : undefined,
      emergencyContactName: emergencyContactName || undefined,
      emergencyContactPhone: emergencyContactPhone || undefined,
      notes: notes || undefined,
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

  logger.info({
    tenantId: membership.id,
    email,
    unitId,
    landlordId: landlord.id
  }, 'Tenant created and invite sent');

  // Record metrics
  invitesTotal.inc({ status: 'sent' });
  await updateTenantMetrics(prisma);

  // Optional opening ledger entries (tenant creation can seed a real opening balance)
  // Posting order is deterministic so resulting balance is predictable:
  // CHARGE -> CREDIT -> PAYMENT.
  const orderedEntries: OpeningLedgerEntryInput[] = [
    ...parsedOpeningEntries.filter((e) => e.type === 'CHARGE'),
    ...parsedOpeningEntries.filter((e) => e.type === 'CREDIT'),
    ...parsedOpeningEntries.filter((e) => e.type === 'PAYMENT'),
  ];

  for (let i = 0; i < orderedEntries.length; i++) {
    const entry = orderedEntries[i];
    const effectiveDate = entry.effectiveDate ? new Date(`${entry.effectiveDate}T12:00:00`) : parsedMoveInDate;
    const referenceBase = `OPEN-${entry.type}-${membership.id}-${effectiveDate.toISOString().slice(0, 10)}-${i + 1}`;

    if (entry.type === 'CHARGE') {
      await postCharge({
        tenantMembershipId: membership.id,
        effectiveDate,
        code: entry.code!,
        description: entry.description,
        amount: entry.amount,
        source: 'MANUAL',
        referenceId: referenceBase,
        postedBy: user.id,
      });
      continue;
    }

    if (entry.type === 'CREDIT') {
      await postCredit({
        tenantMembershipId: membership.id,
        effectiveDate,
        code: entry.code!,
        description: entry.description,
        amount: entry.amount,
        source: 'MANUAL',
        referenceId: referenceBase,
        postedBy: user.id,
      });
      continue;
    }

    await postPayment({
      tenantMembershipId: membership.id,
      effectiveDate,
      description: entry.description,
      amount: entry.amount,
      source: 'MANUAL',
      referenceId: referenceBase,
      postedBy: user.id,
    });
  }

  const openingBalance = await getCurrentBalance(membership.id);


  res.status(201).json(apiResponse({
    membership,
    inviteLink: `${process.env.FRONTEND_URL}/invite/${inviteToken}`,
    openingLedgerEntriesPosted: orderedEntries.length,
    openingBalance,
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

  logger.info({ tenantId: id, email: membership.user.email }, 'Tenant invite resent');

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

  // Validate moveOutDate >= moveInDate (compare dates only, not times)
  // Use UTC to avoid timezone issues
  const parsedMoveOutDate = new Date(moveOutDate);
  const moveOutDateOnly = Date.UTC(parsedMoveOutDate.getUTCFullYear(), parsedMoveOutDate.getUTCMonth(), parsedMoveOutDate.getUTCDate());
  const moveInDateOnly = Date.UTC(membership.moveInDate.getUTCFullYear(), membership.moveInDate.getUTCMonth(), membership.moveInDate.getUTCDate());

  if (moveOutDateOnly < moveInDateOnly) {
    throw new ValidationError('Move-out date cannot be before move-in date');
  }

  // Ledger is source of truth for outstanding balance
  const currentBalance = await getCurrentBalance(id);
  const hasOutstandingBalance = currentBalance > 0.005;

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

  // Check if user has other active memberships before deleting Cognito
  const otherMemberships = await prisma.tenantMembership.count({
    where: {
      userId: membership.userId,
      status: 'ACTIVE',
      id: { not: id } // Exclude current membership
    }
  });

  const landlordAccount = await prisma.landlordAccount.findUnique({
    where: { userId: membership.userId }
  });

  // Only delete Cognito if no other active memberships and no landlord account
  if (otherMemberships === 0 && !landlordAccount && membership.user.cognitoId) {
    try {
      await cognitoService.deleteUser(membership.user.email);
      // Clear cognitoId to prevent stale reference on re-invite
      await prisma.user.update({
        where: { id: membership.userId },
        data: { cognitoId: null }
      });
      logger.info({ email: membership.user.email, cognitoId: membership.user.cognitoId }, 'Deleted Cognito user on move-out');
    } catch (error) {
      logger.error({ error, email: membership.user.email }, 'Failed to delete Cognito user on move-out');
      // Don't fail the move-out if Cognito deletion fails
    }
  } else {
    logger.info({
      email: membership.user.email,
      otherMemberships,
      hasLandlordAccount: !!landlordAccount
    }, 'Skipped Cognito deletion - user has other active accounts');
  }

  logger.info({
    tenantId: id,
    email: membership.user.email,
    moveOutDate: parsedMoveOutDate,
    hasOutstandingBalance
  }, 'Tenant moved out');

  // Update tenant metrics
  await updateTenantMetrics(prisma);


  res.json(apiResponse({
    membership: updatedMembership,
    outstandingBalance: hasOutstandingBalance,
    unpaidPeriods: hasOutstandingBalance ? ['LEDGER_OUTSTANDING'] : [],
  }, 'Tenant moved out successfully'));
}));

// PATCH /api/tenants/:id (update tenant profile fields)
router.patch('/:id', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { id } = req.params;
  const {
    leaseStartDate, leaseEndDate, leaseType,
    rentDeposit, dateOfBirth,
    emergencyContactName, emergencyContactPhone,
    notes,
  } = req.body;

  const landlord = await prisma.landlordAccount.findUnique({ where: { userId: user.id } });
  if (!landlord) throw new ForbiddenError('Not authorized');

  const membership = await prisma.tenantMembership.findFirst({
    where: { id, landlordId: landlord.id },
  });
  if (!membership) throw new NotFoundError('Tenant not found');

  const updated = await prisma.tenantMembership.update({
    where: { id },
    data: {
      ...(leaseStartDate !== undefined && {
        leaseStartDate: leaseStartDate ? new Date(leaseStartDate + 'T12:00:00') : null,
      }),
      ...(leaseEndDate !== undefined && {
        leaseEndDate: leaseEndDate ? new Date(leaseEndDate + 'T12:00:00') : null,
      }),
      ...(leaseType !== undefined && { leaseType }),
      ...(rentDeposit !== undefined && {
        rentDeposit: rentDeposit !== null ? parseFloat(rentDeposit) : null,
      }),
      ...(dateOfBirth !== undefined && {
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth + 'T12:00:00') : null,
      }),
      ...(emergencyContactName !== undefined && { emergencyContactName }),
      ...(emergencyContactPhone !== undefined && { emergencyContactPhone }),
      ...(notes !== undefined && { notes }),
    },
    include: { user: true, unit: true },
  });

  res.json(apiResponse(updated, 'Tenant updated successfully'));
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

// PATCH /api/tenants/:id/user-info (landlord updates tenant user information)
router.patch('/:id/user-info', catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { id } = req.params;
  const { firstName, lastName, phone } = req.body;

  // Validate at least one field is provided
  if (!firstName && !lastName && phone === undefined) {
    throw new ValidationError('At least one field (firstName, lastName, or phone) must be provided');
  }

  // Fetch tenant membership
  const membership = await prisma.tenantMembership.findUnique({
    where: { id },
    include: {
      user: true,
    }
  });

  if (!membership) {
    throw new NotFoundError('Tenant membership not found');
  }

  // Verify landlord ownership
  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId: user.id }
  });

  if (!landlord || membership.landlordId !== landlord.id) {
    throw new ForbiddenError('Not authorized to update this tenant');
  }

  // Update user information
  // Note: Login email (user.email) cannot be changed as it's tied to Cognito username
  // notificationEmail can only be changed by the tenant themselves (with verification)
  const updateData: any = {};

  // Get current values for computing name
  const currentFirstName = firstName || membership.user.firstName;
  const currentLastName = lastName || membership.user.lastName;

  if (firstName) updateData.firstName = firstName;
  if (lastName) updateData.lastName = lastName;
  if (firstName || lastName) {
    updateData.name = `${currentFirstName} ${currentLastName}`;
  }
  if (phone !== undefined) updateData.phone = phone || null; // Allow clearing phone

  const updatedUser = await prisma.user.update({
    where: { id: membership.userId },
    data: updateData
  });

  logger.info({
    tenantMembershipId: id,
    userId: membership.userId,
    landlordId: landlord.id,
    updatedFields: Object.keys(updateData)
  }, 'Landlord updated tenant user information');

  res.json(apiResponse(updatedUser, 'Tenant information updated successfully'));
}));

// PATCH /api/tenants/:id
router.patch('/:id', catchAsync(async (req: AuthRequest, res) => {
  const { id } = req.params;
  const { autopayEnabled, paymentMethodLabel } = req.body;

  const updatedMembership = await prisma.tenantMembership.update({
    where: { id },
    data: { autopayEnabled, paymentMethodLabel }
  });

  res.json(apiResponse(updatedMembership, 'Tenant updated successfully'));
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
    // Record consent timestamp when enabling and reset failure count
    updateData.autopayConsentAt = new Date();
    updateData.autopayDisabledAt = null;
    updateData.autopayDisableReason = null;
    updateData.autopayFailureCount = 0;
    updateData.lastAutopayFailureAt = null;
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

  // Update autopay metrics
  await updateTenantMetrics(prisma);

  res.json(apiResponse(updatedMembership, `Autopay ${autopayEnabled ? 'enabled' : 'disabled'} successfully`));
}));

export default router;
