import { Router } from 'express';
import { cognitoService } from '../services/cognito.js';
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

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({
    where: { email }
  });

  if (existingUser) {
    throw new ConflictError('User already exists');
  }

  // Create Cognito user
  const cognitoId = await cognitoService.createUser(email, password, name);

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
      name: user.name,
      cognitoId: user.cognitoId,
    },
    memberships: {
      landlord: user.landlordAccount ? { id: user.landlordAccount.id } : null,
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

export default router;
