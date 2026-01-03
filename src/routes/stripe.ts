import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { stripeService } from '../services/stripe.js';
import prisma from '../lib/prisma.js';
import { apiResponse } from '../utils/apiResponse.js';
import { catchAsync } from '../utils/catchAsync.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';

const router = Router();

/**
 * POST /api/stripe/connect/onboard
 * Create or refresh Stripe Connect onboarding link
 */
router.post(
  '/onboard',
  authenticate,
  catchAsync(async (req: AuthRequest, res) => {
    const userId = req.user!.id;
    const { refreshUrl, returnUrl } = req.body;

    if (!refreshUrl || !returnUrl) {
      throw new BadRequestError('refreshUrl and returnUrl are required');
    }

    // Get landlord account
    const landlord = await prisma.landlordAccount.findUnique({
      where: { userId },
      include: { user: true },
    });

    if (!landlord) {
      throw new NotFoundError('Landlord account not found');
    }

    let stripeAccountId = landlord.stripeAccountId;

    // Create Stripe account if doesn't exist
    if (!stripeAccountId) {
      const account = await stripeService.createConnectedAccount({
        email: landlord.user.email,
        country: 'US',
      });

      stripeAccountId = account.id;

      // Save account ID to database
      await prisma.landlordAccount.update({
        where: { id: landlord.id },
        data: { stripeAccountId },
      });
    }

    // Create account link
    const accountLink = await stripeService.createAccountLink({
      accountId: stripeAccountId,
      refreshUrl,
      returnUrl,
    });

    res.json(
      apiResponse({
        url: accountLink.url,
        accountId: stripeAccountId,
      })
    );
  })
);

/**
 * GET /api/stripe/connect/status
 * Get Stripe Connect onboarding status
 */
router.get(
  '/status',
  authenticate,
  catchAsync(async (req: AuthRequest, res) => {
    const userId = req.user!.id;

    const landlord = await prisma.landlordAccount.findUnique({
      where: { userId },
    });

    if (!landlord) {
      throw new NotFoundError('Landlord account not found');
    }

    if (!landlord.stripeAccountId) {
      res.json(
        apiResponse({
          connected: false,
          onboarded: false,
          chargesEnabled: false,
          detailsSubmitted: false,
          payoutsEnabled: false,
        })
      );
      return;
    }

    // Get account status from Stripe
    const status = await stripeService.isAccountOnboarded(landlord.stripeAccountId);

    // Update payoutsEnabled in database if changed
    if (status.payoutsEnabled !== landlord.payoutsEnabled) {
      await prisma.landlordAccount.update({
        where: { id: landlord.id },
        data: { payoutsEnabled: status.payoutsEnabled },
      });
    }

    res.json(
      apiResponse({
        connected: true,
        accountId: landlord.stripeAccountId,
        ...status,
      })
    );
  })
);

/**
 * POST /api/stripe/connect/dashboard
 * Get Express Dashboard login link
 */
router.post(
  '/dashboard',
  authenticate,
  catchAsync(async (req: AuthRequest, res) => {
    const userId = req.user!.id;

    const landlord = await prisma.landlordAccount.findUnique({
      where: { userId },
    });

    if (!landlord) {
      throw new NotFoundError('Landlord account not found');
    }

    if (!landlord.stripeAccountId) {
      throw new BadRequestError('Stripe account not connected');
    }

    // Check if onboarded
    const status = await stripeService.isAccountOnboarded(landlord.stripeAccountId);
    if (!status.onboarded) {
      throw new BadRequestError('Complete onboarding before accessing dashboard');
    }

    // Create login link
    const loginLink = await stripeService.createLoginLink(landlord.stripeAccountId);

    res.json(
      apiResponse({
        url: loginLink.url,
      })
    );
  })
);

export default router;
