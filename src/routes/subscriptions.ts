import { Router } from 'express';
import { AuthRequest, authenticate } from '../middleware/auth.js';
import { STRIPE_PRICE_IDS, PlanType } from '../config/stripe.js';
import { getPlan } from '../config/plans.js';
import { getSubscriptionDetails, SubscriptionDetails } from '../utils/subscriptionHelpers.js';
import { subscriptionEnforcementService } from '../services/subscriptionEnforcementService.js';
import {
  createSubscription,
  upgradeSubscription,
  downgradeSubscription,
  cancelSubscription,
  reactivateSubscription,
  getCustomerPortalUrl,
  cancelIncompleteSubscription,
  cancelScheduledDowngrade,
} from '../services/subscriptionService.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { ValidationError } from '../lib/errors.js';
import logger from '../lib/logger.js';
import prisma from '../lib/prisma.js';
import Stripe from 'stripe';

const router = Router();

// Initialize Stripe once for all routes
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-12-15.clover' });

// Plan tier ordering for upgrade/downgrade validation
const PLAN_TIERS: Record<string, number> = { free: 0, starter: 1, growth: 2, professional: 3 };

/**
 * Validate subscription state for operations
 * Centralizes all state validation logic to avoid redundant checks
 */
function validateSubscriptionState(
  details: SubscriptionDetails | null,
  operation: 'create' | 'upgrade' | 'downgrade' | 'cancel' | 'reactivate'
): void {
  const status = details?.subscriptionStatus;
  const hasSub = !!details?.stripeSubscriptionId;
  const planType = details?.planType || 'free';

  switch (operation) {
    case 'create':
      // Can only create if no active subscription
      if (hasSub && ['active', 'trialing', 'past_due'].includes(status || '')) {
        throw new ValidationError('You already have an active subscription. Use upgrade or downgrade instead.');
      }
      if (planType !== 'free') {
        throw new ValidationError(`You are already on the ${planType} plan.`);
      }
      break;

    case 'upgrade':
      // Must have active subscription
      if (!hasSub) {
        throw new ValidationError('You do not have an active subscription to upgrade.');
      }
      // Must be in good standing
      if (!['active', 'trialing'].includes(status || '')) {
        throw new ValidationError(`Cannot upgrade with status: ${status}. Please resolve payment issues first.`);
      }
      break;

    case 'downgrade':
      // Must have active subscription
      if (!hasSub) {
        throw new ValidationError('You do not have an active subscription to downgrade.');
      }
      // Must be in good standing
      if (!['active', 'trialing'].includes(status || '')) {
        throw new ValidationError(`Cannot downgrade with status: ${status}. Please resolve payment issues first.`);
      }
      break;

    case 'cancel':
      if (!hasSub) {
        throw new ValidationError('No active subscription to cancel.');
      }
      break;

    case 'reactivate':
      if (!hasSub) {
        throw new ValidationError('No subscription to reactivate.');
      }
      if (!details?.cancelAtPeriodEnd) {
        throw new ValidationError('Subscription is not scheduled for cancellation.');
      }
      break;
  }
}

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/subscriptions/current
 * Get current subscription details from DATABASE only (no Stripe calls)
 * Database is the source of truth for what user has PAID for
 */
router.get('/current', catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;

  logger.info({ userId }, 'Fetching current subscription details');

  const details = await getSubscriptionDetails(userId);
  
  // Add enforcement state
  const enforcementState = await subscriptionEnforcementService.getEnforcementState(userId);

  // Simple response from database - no Stripe API calls needed
  // subscriptionStatus tells frontend what state we're in:
  // - null/undefined: free plan (no subscription)
  // - 'active': paid and working
  // - 'trialing': in trial period
  // - 'incomplete': first payment pending
  // - 'past_due': renewal payment failed
  // - 'canceled': subscription ended

  res.json(apiResponse({
    ...details,
    unitCount: enforcementState.unitCount,
    unitLimit: enforcementState.unitLimit,
    isOverLimit: enforcementState.isOverLimit,
    overLimitBy: enforcementState.overLimitBy,
    restrictions: enforcementState.restrictions
  }));
}));

/**
 * POST /api/subscriptions
 * Create a new subscription (free -> paid)
 * Returns checkout URL - user redirects there to pay
 * Database updated by webhook after payment succeeds
 */
router.post('/', catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { planType } = req.body;

  if (!planType || !['starter', 'growth', 'professional'].includes(planType)) {
    throw new ValidationError('Valid planType required (starter, growth, or professional)');
  }

  logger.info({ userId, planType }, 'Creating new subscription');

  // Get current state and clean up any incomplete subscriptions
  let currentDetails = await getSubscriptionDetails(userId);
  
  if (currentDetails?.stripeSubscriptionId && 
      ['incomplete', 'incomplete_expired'].includes(currentDetails.subscriptionStatus || '')) {
    logger.info({ userId, oldSubscriptionId: currentDetails.stripeSubscriptionId }, 'Cleaning up incomplete subscription');
    
    try {
      await cancelIncompleteSubscription(currentDetails.stripeSubscriptionId);
      // Clear local state immediately so validation passes
      await prisma.user.update({
        where: { id: userId },
        data: { stripeSubscriptionId: null, subscriptionStatus: null }
      });
      // Refresh details after cleanup
      currentDetails = await getSubscriptionDetails(userId);
    } catch (error) {
      logger.error({ error, userId }, 'Failed to clean up incomplete subscription');
      // Continue anyway - Stripe will handle duplicate subscription logic
    }
  }
  
  // Validate subscription state
  validateSubscriptionState(currentDetails, 'create');

  const priceId = STRIPE_PRICE_IDS[planType as keyof typeof STRIPE_PRICE_IDS];
  if (!priceId) throw new ValidationError('Invalid plan type');

  // Create subscription - returns with latest_invoice expanded
  const subscription = await createSubscription(userId, priceId);
  const invoice = subscription.latest_invoice as Stripe.Invoice;

  logger.info({ userId, planType, subscriptionId: subscription.id }, 'Subscription created - awaiting payment');

  res.status(201).json(apiResponse({
    subscriptionId: subscription.id,
    status: subscription.status,
    hostedInvoiceUrl: invoice?.hosted_invoice_url,
    planType
  }, 'Complete payment to activate your subscription.'));
}));

/**
 * POST /api/subscriptions/upgrade
 * Upgrade to a higher tier plan
 * Returns checkout URL for prorated payment
 * Database updated by webhook after payment succeeds
 */
router.post('/upgrade', catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { planType } = req.body;

  if (!planType || !['starter', 'growth', 'professional'].includes(planType)) {
    throw new ValidationError('Valid planType required (starter, growth, or professional)');
  }

  logger.info({ userId, planType }, 'Upgrading subscription');

  // Check current state
  const currentDetails = await getSubscriptionDetails(userId);
  validateSubscriptionState(currentDetails, 'upgrade');

  // Validate it's actually an upgrade (higher tier)
  const currentTier = PLAN_TIERS[currentDetails!.planType] || 0;
  const newTier = PLAN_TIERS[planType] || 0;
  
  if (newTier <= currentTier) {
    throw new ValidationError(`Cannot upgrade from ${currentDetails!.planType} to ${planType}. Use downgrade endpoint for lower tiers.`);
  }

  // Same plan check
  if (currentDetails!.planType === planType) {
    throw new ValidationError(`You are already on the ${planType} plan.`);
  }

  // Cancel any scheduled downgrade before upgrading
  try {
    await cancelScheduledDowngrade(currentDetails!.stripeSubscriptionId!);
  } catch (error) {
    // Not a critical error - may not have a schedule
    logger.debug({ userId, error }, 'No scheduled downgrade to cancel (or error cancelling)');
  }

  const priceId = STRIPE_PRICE_IDS[planType as keyof typeof STRIPE_PRICE_IDS];
  if (!priceId) throw new ValidationError('Invalid plan type');

  // Create upgrade - generates prorated invoice
  const subscription = await upgradeSubscription(userId, priceId);
  const invoice = subscription.latest_invoice as Stripe.Invoice;

  logger.info({ userId, planType, subscriptionId: subscription.id }, 'Upgrade initiated - awaiting payment');

  res.json(apiResponse({
    subscriptionId: subscription.id,
    status: subscription.status,
    hostedInvoiceUrl: invoice?.hosted_invoice_url,
    amountDue: invoice?.amount_due ? invoice.amount_due / 100 : undefined,
    planType
  }, 'Complete payment to activate your upgrade.'));
}));

/**
 * POST /api/subscriptions/downgrade
 * Downgrade to a lower tier plan (takes effect at period end via Stripe schedule)
 * Database updated by webhook when schedule executes
 */
router.post('/downgrade', catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { planType } = req.body;

  // Allow downgrade to starter, growth, or cancel to free
  if (!planType || !['free', 'starter', 'growth'].includes(planType)) {
    throw new ValidationError('Valid planType required (free, starter, or growth)');
  }

  logger.info({ userId, planType }, 'Downgrading subscription');

  // Check current state
  const currentDetails = await getSubscriptionDetails(userId);
  validateSubscriptionState(currentDetails, 'downgrade');

  // Validate it's actually a downgrade (lower tier)
  const currentTier = PLAN_TIERS[currentDetails!.planType] || 0;
  const newTier = PLAN_TIERS[planType] || 0;
  
  if (newTier >= currentTier) {
    throw new ValidationError(`Cannot downgrade from ${currentDetails!.planType} to ${planType}. Use upgrade endpoint for higher tiers.`);
  }

  // Same plan check
  if (currentDetails!.planType === planType) {
    throw new ValidationError(`You are already on the ${planType} plan.`);
  }

  // Handle downgrade to free (cancellation)
  if (planType === 'free') {
    const subscription = await cancelSubscription(currentDetails!.stripeSubscriptionId!, false);
    logger.info({ userId, subscriptionId: subscription.id }, 'Subscription set to cancel at period end (downgrade to free)');
    const periodEnd = subscription.items.data[0]?.current_period_end;
    return res.json(apiResponse({
      subscriptionId: subscription.id,
      status: subscription.status,
      scheduledPlan: 'free',
      cancelAtPeriodEnd: true,
      effectiveDate: periodEnd ? new Date(periodEnd * 1000).toISOString() : null
    }, 'Your subscription will be canceled at the end of your billing period.'));
  }

  const priceId = STRIPE_PRICE_IDS[planType as keyof typeof STRIPE_PRICE_IDS];
  if (!priceId) throw new ValidationError('Invalid plan type');

  // Create subscription schedule for period-end change
  const subscription = await downgradeSubscription(userId, priceId);
  const periodEnd = (subscription as any).current_period_end;

  logger.info({ userId, planType, subscriptionId: subscription.id }, 'Downgrade scheduled');

  res.json(apiResponse({
    subscriptionId: subscription.id,
    status: subscription.status,
    scheduledPlan: planType,
    effectiveDate: periodEnd ? new Date(periodEnd * 1000).toISOString() : null
  }, 'Your plan will be downgraded at the end of your current billing period.'));
}));

/**
 * POST /api/subscriptions/cancel
 * Cancel subscription (at period end by default, or immediately)
 * Database updated by webhook when subscription deleted
 */
router.post('/cancel', catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { immediately = false } = req.body || {};

  logger.info({ userId, immediately }, 'Canceling subscription');

  const details = await getSubscriptionDetails(userId);
  validateSubscriptionState(details, 'cancel');

  const subscription = await cancelSubscription(details!.stripeSubscriptionId!, immediately);

  logger.info({ userId, subscriptionId: subscription.id, immediately }, 'Subscription canceled');

  res.json(apiResponse({
    subscriptionId: subscription.id,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelAt: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null
  }, immediately ? 'Subscription canceled immediately.' : 'Subscription will cancel at the end of your billing period.'));
}));

/**
 * POST /api/subscriptions/reactivate
 * Reactivate a subscription scheduled for cancellation
 * Only works if cancel_at_period_end is true
 */
router.post('/reactivate', catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;

  logger.info({ userId }, 'Reactivating subscription');

  const details = await getSubscriptionDetails(userId);
  validateSubscriptionState(details, 'reactivate');

  const subscription = await reactivateSubscription(details!.stripeSubscriptionId!);

  logger.info({ userId, subscriptionId: subscription.id }, 'Subscription reactivated');

  res.json(apiResponse({
    subscriptionId: subscription.id,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end
  }, 'Subscription reactivated successfully.'));
}));

/**
 * GET /api/subscriptions/portal
 * Get Stripe Customer Portal URL for managing billing
 */
router.get('/portal', catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const returnUrl = (req.query.returnUrl as string) || `${process.env.FRONTEND_URL}/dashboard/billing`;

  logger.info({ userId }, 'Generating customer portal URL');

  const details = await getSubscriptionDetails(userId);
  if (!details?.stripeCustomerId) {
    throw new ValidationError('No Stripe customer found');
  }

  const portalUrl = await getCustomerPortalUrl(details.stripeCustomerId, returnUrl);

  res.json(apiResponse({ url: portalUrl }));
}));

/**
 * DELETE /api/subscriptions/incomplete
 * Cancel an incomplete or past_due subscription
 * Used when user abandons checkout or payment fails
 * Webhook will handle the database cleanup when subscription deleted
 */
router.delete('/incomplete', catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;

  logger.info({ userId }, 'Canceling incomplete subscription');

  const details = await getSubscriptionDetails(userId);
  if (!details?.stripeSubscriptionId) {
    throw new ValidationError('No subscription found');
  }

  // Only allow canceling incomplete/past_due subscriptions
  const cancelableStatuses = ['incomplete', 'incomplete_expired', 'past_due', 'unpaid'];
  if (!cancelableStatuses.includes(details.subscriptionStatus || '')) {
    throw new ValidationError(`Cannot cancel subscription with status: ${details.subscriptionStatus}. Use the cancel endpoint instead.`);
  }

  // Cancel immediately in Stripe - webhook will handle DB cleanup
  await cancelIncompleteSubscription(details.stripeSubscriptionId);

  logger.info({ userId, subscriptionId: details.stripeSubscriptionId }, 'Incomplete subscription canceled');

  res.json(apiResponse(null, 'Subscription canceled.'));
}));

export default router;
