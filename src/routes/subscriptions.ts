import { Router } from 'express';
import { AuthRequest, authenticate } from '../middleware/auth.js';
import { STRIPE_PRICE_IDS, PlanType } from '../config/stripe.js';
import { getPlan } from '../config/plans.js';
import { getSubscriptionDetails } from '../utils/subscriptionHelpers.js';
import {
  createSubscription,
  upgradeSubscription,
  downgradeSubscription,
  cancelSubscription,
  reactivateSubscription,
  getCustomerPortalUrl,
} from '../services/subscriptionService.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { ValidationError, NotFoundError } from '../lib/errors.js';
import logger from '../lib/logger.js';
import prisma from '../lib/prisma.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/subscriptions/current
 * Get current subscription details
 */
router.get('/current', catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;

  logger.info({ userId }, 'Fetching current subscription details');

  const details = await getSubscriptionDetails(userId);

  res.json(apiResponse(details));
}));

/**
 * POST /api/subscriptions
 * Create a new subscription
 * Body: { planType: 'starter' | 'growth' | 'professional' }
 */
router.post('/', catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { planType } = req.body;

  if (!planType || !['starter', 'growth', 'professional'].includes(planType)) {
    throw new ValidationError('Valid planType required (starter, growth, or professional)');
  }

  logger.info({ userId, planType }, 'Creating new subscription');

  // Check if user already has a subscription
  const currentDetails = await getSubscriptionDetails(userId);
  
  // If user has an incomplete subscription, cancel it before creating new one
  if (currentDetails && currentDetails.stripeSubscriptionId && currentDetails.subscriptionStatus === 'incomplete') {
    logger.info({ 
      userId, 
      oldSubscriptionId: currentDetails.stripeSubscriptionId,
      newPlan: planType 
    }, 'Canceling old incomplete subscription before creating new one');
    
    try {
      // Cancel the old incomplete subscription
      await cancelSubscription(currentDetails.stripeSubscriptionId, true);
      
      // Clear from database
      await prisma.user.update({
        where: { id: userId },
        data: {
          stripeSubscriptionId: null,
          subscriptionStatus: null,
        }
      });
      
      // Log cleanup
      await prisma.subscriptionHistory.create({
        data: {
          userId: userId,
          eventType: 'incomplete_cleaned',
          fromPlan: currentDetails.planType,
          toPlan: 'free',
          stripeObjectId: currentDetails.stripeSubscriptionId,
          metadata: { reason: 'creating_new_subscription' }
        }
      });
    } catch (error) {
      logger.error({ error, userId, oldSubscriptionId: currentDetails.stripeSubscriptionId }, 'Failed to cancel old incomplete subscription');
      // Continue anyway - the new subscription creation will fail if there's still a conflict
    }
  }
  
  // Block if user has active/paid subscription
  if (currentDetails && currentDetails.stripeSubscriptionId && currentDetails.subscriptionStatus !== 'incomplete') {
    logger.warn({ userId, currentPlan: currentDetails.planType, attemptedPlan: planType }, 'User attempted to create subscription but already has one');
    throw new ValidationError('You already have an active subscription. Use upgrade or downgrade instead.');
  }

  // Verify user is on free plan (or incomplete subscription that never got paid)
  if (currentDetails && currentDetails.planType !== 'free') {
    logger.warn({ userId, currentPlan: currentDetails.planType, attemptedPlan: planType }, 'User attempted to create subscription but is not on free plan');
    throw new ValidationError(`You are already on the ${currentDetails.planType} plan. Use upgrade or downgrade to change plans.`);
  }

  // Get the price ID for the plan
  const priceId = STRIPE_PRICE_IDS[planType as keyof typeof STRIPE_PRICE_IDS];

  if (!priceId) {
    throw new ValidationError('Invalid plan type');
  }

  const subscription = await createSubscription(userId, priceId);

  logger.info({ userId, planType, subscriptionId: subscription.id }, 'Subscription created successfully');

  res.status(201).json(apiResponse({
    id: subscription.id,
    status: subscription.status,
    hostedInvoiceUrl: (subscription.latest_invoice as any)?.hosted_invoice_url,
    planType
  }, 'Subscription created successfully'));
}));

/**
 * POST /api/subscriptions/upgrade
 * Upgrade to a higher tier plan
 * Body: { planType: 'starter' | 'growth' | 'professional' }
 */
router.post('/upgrade', catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { planType } = req.body;

  if (!planType || !['starter', 'growth', 'professional'].includes(planType)) {
    throw new ValidationError('Valid planType required (starter, growth, or professional)');
  }

  logger.info({ userId, planType }, 'Upgrading subscription');

  // Check if user has a subscription
  const currentDetails = await getSubscriptionDetails(userId);
  if (!currentDetails || !currentDetails.stripeSubscriptionId) {
    logger.warn({ userId, attemptedPlan: planType }, 'User attempted to upgrade but has no active subscription');
    throw new ValidationError('You do not have an active subscription to upgrade. Create a new subscription first.');
  }

  // Check if subscription is active
  if (!['active', 'trialing'].includes(currentDetails.subscriptionStatus || '')) {
    logger.warn({ userId, currentStatus: currentDetails.subscriptionStatus, currentPlan: currentDetails.planType, attemptedPlan: planType }, 'User attempted to upgrade with non-active subscription');
    throw new ValidationError(`Cannot upgrade subscription with status: ${currentDetails.subscriptionStatus}. Please resolve payment issues first.`);
  }

  // Validate it's actually an upgrade (higher tier)
  const currentPlan = getPlan(currentDetails.planType as PlanType);
  const newPlan = getPlan(planType as PlanType);
  
  if (newPlan.price <= currentPlan.price) {
    logger.warn({ userId, currentPlan: currentDetails.planType, currentPrice: currentPlan.price, attemptedPlan: planType, attemptedPrice: newPlan.price }, 'User attempted upgrade but new plan is not higher tier');
    throw new ValidationError(`Cannot upgrade from ${currentPlan.name} ($${currentPlan.price}) to ${newPlan.name} ($${newPlan.price}). Use downgrade endpoint for lower tiers or stay on current plan.`);
  }

  logger.info({ userId, fromPlan: currentDetails.planType, toPlan: planType, fromPrice: currentPlan.price, toPrice: newPlan.price }, 'Processing plan upgrade');

  const priceId = STRIPE_PRICE_IDS[planType as keyof typeof STRIPE_PRICE_IDS];

  if (!priceId) {
    throw new ValidationError('Invalid plan type');
  }

  const subscription = await upgradeSubscription(userId, priceId);

  logger.info({ userId, planType, subscriptionId: subscription.id }, 'Subscription upgraded successfully');

  res.json(apiResponse({
    id: subscription.id,
    status: subscription.status,
    planType
  }, 'Subscription upgraded successfully. You will be charged the prorated amount.'));
}));

/**
 * POST /api/subscriptions/downgrade
 * Downgrade to a lower tier plan (takes effect at period end)
 * Body: { planType: 'free' | 'starter' | 'growth' }
 */
router.post('/downgrade', catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { planType } = req.body;

  if (!planType || !['starter', 'growth'].includes(planType)) {
    throw new ValidationError('Valid planType required (starter or growth)');
  }

  logger.info({ userId, planType }, 'Downgrading subscription');

  // Check if user has a subscription
  const currentDetails = await getSubscriptionDetails(userId);
  if (!currentDetails || !currentDetails.stripeSubscriptionId) {
    logger.warn({ userId, attemptedPlan: planType }, 'User attempted to downgrade but has no active subscription');
    throw new ValidationError('You do not have an active subscription to downgrade.');
  }

  // Validate it's actually a downgrade (lower tier)
  const currentPlan = getPlan(currentDetails.planType as PlanType);
  const newPlan = getPlan(planType as PlanType);
  
  if (newPlan.price >= currentPlan.price) {
    logger.warn({ userId, currentPlan: currentDetails.planType, currentPrice: currentPlan.price, attemptedPlan: planType, attemptedPrice: newPlan.price }, 'User attempted downgrade but new plan is not lower tier');
    throw new ValidationError(`Cannot downgrade from ${currentPlan.name} ($${currentPlan.price}) to ${newPlan.name} ($${newPlan.price}). Use upgrade endpoint for higher tiers or stay on current plan.`);
  }

  logger.info({ userId, fromPlan: currentDetails.planType, toPlan: planType, fromPrice: currentPlan.price, toPrice: newPlan.price, effectiveAtPeriodEnd: true }, 'Processing plan downgrade');

  const priceId = STRIPE_PRICE_IDS[planType as keyof typeof STRIPE_PRICE_IDS];

  if (!priceId) {
    throw new ValidationError('Invalid plan type');
  }

  const subscription = await downgradeSubscription(userId, priceId);

  logger.info({ userId, planType, subscriptionId: subscription.id }, 'Subscription downgrade scheduled');

  res.json(apiResponse({
    id: subscription.id,
    status: subscription.status,
    planType
  }, 'Subscription will be downgraded at the end of your current billing period.'));
}));

/**
 * POST /api/subscriptions/cancel
 * Cancel subscription (takes effect at period end by default)
 * Body: { immediately?: boolean }
 */
router.post('/cancel', catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { immediately = false } = req.body || {};

  logger.info({ userId, immediately }, 'Canceling subscription');

  const details = await getSubscriptionDetails(userId);

  if (!details) {
    throw new NotFoundError('Subscription details not found');
  }

  if (!details.stripeSubscriptionId) {
    logger.warn({ userId, currentPlan: details?.planType }, 'User attempted to cancel but has no active subscription');
    throw new ValidationError('No active subscription to cancel');
  }

  logger.info({ userId, currentPlan: details.planType, subscriptionId: details.stripeSubscriptionId, immediately, willLoseAccessAt: immediately ? 'now' : details.currentPeriodEnd }, 'Processing subscription cancellation');

  const subscription = await cancelSubscription(details.stripeSubscriptionId, immediately);

  logger.info({ userId, subscriptionId: subscription.id, immediately, cancelAtPeriodEnd: subscription.cancel_at_period_end }, 'Subscription canceled');

  const message = immediately 
    ? 'Subscription canceled immediately.' 
    : 'Subscription will be canceled at the end of your current billing period.';

  res.json(apiResponse({
    id: subscription.id,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end
  }, message));
}));

/**
 * POST /api/subscriptions/reactivate
 * Reactivate a canceled subscription (only works if cancel_at_period_end is true)
 */
router.post('/reactivate', catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;

  logger.info({ userId }, 'Reactivating subscription');

  const details = await getSubscriptionDetails(userId);

  if (!details) {
    throw new NotFoundError('Subscription details not found');
  }

  if (!details.stripeSubscriptionId) {
    logger.warn({ userId, currentPlan: details?.planType }, 'User attempted to reactivate but has no subscription');
    throw new ValidationError('No subscription to reactivate');
  }

  if (!details.cancelAtPeriodEnd) {
    logger.warn({ userId, currentPlan: details.planType, subscriptionId: details.stripeSubscriptionId }, 'User attempted to reactivate but subscription is not scheduled for cancellation');
    throw new ValidationError('Subscription is not scheduled for cancellation');
  }

  const subscription = await reactivateSubscription(details.stripeSubscriptionId);

  logger.info({ userId, subscriptionId: subscription.id }, 'Subscription reactivated');

  res.json(apiResponse({
    id: subscription.id,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end
  }, 'Subscription reactivated successfully. Your subscription will continue.'));
}));

/**
 * GET /api/subscriptions/portal
 * Get Stripe Customer Portal URL for managing billing
 * Query: ?returnUrl=<url>
 */
router.get('/portal', catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const returnUrl = (req.query.returnUrl as string) || `${process.env.FRONTEND_URL}/dashboard/billing`;

  logger.info({ userId }, 'Generating customer portal URL');

  const details = await getSubscriptionDetails(userId);

  if (!details) {
    throw new NotFoundError('Subscription details not found');
  }

  if (!details.stripeCustomerId) {
    logger.warn({ userId, currentPlan: details?.planType }, 'User attempted to access portal but has no Stripe customer');
    throw new ValidationError('No Stripe customer found');
  }

  const portalUrl = await getCustomerPortalUrl(details.stripeCustomerId, returnUrl);

  logger.info({ userId, customerId: details.stripeCustomerId }, 'Customer portal URL generated');

  res.json(apiResponse({ url: portalUrl }));
}));

export default router;
