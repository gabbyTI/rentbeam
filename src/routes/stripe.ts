import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { stripeService } from '../services/stripe.js';
import prisma from '../lib/prisma.js';
import { apiResponse } from '../utils/apiResponse.js';
import { catchAsync } from '../utils/catchAsync.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import logger from '../lib/logger.js';

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

    // Get landlord account with user profile
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
      // Use user's country from profile, default to Canada
      const userCountry = landlord.user.country || 'CA';

      const account = await stripeService.createConnectedAccount({
        email: landlord.user.email,
        country: userCountry,
        businessName: landlord.user.businessName || undefined,
      });

      stripeAccountId = account.id;

      // Create person (representative) with user's name if available
      if (landlord.user.firstName && landlord.user.lastName) {
        try {
          await stripeService.createPerson({
            accountId: stripeAccountId,
            firstName: landlord.user.firstName,
            lastName: landlord.user.lastName,
            email: landlord.user.email,
            phone: landlord.user.phone || undefined,
          });
          logger.info({ stripeAccountId }, 'Stripe person created with prefilled data');
        } catch (personError) {
          // Log but don't fail - Stripe will collect this during onboarding
          logger.warn({ stripeAccountId, error: personError }, 'Failed to prefill Stripe person');
        }
      }

      // Save account ID to database
      await prisma.landlordAccount.update({
        where: { id: landlord.id },
        data: { stripeAccountId },
      });

      logger.info({ userId, landlordId: landlord.id, stripeAccountId, country: userCountry }, 'Stripe Connect account created');
    }

    // Create account link with simplified collection
    const accountLink = await stripeService.createAccountLink({
      accountId: stripeAccountId,
      refreshUrl,
      returnUrl,
      collectionOptions: {
        fields: 'eventually_due', // Only collect required fields
        future_requirements: 'omit', // Don't show future requirements yet
      },
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
          requirementsDue: [],
          requirementsPending: [],
          disabledReason: null,
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
    const { membershipId } = req.body;

    // Get tenant membership - use specific membershipId if provided
    let membership;
    if (membershipId) {
      membership = await prisma.tenantMembership.findFirst({
        where: { id: membershipId, userId, status: 'ACTIVE' },
        include: {
          user: true,
          unit: {
            include: {
              property: {
                include: {
                  landlord: {
                    include: { user: true }
                  }
                }
              },
            },
          },
        },
      });
    } else {
      // Fallback for backward compatibility - use findFirst
      membership = await prisma.tenantMembership.findFirst({
        where: { userId, status: 'ACTIVE' },
        include: {
          user: true,
          unit: {
            include: {
              property: {
                include: {
                  landlord: {
                    include: { user: true }
                  }
                }
              },
            },
          },
        },
      });
    }

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

      // Optimistic locking: Try to set it ONLY if still null
      // This prevents race conditions where two requests create different customers
      const result = await prisma.tenantMembership.updateMany({
        where: {
          id: membership.id,
          stripeCustomerId: null
        },
        data: { stripeCustomerId: customer.id },
      });

      if (result.count > 0) {
        // We won the race - use our new customer
        customerId = customer.id;
      } else {
        // We lost the race - someone else set it. Fetch the winner.
        const updated = await prisma.tenantMembership.findUnique({
          where: { id: membership.id }
        });
        customerId = updated?.stripeCustomerId || customer.id;

        logger.info({
          userId,
          tenantId: membership.id,
          existingCustomerId: customerId,
          orphanedCustomerId: customer.id
        }, 'Race condition detected: Used existing Stripe customer instead of new one');
      }
    }

    // Determine payment method types based on landlord's country
    const landlordUser = membership.unit.property.landlord.user;
    const paymentMethodTypes = ['card'];

    if (landlordUser.country === 'CA') {
      paymentMethodTypes.push('acss_debit');
    }

    // Create SetupIntent
    const setupIntent = await stripeService.createSetupIntent(customerId, paymentMethodTypes);

    logger.info({ userId, tenantId: membership.id, customerId }, 'Setup intent created for payment method');

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
    const { membershipId } = req.body;

    if (!membershipId) {
      throw new BadRequestError('membershipId is required');
    }

    // Get specific tenant membership with unit details
    const membership = await prisma.tenantMembership.findFirst({
      where: { id: membershipId, userId, status: 'ACTIVE' },
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

    // Get landlord for Stripe account and country
    const landlord = await prisma.landlordAccount.findUnique({
      where: { id: membership.landlordId },
      include: {
        user: true // Get user to check country
      }
    });

    if (!landlord || !landlord.stripeAccountId) {
      throw new BadRequestError('Landlord has not completed payment setup');
    }

    // Determine currency based on landlord's country
    const currency = landlord.user.country === 'CA' ? 'cad' : 'usd';

    // Calculate fees
    const rentAmount = parseFloat(membership.unit.rentAmount.toString());
    // Use paymentMethodType to calculate correct fee (Card vs PAD)
    const paymentMethodType = (membership as any).paymentMethodType || 'card';
    const fees = stripeService.calculateProcessingFee(rentAmount, paymentMethodType);

    // Calculate billing month based on dueDay (same logic as frontend getCurrentRentMonth)
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexed
    const currentDay = now.getDate();
    const dueDay = membership.unit.dueDay;

    // Determine the billing month
    let rentYear = currentYear;
    let rentMonth = currentMonth;

    // If we're past the due day this month, billing is for next month
    if (currentDay > dueDay) {
      rentMonth = currentMonth + 1;
      if (rentMonth > 11) {
        rentMonth = 0;
        rentYear = currentYear + 1;
      }
    }

    // Check if payment window is open (5 days before due date)
    const dueDate = new Date(rentYear, rentMonth, dueDay);
    const paymentWindowOpenDate = new Date(dueDate);
    paymentWindowOpenDate.setDate(dueDate.getDate() - 5);

    // If payment window is not open yet, use previous month
    if (now < paymentWindowOpenDate) {
      rentMonth = rentMonth === 0 ? 11 : rentMonth - 1;
      rentYear = rentMonth === 11 ? rentYear - 1 : rentYear;
    }

    const month = `${rentYear}-${String(rentMonth + 1).padStart(2, '0')}`;

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

    // Determine payment method types based on tenant's saved payment method
    const paymentMethodTypes = paymentMethodType === 'acss_debit' ? ['acss_debit'] : ['card'];

    // Create PaymentIntent (convert dollars to cents)
    const paymentIntent = await stripeService.createPaymentIntent({
      amount: Math.round(fees.totalAmount * 100),
      currency,
      customerId: membership.stripeCustomerId,
      paymentMethodId: membership.defaultPaymentMethodId,
      connectedAccountId: landlord.stripeAccountId, // Route to landlord
      mandateId: (membership as any).mandateId || undefined, // Pass mandate for ACSS Debit
      paymentMethodTypes, // Pass correct payment method types
      metadata: {
        tenantMembershipId: membership.id,
        month,
        rentAmount: fees.rentAmount.toString(),
        processingFee: fees.processingFee.toString(),
      },
    });

    logger.info({
      userId,
      tenantId: membership.id,
      amount: fees.totalAmount,
      month,
      paymentIntentId: paymentIntent.id
    }, 'Manual payment intent created');

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
    const membershipId = req.query.membershipId as string;

    if (!membershipId) {
      throw new BadRequestError('membershipId is required');
    }

    // Get specific tenant membership
    const membership = await prisma.tenantMembership.findFirst({
      where: { id: membershipId, userId, status: 'ACTIVE' },
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

    logger.info({ userId, tenantId: membership.id }, 'Payment method removed');

    res.json(apiResponse({ success: true }));
  })
);

export default router;
