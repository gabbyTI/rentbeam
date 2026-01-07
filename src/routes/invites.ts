import { Router } from 'express';
import crypto from 'crypto';
import { invitesTotal } from '../lib/metrics.js';
import logger from '../lib/logger.js';
import { cognitoService } from '../services/cognito.js';
import prisma from '../lib/prisma.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';

const router = Router();

// GET /api/invites/:token
router.get('/:token', catchAsync(async (req, res) => {
  const { token } = req.params;

  const membership = await prisma.tenantMembership.findUnique({
    where: { inviteToken: token },
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
    throw new NotFoundError('Invalid or expired invite');
  }

  if (membership.inviteStatus !== 'PENDING') {
    throw new ValidationError('Invite already accepted');
  }

  res.json(apiResponse({
    email: membership.user.email,
    name: membership.user.name,
    landlordName: membership.unit.property.landlord.user.name,
    unit: {
      name: membership.unit.name,
    },
    property: {
      name: membership.unit.property.name,
      address: membership.unit.property.address,
    },
    rentAmount: parseFloat(membership.unit.rentAmount.toString()),
    dueDay: membership.unit.dueDay,
  }));
}));

// POST /api/invites/:token/accept
router.post('/:token/accept', catchAsync(async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  if (!password) {
    throw new ValidationError('Password is required');
  }

  // Find membership
  const membership = await prisma.tenantMembership.findUnique({
    where: { inviteToken: token },
    include: {
      user: true
    }
  });

  if (!membership) {
    throw new NotFoundError('Invalid or expired invite');
  }

  if (membership.inviteStatus !== 'PENDING') {
    throw new ValidationError('Invite already accepted');
  }

  const user = membership.user;

  // Check if user already has Cognito account
  if (user.cognitoId) {
    // User already has account, just mark invite as accepted
    await prisma.tenantMembership.update({
      where: { id: membership.id },
      data: {
        inviteStatus: 'ACCEPTED',
        inviteToken: null,
      }
    });

    res.json(apiResponse({
      note: 'You can now login with your existing credentials'
    }, 'Invite accepted successfully'));
  } else {
    // Create Cognito account with pre-verified email (tenant proved ownership via invite link)
    const cognitoId = await cognitoService.createTenantUser(
      user.email,
      password,
      user.name
    );

    // Update user and membership
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { cognitoId }
      }),
      prisma.tenantMembership.update({
        where: { id: membership.id },
        data: {
          inviteStatus: 'ACCEPTED',
          inviteToken: null,
        }
      })
    ]);

    // Login and get tokens
    const authResult = await cognitoService.login(user.email, password);

    // Record invite acceptance
    invitesTotal.inc({ status: 'accepted' });

    logger.info({ userId: user.id, email: user.email, tenantId: membership.id }, 'Tenant invite accepted and account created');

    res.json(apiResponse({
      tokens: {
        idToken: authResult?.IdToken,
        accessToken: authResult?.AccessToken,
        refreshToken: authResult?.RefreshToken,
      }
    }, 'Account created and invite accepted'));
  }
}));

export default router;
