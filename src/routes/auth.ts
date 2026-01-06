import { Router } from 'express';
import crypto from 'crypto';
import { cognitoService } from '../services/cognito.js';
import { emailService } from '../services/email.js';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { ConflictError, ValidationError, UnauthorizedError, NotFoundError } from '../lib/errors.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';

const router = Router();

// In-memory storage for notification email verification codes
// Format: { userId: { code: string, email: string, expiresAt: Date } }
const notificationEmailVerifications = new Map<string, { code: string; email: string; expiresAt: Date }>();

// Cleanup expired codes every minute
setInterval(() => {
  const now = new Date();
  for (const [userId, data] of notificationEmailVerifications.entries()) {
    if (data.expiresAt < now) {
      notificationEmailVerifications.delete(userId);
    }
  }
}, 60000);

// POST /api/auth/signup-landlord
router.post('/signup-landlord', catchAsync(async (req, res) => {
  const { email, password, name } = req.body;
  
  // Validation
  if (!email || !password || !name) {
    throw new ValidationError('Email, password, and name are required');
  }

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({
    where: { email }
  });

  if (existingUser) {
    throw new ConflictError('User already exists');
  }

  // Create Cognito user (handle if already exists)
  let cognitoId: string;
  try {
    cognitoId = await cognitoService.createUser(email, password, name);
  } catch (error: any) {
    if (error.name === 'UsernameExistsException') {
      // Cognito user exists but database user doesn't - this can happen after DB reset
      // Delete the Cognito user and recreate to ensure consistency
      logger.warn({ email }, 'Cognito user exists without database record, deleting and recreating');
      await cognitoService.deleteUser(email);
      cognitoId = await cognitoService.createUser(email, password, name);
    } else {
      throw error;
    }
  }

  // Create user in database
  const user = await prisma.user.create({
    data: {
      cognitoId,
      email,
      name,
      landlordAccount: {
        create: {}
      }
    },
    include: {
      landlordAccount: true
    }
  });

  res.status(201).json(apiResponse({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      landlordId: user.landlordAccount?.id
    }
  }, 'Landlord account created successfully'));
}));

// POST /api/auth/login (optional - frontend can call Cognito directly)
router.post('/login', catchAsync(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new ValidationError('Email and password are required');
  }

  // Authenticate with Cognito
  let authResult;
  try {
    authResult = await cognitoService.login(email, password);
  } catch (error: any) {
    // Handle specific Cognito errors
    if (error.name === 'NotAuthorizedException') {
      if (error.message.includes('disabled')) {
        throw new UnauthorizedError('This account has been disabled');
      }
      throw new UnauthorizedError('Invalid email or password');
    }
    if (error.name === 'UserNotFoundException') {
      throw new UnauthorizedError('Invalid email or password');
    }
    if (error.name === 'UserNotConfirmedException') {
      throw new UnauthorizedError('Please verify your email before logging in');
    }
    throw error;
  }

  if (!authResult?.IdToken) {
    throw new UnauthorizedError('Login failed');
  }

  // Get user from database
  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      landlordAccount: true,
      tenantMemberships: {
        where: { status: 'ACTIVE' },
        include: {
          unit: {
            include: {
              property: true
            }
          }
        }
      }
    }
  });

  if (!user) {
    throw new NotFoundError('User not found');
  }

  res.json(apiResponse({
    tokens: {
      idToken: authResult.IdToken,
      accessToken: authResult.AccessToken,
      refreshToken: authResult.RefreshToken,
      cognitoId: user.cognitoId, // Required for refresh token
    },
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
    memberships: {
      landlord: user.landlordAccount ? { id: user.landlordAccount.id } : null,
      tenants: user.tenantMemberships.map(tm => ({
        id: tm.id,
        unitId: tm.unitId,
        unitName: tm.unit.name,
        propertyName: tm.unit.property.name,
        status: tm.status,
      }))
    }
  }));
}));

// POST /api/auth/refresh
router.post('/refresh', catchAsync(async (req, res) => {
  const { refreshToken, cognitoId } = req.body;

  if (!refreshToken || !cognitoId) {
    throw new ValidationError('Refresh token and cognitoId are required');
  }

  // Refresh tokens
  const authResult = await cognitoService.refreshTokens(refreshToken, cognitoId);

  if (!authResult?.IdToken) {
    throw new UnauthorizedError('Token refresh failed');
  }

  res.json(apiResponse({
    tokens: {
      idToken: authResult.IdToken,
      accessToken: authResult.AccessToken,
    }
  }));
}));

// POST /api/auth/forgot-password - Send password reset code
router.post('/forgot-password', catchAsync(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    throw new ValidationError('Email is required');
  }

  // Send password reset code via Cognito
  await cognitoService.forgotPassword(email);

  res.json(apiResponse(
    { message: 'Password reset code sent to email' },
    'If the email exists, a reset code has been sent'
  ));
}));

// POST /api/auth/reset-password - Confirm password reset with code
router.post('/reset-password', catchAsync(async (req, res) => {
  const { email, code, newPassword } = req.body;

  if (!email || !code || !newPassword) {
    throw new ValidationError('Email, code, and new password are required');
  }

  // Confirm password reset
  await cognitoService.resetPassword(email, code, newPassword);

  res.json(apiResponse(
    { message: 'Password reset successful' },
    'You can now login with your new password'
  ));
}));

// POST /api/auth/change-password - Change password for authenticated user
// Note: Requires accessToken (not idToken) in Authorization header
router.post('/change-password', catchAsync(async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const accessToken = req.headers.authorization?.replace('Bearer ', '');

  if (!oldPassword || !newPassword) {
    throw new ValidationError('Old password and new password are required');
  }

  if (!accessToken) {
    throw new UnauthorizedError('Access token is required');
  }

  // Change password via Cognito (validates accessToken internally)
  await cognitoService.changePassword(accessToken, oldPassword, newPassword);

  res.json(apiResponse(
    { message: 'Password changed successfully' },
    'Your password has been updated'
  ));
}));

// POST /api/auth/logout - Sign out user globally
// Note: Requires accessToken (not idToken) in Authorization header
router.post('/logout', catchAsync(async (req, res) => {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');

  if (!accessToken) {
    throw new UnauthorizedError('Access token is required');
  }

  // Sign out globally (revokes all tokens)
  await cognitoService.logout(accessToken);

  res.json(apiResponse(
    { message: 'Logged out successfully' },
    'All tokens have been revoked'
  ));
}));

// GET /api/auth/me - Get current user profile
router.get('/me', authenticate, catchAsync(async (req, res) => {
  const authReq = req as AuthRequest;
  
  if (!authReq.user?.cognitoId) {
    throw new UnauthorizedError('User not authenticated');
  }

  // Fetch user from database with all relationships
  const user = await prisma.user.findUnique({
    where: { cognitoId: authReq.user.cognitoId },
    include: {
      landlordAccount: true,
      tenantMemberships: {
        include: {
          unit: {
            include: {
              property: true,
            },
          },
        },
      },
    },
  });

  if (!user) {
    throw new NotFoundError('User not found');
  }

  res.json(apiResponse({
    user: {
      id: user.id,
      email: user.email,
      notificationEmail: user.notificationEmail,
      name: user.name,
      phone: user.phone,
      businessName: user.businessName,
      taxId: user.taxId,
      cognitoId: user.cognitoId,
    },
    memberships: {
      landlord: user.landlordAccount ? {
        id: user.landlordAccount.id,
        defaultDueDay: user.landlordAccount.defaultDueDay,
        defaultGracePeriodDays: user.landlordAccount.defaultGracePeriodDays,
      } : null,
      tenants: user.tenantMemberships.map(tm => ({
        id: tm.id,
        unitId: tm.unitId,
        unitName: tm.unit.name,
        propertyName: tm.unit.property.name,
        status: tm.status,
      })),
    },
  }));
}));

// PATCH /api/auth/profile - Update user profile
router.patch('/profile', authenticate, catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { name, phone, businessName, taxId, notificationEmail } = req.body;

  // Build update object with only provided fields
  const updateData: any = {};
  if (name !== undefined) updateData.name = name;
  if (phone !== undefined) updateData.phone = phone;
  if (businessName !== undefined) updateData.businessName = businessName;
  if (taxId !== undefined) updateData.taxId = taxId;
  if (notificationEmail !== undefined) updateData.notificationEmail = notificationEmail;

  // Update user
  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: updateData,
    select: {
      id: true,
      email: true,
      notificationEmail: true,
      name: true,
      phone: true,
      businessName: true,
      taxId: true,
    },
  });

  res.json(apiResponse(updatedUser, 'Profile updated successfully'));
}));

router.post(
  '/resend-verification',
  catchAsync(async (req, res) => {
    const { email } = req.body;

    if (!email) {
      throw new ValidationError('Email is required');
    }

    await cognitoService.resendConfirmationCode(email);

    res.json(apiResponse(null, 'Verification code sent'));
  })
);

// POST /api/auth/confirm-email - Confirm email with verification code
router.post(
  '/confirm-email',
  catchAsync(async (req, res) => {
    const { email, code } = req.body;

    if (!email || !code) {
      throw new ValidationError('Email and verification code are required');
    }

    await cognitoService.confirmEmail(email, code);

    res.json(apiResponse(null, 'Email verified successfully'));
  })
);

// DELETE /api/auth/account - Delete user account and all associated data
router.delete(
  '/account',
  authenticate,
  catchAsync(async (req: AuthRequest, res) => {
    const userId = req.user!.id;
    const userEmail = req.user!.email;

    logger.info({ userId }, 'Starting account deletion');

    // Use transaction for atomicity - all deletions succeed or none do
    await prisma.$transaction(async (tx) => {
      // Check if user has a landlord account
      const landlord = await tx.landlordAccount.findUnique({
        where: { userId },
        include: {
          properties: {
            include: {
              units: {
                include: {
                  tenantMemberships: true
                }
              }
            }
          }
        }
      });

      if (landlord) {
        logger.info({ landlordId: landlord.id }, 'Deleting landlord account and cascade data');
        
        // Cascade delete: Payments → TenantMemberships → Units → Properties → LandlordAccount
        for (const property of landlord.properties) {
          for (const unit of property.units) {
            for (const membership of unit.tenantMemberships) {
              // Delete all payments for this membership
              await tx.payment.deleteMany({
                where: { tenantMembershipId: membership.id }
              });
            }
            // Delete all tenant memberships for this unit
            await tx.tenantMembership.deleteMany({
              where: { unitId: unit.id }
            });
          }
          // Delete all units for this property
          await tx.unit.deleteMany({
            where: { propertyId: property.id }
          });
        }
        // Delete all properties for this landlord
        await tx.property.deleteMany({
          where: { landlordId: landlord.id }
        });
        // Delete the landlord account
        await tx.landlordAccount.delete({
          where: { id: landlord.id }
        });
      }

      // Delete tenant memberships if user is a tenant
      const tenantMemberships = await tx.tenantMembership.findMany({
        where: { userId }
      });

      if (tenantMemberships.length > 0) {
        logger.info({ count: tenantMemberships.length }, 'Deleting tenant memberships');
        for (const membership of tenantMemberships) {
          // Delete all payments for this membership
          await tx.payment.deleteMany({
            where: { tenantMembershipId: membership.id }
          });
        }
        // Delete all tenant memberships
        await tx.tenantMembership.deleteMany({
          where: { userId }
        });
      }

      // Finally delete the user record
      await tx.user.delete({
        where: { id: userId }
      });

      logger.info({ userId }, 'Database records deleted successfully');
    });

    // Optional: Delete from Cognito (do this after DB to ensure DB is cleaned up even if Cognito fails)
    if (userEmail) {
      try {
        await cognitoService.deleteUser(userEmail);
        logger.info({ email: userEmail }, 'Cognito user deleted successfully');
      } catch (err: any) {
        // Log warning but don't fail the request - DB is already cleaned up
        logger.warn({ email: userEmail, error: err.message }, 'Failed to delete Cognito user');
      }
    }

    res.json(apiResponse(null, 'Account deleted successfully'));
  })
);

// POST /api/auth/notification-email/initiate
router.post('/notification-email/initiate', authenticate, catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { notificationEmail } = req.body;

  // Validation
  if (!notificationEmail || typeof notificationEmail !== 'string') {
    throw new ValidationError('Notification email is required');
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(notificationEmail)) {
    throw new ValidationError('Invalid email format');
  }

  // Generate 6-digit verification code
  const code = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  // Store verification data
  notificationEmailVerifications.set(user.id, {
    code,
    email: notificationEmail,
    expiresAt
  });

  // Send verification email
  await emailService.sendNotificationEmailVerification(notificationEmail, code, user.name);

  logger.info({ userId: user.id, email: notificationEmail }, 'Notification email verification code sent');

  res.json(apiResponse(null, 'Verification code sent to notification email'));
}));

// POST /api/auth/notification-email/confirm
router.post('/notification-email/confirm', authenticate, catchAsync(async (req: AuthRequest, res) => {
  const user = req.user!;
  const { code } = req.body;

  // Validation
  if (!code || typeof code !== 'string') {
    throw new ValidationError('Verification code is required');
  }

  // Get stored verification data
  const verificationData = notificationEmailVerifications.get(user.id);

  if (!verificationData) {
    throw new ValidationError('No verification in progress. Please request a new code.');
  }

  // Check if code expired
  if (new Date() > verificationData.expiresAt) {
    notificationEmailVerifications.delete(user.id);
    throw new ValidationError('Verification code expired. Please request a new code.');
  }

  // Verify code
  if (code !== verificationData.code) {
    throw new ValidationError('Invalid verification code');
  }

  // Update notification email in database
  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: { notificationEmail: verificationData.email },
    select: {
      id: true,
      email: true,
      notificationEmail: true,
      name: true,
      phone: true,
      businessName: true,
      taxId: true,
    }
  });

  // Clean up verification data
  notificationEmailVerifications.delete(user.id);

  logger.info({ userId: user.id, notificationEmail: verificationData.email }, 'Notification email updated successfully');

  res.json(apiResponse(updatedUser, 'Notification email verified and updated successfully'));
}));

export default router;
