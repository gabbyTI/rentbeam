import { Router } from 'express';
import bcrypt from 'bcrypt';
import { cognitoService } from '../services/cognito.js';
import { emailService } from '../services/email.js';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { ConflictError, ValidationError, UnauthorizedError, NotFoundError } from '../lib/errors.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';

const router = Router();

// POST /api/auth/signup-landlord
router.post('/signup-landlord', catchAsync(async (req, res) => {
  const { email, password, name } = req.body;
  
  // Validation
  if (!email || !password || !name) {
    throw new ValidationError('Email, password, and name are required');
  }

  // Normalize email to lowercase
  const normalizedEmail = email.toLowerCase().trim();

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({
    where: { email: normalizedEmail }
  });

  if (existingUser) {
    throw new ConflictError('User already exists');
  }

  // Create Cognito user (handle if already exists)
  let cognitoId: string;
  try {
    cognitoId = await cognitoService.createUser(normalizedEmail, password, name);
  } catch (error: any) {
    if (error.name === 'UsernameExistsException') {
      // Cognito user exists but database user doesn't - this can happen after DB reset
      // Delete the Cognito user and recreate to ensure consistency
      logger.warn({ email: normalizedEmail }, 'Cognito user exists without database record, deleting and recreating');
      await cognitoService.deleteUser(normalizedEmail);
      cognitoId = await cognitoService.createUser(normalizedEmail, password, name);
    } else {
      throw error;
    }
  }

  // Create user in database with default free plan
  const user = await prisma.user.create({
    data: {
      cognitoId,
      email: normalizedEmail,
      name,
      planType: 'free',
      unitLimit: 3,
      landlordAccount: {
        create: {}
      }
    },
    include: {
      landlordAccount: true
    }
  });

  logger.info({ userId: user.id, email: normalizedEmail, landlordId: user.landlordAccount?.id }, 'Landlord signup successful');

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

  // Normalize email to lowercase (Cognito is case-insensitive)
  const normalizedEmail = email.toLowerCase().trim();

  // Authenticate with Cognito
  let authResult;
  try {
    authResult = await cognitoService.login(normalizedEmail, password);
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

  // Get user from database using normalized email
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
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

  logger.info({ userId: user.id, email: normalizedEmail }, 'User login successful');

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

  logger.info({ email }, 'Password reset code sent');

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

  logger.info({ email }, 'Password reset completed successfully');

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

  logger.info('Password changed successfully');

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
  logger.info({ userId }, 'Updating user profile');
  
  // Fetch current user to compare values
  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
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

  if (!currentUser) {
    throw new ValidationError('User not found');
  }

  // Build update object with only changed fields
  const updateData: any = {};
  if (name !== undefined && name !== currentUser.name) updateData.name = name;
  if (phone !== undefined && phone !== currentUser.phone) updateData.phone = phone;
  if (businessName !== undefined && businessName !== currentUser.businessName) updateData.businessName = businessName;
  if (taxId !== undefined && taxId !== currentUser.taxId) updateData.taxId = taxId;
  if (notificationEmail !== undefined && notificationEmail !== currentUser.notificationEmail) {
    updateData.notificationEmail = notificationEmail;
  }

  // Skip DB operation if no fields actually changed
  if (Object.keys(updateData).length === 0) {
    logger.info({ userId }, 'No profile fields changed - skipping DB update');
    return res.json(apiResponse({ user: currentUser }));
  }

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

    // Check if user has active tenant memberships before deleting Cognito
    const activeTenantMemberships = await prisma.tenantMembership.count({
      where: {
        userId,
        status: 'ACTIVE'
      }
    });

    // Optional: Delete from Cognito (do this after DB to ensure DB is cleaned up even if Cognito fails)
    // Only delete Cognito if no active tenant memberships
    if (userEmail && activeTenantMemberships === 0) {
      try {
        await cognitoService.deleteUser(userEmail);
        logger.info({ email: userEmail }, 'Cognito user deleted successfully');
      } catch (err: any) {
        // Log warning but don't fail the request - DB is already cleaned up
        logger.warn({ email: userEmail, error: err.message }, 'Failed to delete Cognito user');
      }
    } else if (activeTenantMemberships > 0) {
      logger.info({ 
        email: userEmail, 
        activeTenantMemberships 
      }, 'Skipped Cognito deletion - user has active tenant memberships');
    }

    res.json(apiResponse(null, 'Account deleted successfully'));
  })
);

// POST /api/auth/notification-email/initiate
router.post('/notification-email/initiate', authenticate, catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { notificationEmail } = req.body;

  // Validation
  if (!notificationEmail || typeof notificationEmail !== 'string') {
    throw new ValidationError('Notification email is required');
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(notificationEmail)) {
    throw new ValidationError('Invalid email format');
  }

  // Rate limiting: Check recent OTP requests (max 3 per 15 minutes)
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
  const recentAttempts = await prisma.otpVerification.count({
    where: {
      userId,
      type: 'NOTIFICATION_EMAIL',
      createdAt: { gte: fifteenMinutesAgo },
    },
  });

  if (recentAttempts >= 3) {
    throw new ValidationError('Too many verification requests. Please try again in 15 minutes.');
  }

  // Delete any existing NOTIFICATION_EMAIL OTPs for this user
  await prisma.otpVerification.deleteMany({
    where: {
      userId,
      type: 'NOTIFICATION_EMAIL',
    },
  });

  // Generate 6-digit OTP
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  // Hash the OTP (using bcrypt)
  const hashedCode = await bcrypt.hash(code, 10);

  // Save to database
  await prisma.otpVerification.create({
    data: {
      userId,
      type: 'NOTIFICATION_EMAIL',
      hashedCode,
      metadata: { newEmail: notificationEmail },
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      verifyAttempts: 0,
    },
  });

  // Send email with OTP
  await emailService.sendNotificationEmailVerification(notificationEmail, code, req.user!.name);

  logger.info({ userId, email: notificationEmail }, 'Notification email verification code sent');

  res.json(apiResponse(null, 'Verification code sent to notification email'));
}));

// POST /api/auth/notification-email/confirm
router.post('/notification-email/confirm', authenticate, catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { code } = req.body;

  // Validation
  if (!code || typeof code !== 'string') {
    throw new ValidationError('Verification code is required');
  }

  // Find the OTP record
  const otpRecord = await prisma.otpVerification.findFirst({
    where: {
      userId,
      type: 'NOTIFICATION_EMAIL',
    },
  });

  if (!otpRecord) {
    throw new ValidationError('No pending verification found. Please request a new code.');
  }

  // Check if expired
  if (otpRecord.expiresAt < new Date()) {
    await prisma.otpVerification.delete({ where: { id: otpRecord.id } });
    throw new ValidationError('Verification code has expired. Please request a new code.');
  }

  // Check if too many failed attempts
  if (otpRecord.verifyAttempts >= 5) {
    await prisma.otpVerification.delete({ where: { id: otpRecord.id } });
    throw new ValidationError('Too many failed attempts. Please request a new code.');
  }

  // Verify the code (compare hashes)
  const codeMatches = await bcrypt.compare(code, otpRecord.hashedCode);

  if (!codeMatches) {
    // Increment failed attempts
    await prisma.otpVerification.update({
      where: { id: otpRecord.id },
      data: {
        verifyAttempts: { increment: 1 },
      },
    });

    const remainingAttempts = 5 - (otpRecord.verifyAttempts + 1);
    throw new ValidationError(
      `Invalid verification code. ${remainingAttempts} attempt${remainingAttempts !== 1 ? 's' : ''} remaining.`
    );
  }

  // Code is valid - update the notification email
  const newEmail = (otpRecord.metadata as any).newEmail;

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: { notificationEmail: newEmail },
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

  // Delete the OTP record
  await prisma.otpVerification.delete({ where: { id: otpRecord.id } });

  logger.info({ userId, notificationEmail: newEmail }, 'Notification email updated successfully');

  res.json(apiResponse(updatedUser, 'Notification email verified and updated successfully'));
}));

// POST /api/auth/notification-email/resend
router.post('/notification-email/resend', authenticate, catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { notificationEmail } = req.body;

  // Validate email from REQUEST BODY
  if (!notificationEmail || typeof notificationEmail !== 'string') {
    throw new ValidationError('Notification email is required');
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(notificationEmail)) {
    throw new ValidationError('Invalid email format');
  }

  // Rate limiting: Check recent OTP requests (max 3 per 15 minutes)
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
  const recentAttempts = await prisma.otpVerification.count({
    where: {
      userId,
      type: 'NOTIFICATION_EMAIL',
      createdAt: { gte: fifteenMinutesAgo },
    },
  });

  if (recentAttempts >= 3) {
    throw new ValidationError('Too many verification requests. Please try again in 15 minutes.');
  }

  // Find existing OTP record
  const existingOtp = await prisma.otpVerification.findFirst({
    where: {
      userId,
      type: 'NOTIFICATION_EMAIL',
    },
  });

  if (!existingOtp) {
    throw new ValidationError('No pending verification found. Please initiate a new request.');
  }

  // Verify provided email matches stored email
  const storedEmail = (existingOtp.metadata as any)?.newEmail;
  if (storedEmail !== notificationEmail) {
    throw new ValidationError('Email does not match pending verification. Please start a new request.');
  }

  // Check if it's too soon to resend (prevent spam - min 1 minute between resends)
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
  if (existingOtp.createdAt > oneMinuteAgo) {
    const secondsToWait = Math.ceil((60 - (Date.now() - existingOtp.createdAt.getTime()) / 1000));
    throw new ValidationError(`Please wait ${secondsToWait} seconds before requesting a new code.`);
  }

  // Generate new 6-digit OTP
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  // Hash the new OTP
  const hashedCode = await bcrypt.hash(code, 10);

  // Update the existing record
  await prisma.otpVerification.update({
    where: { id: existingOtp.id },
    data: {
      hashedCode,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // New 10 min expiration
      verifyAttempts: 0, // Reset failed attempts
      createdAt: new Date(), // Update timestamp for rate limiting
    },
  });

  // Send new code
  await emailService.sendNotificationEmailVerification(notificationEmail, code, req.user!.name);

  logger.info({ userId, email: notificationEmail }, 'Notification email verification code resent');

  res.json(apiResponse(null, 'New verification code sent to notification email'));
}));

export default router;
