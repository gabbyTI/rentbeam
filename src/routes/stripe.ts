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

// ==================== TENANT PAYMENT ENDPOINTS ====================

/**
 * POST /api/stripe/customers
 * Create Stripe Customer for tenant
 */
router.post(
  '/customers',
  authenticate,
  catchAsync(async (req: AuthRequest, res) => {
    const userId = req.user!.id;

    // Get tenant membership
    const membership = await prisma.tenantMembership.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: { user: true },
    });

    if (!membership) {
      throw new NotFoundError('Active tenant membership not found');
    }

    // Check if customer already exists
    if (membership.stripeCustomerId) {
      res.json(
        apiResponse({
          customerId: membership.stripeCustomerId,
          alreadyExists: true,
        })
      );
      return;
    }

    // Create Stripe customer
    const customer = await stripeService.createCustomer({
      email: membership.user.email,
      name: membership.user.name,
    });

    // Save customer ID
    await prisma.tenantMembership.update({
      where: { id: membership.id },
      data: { stripeCustomerId: customer.id },
    });

    res.json(
      apiResponse({
        customerId: customer.id,
        alreadyExists: false,
      })
    );
  })
);

/**
 * POST /api/stripe/setup-intent
 * Create SetupIntent to save payment method
 */
router.post(
  '/setup-intent',
  authenticate,
  catchAsync(async (req: AuthRequest, res) => {
    const userId = req.user!.id;

    // Get tenant membership
    const membership = await prisma.tenantMembership.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: {
        user: true,
        unit: {
          include: {
            property: true,
          },
        },
      },
    });

    if (!membership) {
      throw new NotFoundError('Active tenant membership not found');
    }

    // Check if property accepts online payments
    if (!membership.unit.property.acceptOnlinePayments) {
      throw new BadRequestError('This property does not accept online payments');
    }

    // Ensure customer exists
    let customerId = membership.stripeCustomerId;
    if (!customerId) {
      const customer = await stripeService.createCustomer({
        email: membership.user.email,
        name: membership.user.name,
      });
      customerId = customer.id;

      await prisma.tenantMembership.update({
        where: { id: membership.id },
        data: { stripeCustomerId: customerId },
      });
    }

    // Create SetupIntent
    const setupIntent = await stripeService.createSetupIntent(customerId);

    res.json(
      apiResponse({
        clientSecret: setupIntent.client_secret,
        customerId,
      })
    );
  })
);

/**
 * POST /api/stripe/payment-intent
 * Create PaymentIntent to charge saved payment method
 */
router.post(
  '/payment-intent',
  authenticate,
  catchAsync(async (req: AuthRequest, res) => {
    const userId = req.user!.id;

    // Get tenant membership with unit details
    const membership = await prisma.tenantMembership.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: {
        unit: {
          include: {
            property: true,
          },
        },
      },
    });

    if (!membership) {
      throw new NotFoundError('Active tenant membership not found');
    }

    // Check if property accepts online payments
    if (!membership.unit.property.acceptOnlinePayments) {
      throw new BadRequestError('This property does not accept online payments');
    }

    if (!membership.stripeCustomerId || !membership.defaultPaymentMethodId) {
      throw new BadRequestError('Payment method not set up');
    }

    // Calculate fees
    const rentAmount = parseFloat(membership.unit.rentAmount.toString());
    const fees = stripeService.calculateProcessingFee(rentAmount);

    // Generate month
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Check for duplicate payment
    const existingPayment = await prisma.payment.findFirst({
      where: {
        tenantMembershipId: membership.id,
        month,
      },
    });

    if (existingPayment) {
      throw new BadRequestError(`Payment already recorded for ${month}`);
    }

    // Create PaymentIntent (convert dollars to cents)
    const paymentIntent = await stripeService.createPaymentIntent({
      amount: Math.round(fees.totalAmount * 100),
      customerId: membership.stripeCustomerId,
      paymentMethodId: membership.defaultPaymentMethodId,
      metadata: {
        tenantMembershipId: membership.id,
        month,
        rentAmount: fees.rentAmount.toString(),
        processingFee: fees.processingFee.toString(),
      },
    });

    res.json(
      apiResponse({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        ...fees,
      })
    );
  })
);

/**
 * DELETE /api/stripe/payment-method
 * Remove saved payment method
 */
router.delete(
  '/payment-method',
  authenticate,
  catchAsync(async (req: AuthRequest, res) => {
    const userId = req.user!.id;

    // Get tenant membership
    const membership = await prisma.tenantMembership.findFirst({
      where: { userId, status: 'ACTIVE' },
    });

    if (!membership) {
      throw new NotFoundError('Active tenant membership not found');
    }

    if (!membership.defaultPaymentMethodId) {
      throw new BadRequestError('No payment method to remove');
    }

    // Detach from Stripe
    await stripeService.detachPaymentMethod(membership.defaultPaymentMethodId);

    // Update database
    await prisma.tenantMembership.update({
      where: { id: membership.id },
      data: {
        defaultPaymentMethodId: null,
        paymentMethodLabel: null,
        autopayEnabled: false,
        autopayConsentAt: null,
      },
    });

    res.json(apiResponse({ success: true }));
  })
);

export default router;
