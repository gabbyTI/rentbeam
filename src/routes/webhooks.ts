import { Router, Request, Response } from 'express';
import { stripeService } from '../services/stripe.js';
import { emailService } from '../services/email.js';
import { subscriptionEnforcementService } from '../services/subscriptionEnforcementService.js';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { STRIPE_PRICE_IDS, PlanType } from '../config/stripe.js';
import { getPlan } from '../config/plans.js';
import Stripe from 'stripe';

const router = Router();

// Initialize Stripe client for webhook processing
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-12-15.clover' });

/**
 * Helper: Map Stripe price ID to plan type
 */
function getPlanTypeFromPriceId(priceId: string): PlanType {
  if (priceId === STRIPE_PRICE_IDS.starter) return 'starter';
  if (priceId === STRIPE_PRICE_IDS.growth) return 'growth';
  if (priceId === STRIPE_PRICE_IDS.professional) return 'professional';
  return 'free';
}

/**
 * Helper: Find user by subscription ID or customer ID
 */
async function findUserBySubscriptionOrCustomer(
  subscriptionId: string, 
  customerId: string | Stripe.Customer | Stripe.DeletedCustomer | null
): Promise<{ id: string; planType: string; email: string; name: string } | null> {
  // Try subscription ID first
  let user = await prisma.user.findFirst({
    where: { stripeSubscriptionId: subscriptionId },
    select: { id: true, planType: true, email: true, name: true }
  });

  // Fallback to customer ID
  if (!user && customerId && typeof customerId === 'string') {
    user = await prisma.user.findFirst({
      where: { stripeCustomerId: customerId },
      select: { id: true, planType: true, email: true, name: true }
    });
  }

  return user;
}

/**
 * POST /api/webhooks/stripe
 * Handle Stripe webhook events
 * 
 * IMPORTANT: This route needs raw body, configured in server.ts
 */
router.post('/stripe', async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    logger.warn('Webhook received without signature');
    return res.status(400).send('No signature');
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    logger.error('STRIPE_WEBHOOK_SECRET not configured');
    return res.status(500).send('Webhook secret not configured');
  }

  let event: Stripe.Event;

  try {
    // Verify webhook signature
    event = stripeService.constructWebhookEvent(
      req.body,
      signature as string,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error: any) {
    logger.error({ error: error.message }, 'Webhook signature verification failed');
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  logger.info({ type: event.type, id: event.id }, 'Stripe webhook received');

  try {
    // Idempotency check: Have we already processed this webhook event?
    const existingEvent = await prisma.subscriptionHistory.findFirst({
      where: { stripeEventId: event.id }
    });

    if (existingEvent) {
      logger.info({ 
        eventId: event.id, 
        eventType: event.type,
        existingRecordId: existingEvent.id 
      }, 'Webhook event already processed (idempotency check), skipping');
      return res.status(200).json({ received: true, skipped: true });
    }

    switch (event.type) {
      case 'setup_intent.succeeded':
        await handleSetupIntentSucceeded(event.data.object as Stripe.SetupIntent);
        break;

      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
        break;

      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object as Stripe.Subscription, event.id);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription, event.id);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeletedWebhook(event.data.object as Stripe.Subscription, event.id);
        break;

      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice, event.id);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice, event.id);
        break;

      case 'subscription_schedule.completed':
        await handleSubscriptionScheduleCompleted(event.data.object as Stripe.SubscriptionSchedule, event.id);
        break;

      default:
        logger.info({ type: event.type }, 'Unhandled webhook event type');
    }

    res.json({ received: true });
  } catch (error: any) {
    logger.error({ error: error.message, type: event.type }, 'Error processing webhook');
    res.status(500).send('Webhook processing error');
  }
});

/**
 * Handle setup_intent.succeeded
 * Save payment method to tenant
 */
async function handleSetupIntentSucceeded(setupIntent: Stripe.SetupIntent) {
  const customerId = setupIntent.customer as string;
  const paymentMethodId = setupIntent.payment_method as string;

  if (!customerId || !paymentMethodId) {
    logger.warn({ setupIntentId: setupIntent.id }, 'SetupIntent missing customer or payment method');
    return;
  }

  // Find tenant by customer ID
  const membership = await prisma.tenantMembership.findFirst({
    where: { stripeCustomerId: customerId },
  });

  if (!membership) {
    logger.warn({ customerId }, 'Tenant membership not found for customer');
    return;
  }

  // Get payment method details
  const paymentMethod = await stripeService.getPaymentMethod(paymentMethodId);
  
  let label = 'Card';
  if (paymentMethod.card) {
    label = `${paymentMethod.card.brand.charAt(0).toUpperCase() + paymentMethod.card.brand.slice(1)} •••• ${paymentMethod.card.last4}`;
  }

  // Update tenant membership
  await prisma.tenantMembership.update({
    where: { id: membership.id },
    data: {
      defaultPaymentMethodId: paymentMethodId,
      paymentMethodLabel: label,
      // Reset failure count when new payment method is added
      autopayFailureCount: 0,
      lastAutopayFailureAt: null,
    },
    include: {
      user: true,
      unit: {
        include: {
          property: true,
        },
      },
    },
  });

  logger.info({ 
    tenantMembershipId: membership.id, 
    paymentMethodId, 
    label 
  }, 'Payment method saved for tenant');

  // Send confirmation email
  const updatedMembership = await prisma.tenantMembership.findUnique({
    where: { id: membership.id },
    include: {
      user: true,
      unit: {
        include: {
          property: true,
        },
      },
    },
  });

  if (updatedMembership) {
    await emailService.sendPaymentMethodSavedEmail({
      email: updatedMembership.user.email,
      tenantName: updatedMembership.user.name,
      paymentMethodLabel: label,
      propertyName: updatedMembership.unit.property.name,
      unitName: updatedMembership.unit.name,
    });
  }
}

/**
 * Handle payment_intent.succeeded
 * Create payment record
 */
async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent) {
  logger.info({ 
    paymentIntentId: paymentIntent.id, 
    metadata: paymentIntent.metadata,
    amount: paymentIntent.amount,
    status: paymentIntent.status 
  }, 'Processing payment_intent.succeeded webhook');

  const { tenantMembershipId, month, rentAmount, processingFee } = paymentIntent.metadata;

  if (!tenantMembershipId || !month) {
    logger.warn({ 
      paymentIntentId: paymentIntent.id,
      metadata: paymentIntent.metadata 
    }, 'PaymentIntent missing required metadata');
    return;
  }

  logger.info({ tenantMembershipId, month, rentAmount, processingFee }, 'Extracted metadata from payment intent');

  // Check if payment already recorded (idempotency)
  const existingPayment = await prisma.payment.findFirst({
    where: {
      stripePaymentIntentId: paymentIntent.id,
    },
  });

  if (existingPayment) {
    logger.info({ paymentId: existingPayment.id, paymentIntentId: paymentIntent.id }, 'Payment already recorded (idempotency check)');
    return;
  }

  logger.info('No existing payment found, proceeding to create new payment record');

  // Use processing fee from metadata
  const actualProcessingFee = parseFloat(processingFee || '0');

  logger.info({ 
    rentAmount, 
    processingFee: actualProcessingFee, 
    totalAmount: paymentIntent.amount / 100 
  }, 'Calculated payment amounts');

  // Create payment record
  try {
    const payment = await prisma.payment.create({
      data: {
        tenantMembershipId,
        rentAmount: parseFloat(rentAmount || '0'),
        processingFee: actualProcessingFee,
        platformFee: 0,
        totalAmount: paymentIntent.amount / 100, // Convert from cents
        amount: parseFloat(rentAmount || '0'), // Legacy field
        method: 'CARD',
        status: 'SUCCEEDED',
        date: new Date(),
        month,
        stripePaymentIntentId: paymentIntent.id,
        note: 'Paid via Stripe',
      },
      include: {
        tenantMembership: {
          include: {
            user: true,
            unit: {
              include: {
                property: true,
              },
            },
          },
        },
      },
    });

    logger.info({
      paymentId: payment.id,
      tenantMembershipId,
      amount: payment.totalAmount,
      month,
      stripePaymentIntentId: paymentIntent.id,
    }, 'Payment record created successfully');

    // Send success email
    await emailService.sendPaymentSuccessEmail({
      email: payment.tenantMembership.user.email,
      tenantName: payment.tenantMembership.user.name,
      rentAmount: payment.rentAmount.toString(),
      processingFee: payment.processingFee.toString(),
      totalAmount: payment.totalAmount.toString(),
      paymentDate: payment.date.toLocaleDateString(),
      propertyName: payment.tenantMembership.unit.property.name,
      unitName: payment.tenantMembership.unit.name,
    });

    logger.info({ paymentId: payment.id }, 'Payment success email sent');
  } catch (error: any) {
    logger.error({ 
      error: error.message, 
      stack: error.stack,
      paymentIntentId: paymentIntent.id,
      tenantMembershipId,
      month 
    }, 'Failed to create payment record');
    throw error;
  }
}

/**
 * Handle payment_intent.payment_failed
 * Log failure and send notification email
 */
async function handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent) {
  const { tenantMembershipId, month, rentAmount, autopay } = paymentIntent.metadata;

  logger.error({
    paymentIntentId: paymentIntent.id,
    tenantMembershipId,
    month,
    error: paymentIntent.last_payment_error?.message,
  }, 'Payment intent failed');

  if (!tenantMembershipId) {
    return;
  }

  // Get tenant membership details
  const membership = await prisma.tenantMembership.findUnique({
    where: { id: tenantMembershipId },
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
    logger.warn({ tenantMembershipId }, 'Tenant membership not found for failed payment');
    return;
  }

  // Send failure email
  await emailService.sendPaymentFailedEmail({
    email: membership.user.email,
    tenantName: membership.user.name,
    rentAmount: rentAmount || '0',
    errorMessage: paymentIntent.last_payment_error?.message || 'Payment could not be processed',
    propertyName: membership.unit.property.name,
    unitName: membership.unit.name,
    isAutopay: autopay === 'true',
  });
}

/**
 * Handle customer.subscription.created
 * NOTE: This fires when subscription is CREATED, but payment may not be complete yet
 * We only save the subscription ID - actual plan upgrade happens in invoice.paid
 */
async function handleSubscriptionCreated(subscription: Stripe.Subscription, eventId: string) {
  logger.info({ 
    subscriptionId: subscription.id, 
    customerId: subscription.customer,
    status: subscription.status,
    eventId
  }, 'Processing customer.subscription.created webhook');

  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const user = await findUserBySubscriptionOrCustomer(subscription.id, customerId || null);

  if (!user) {
    logger.warn({ subscriptionId: subscription.id, customerId }, 'User not found for subscription.created');
    return;
  }

  // Only save subscription ID and status - DO NOT update planType or unitLimit
  // Those will be updated when invoice.paid fires (confirming actual payment)
  await prisma.user.update({
    where: { id: user.id },
    data: {
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
    }
  });

  // Log to history
  await prisma.subscriptionHistory.create({
    data: {
      userId: user.id,
      eventType: 'subscription_created',
      fromPlan: user.planType,
      toPlan: user.planType, // Not changing yet
      stripeObjectId: subscription.id,
      stripeEventId: eventId,
      metadata: { 
        status: subscription.status,
        note: 'Subscription created, awaiting payment confirmation'
      }
    }
  });

  logger.info({ subscriptionId: subscription.id, userId: user.id, eventId }, 'Subscription created - awaiting payment');
}

/**
 * Handle customer.subscription.updated
 * Updates: cancel_at_period_end, billing periods, status changes
 * 
 * CRITICAL: This handler DOES NOT change planType or unitLimit
 * All plan changes are handled exclusively by:
 * - invoice.payment_succeeded (upgrades, renewals)
 * - subscription.deleted (revert to free)
 * - subscription_schedule.completed (scheduled downgrades)
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription, eventId: string) {
  logger.info({ 
    subscriptionId: subscription.id, 
    customerId: subscription.customer,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    eventId
  }, 'Processing customer.subscription.updated webhook');

  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const user = await findUserBySubscriptionOrCustomer(subscription.id, customerId || null);

  if (!user) {
    logger.warn({ subscriptionId: subscription.id, customerId }, 'User not found for subscription.updated');
    return;
  }

  // Get plan from subscription for logging only
  const priceId = subscription.items.data[0]?.price.id;
  const stripePlanType = priceId ? getPlanTypeFromPriceId(priceId) : user.planType;

  // ONLY update metadata fields - NEVER planType or unitLimit here
  // This ensures unpaid upgrades don't grant benefits
  const updateData = {
    subscriptionStatus: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodStart: new Date(subscription.items.data[0].current_period_start * 1000),
    currentPeriodEnd: new Date(subscription.items.data[0].current_period_end * 1000),
  };

  await prisma.user.update({
    where: { id: user.id },
    data: updateData
  });

  // Log to history
  await prisma.subscriptionHistory.create({
    data: {
      userId: user.id,
      eventType: 'subscription_updated',
      fromPlan: user.planType,
      toPlan: user.planType, // Plan doesn't change here
      stripeObjectId: subscription.id,
      stripeEventId: eventId,
      metadata: { 
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        stripePlanType, // Log what Stripe thinks the plan is (for debugging)
        note: 'Status/period update only - plan changes via invoice.paid'
      }
    }
  });

  logger.info({ subscriptionId: subscription.id, userId: user.id, eventId }, 'Subscription metadata updated in database');
}

/**
 * Handle customer.subscription.deleted
 * Revert user to free plan and clear subscription data
 */
async function handleSubscriptionDeletedWebhook(subscription: Stripe.Subscription, eventId: string) {
  logger.info({ 
    subscriptionId: subscription.id, 
    customerId: subscription.customer,
    eventId
  }, 'Processing customer.subscription.deleted webhook');

  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const user = await findUserBySubscriptionOrCustomer(subscription.id, customerId || null);

  if (!user) {
    logger.warn({ subscriptionId: subscription.id, customerId }, 'User not found for subscription.deleted');
    return;
  }

  const previousPlan = user.planType;

  // Revert to free plan
  await prisma.user.update({
    where: { id: user.id },
    data: {
      planType: 'free',
      unitLimit: 3,
      subscriptionStatus: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    }
  });

  // Log to history
  await prisma.subscriptionHistory.create({
    data: {
      userId: user.id,
      eventType: 'subscription_deleted',
      fromPlan: previousPlan,
      toPlan: 'free',
      stripeObjectId: subscription.id,
      stripeEventId: eventId,
      metadata: { reason: 'subscription_cancelled_or_expired' }
    }
  });

  // Check enforcement state
  try {
    const enforcementState = await subscriptionEnforcementService.getEnforcementState(user.id);
    if (enforcementState.isOverLimit) {
      logger.warn({ 
        userId: user.id,
        unitCount: enforcementState.unitCount,
        limit: enforcementState.unitLimit,
        overBy: enforcementState.overLimitBy
      }, 'User reverted to free plan with excess units - entering read-only mode');
      
      // TODO: Send email notification
    }
  } catch (error) {
    logger.error({ error, userId: user.id }, 'Error checking enforcement state after subscription deletion');
  }

  logger.info({ subscriptionId: subscription.id, userId: user.id, previousPlan, eventId }, 'User reverted to free plan');
}

/**
 * Handle invoice.payment_succeeded (invoice.paid)
 * THIS IS THE CRITICAL WEBHOOK - grants subscription benefits after payment confirmation
 * Fires for: first subscription payment, upgrades, and renewals
 */
async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice, eventId: string) {
  const invoiceSubscription = (invoice as any).subscription;
  const subscriptionId = typeof invoiceSubscription === 'string' ? invoiceSubscription : invoiceSubscription?.id;
  
  logger.info({ 
    invoiceId: invoice.id,
    subscriptionId,
    amount: invoice.amount_paid,
    status: invoice.status,
    eventId
  }, 'Processing invoice.payment_succeeded webhook');

  // Only process subscription invoices
  if (!subscriptionId) {
    logger.info({ invoiceId: invoice.id }, 'Invoice is not for a subscription, skipping');
    return;
  }

  // Retrieve the full subscription object to get current price/plan
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const user = await findUserBySubscriptionOrCustomer(subscriptionId, customerId || null);

  if (!user) {
    logger.warn({ subscriptionId, customerId, invoiceId: invoice.id }, 'User not found for invoice.payment_succeeded');
    return;
  }

  // Get the plan from the subscription price
  const priceId = subscription.items.data[0]?.price.id;
  const planType = priceId ? getPlanTypeFromPriceId(priceId) : 'free';
  const plan = getPlan(planType as PlanType);
  const previousPlan = user.planType;

  // THIS IS THE ONLY PLACE WHERE WE GRANT SUBSCRIPTION BENEFITS
  // Payment has been confirmed by Stripe - safe to update plan and limits
  await prisma.user.update({
    where: { id: user.id },
    data: {
      planType: planType,
      unitLimit: plan.limits.units,
      subscriptionStatus: subscription.status, // Should be 'active' now
      stripeSubscriptionId: subscription.id,
      currentPeriodStart: new Date(subscription.items.data[0].current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.items.data[0].current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    }
  });

  // Determine event type for logging
  const isUpgrade = previousPlan !== planType && previousPlan !== 'free';
  const isFirstSubscription = previousPlan === 'free';
  const isRenewal = previousPlan === planType;
  
  let eventType = 'payment_succeeded';
  if (isFirstSubscription) eventType = 'subscription_activated';
  else if (isUpgrade) eventType = 'upgrade_completed';
  else if (isRenewal) eventType = 'subscription_renewed';

  // Log to history
  await prisma.subscriptionHistory.create({
    data: {
      userId: user.id,
      eventType,
      fromPlan: previousPlan,
      toPlan: planType,
      stripeObjectId: invoice.id,
      stripeEventId: eventId,
      metadata: { 
        subscriptionId,
        amountPaid: invoice.amount_paid,
        isUpgrade,
        isFirstSubscription,
        isRenewal
      }
    }
  });

  logger.info({ 
    subscriptionId, 
    userId: user.id, 
    previousPlan,
    newPlan: planType,
    eventType,
    eventId 
  }, 'Subscription benefits granted after successful payment');

  // TODO: Send confirmation email
  // if (isFirstSubscription || isUpgrade) {
  //   await emailService.sendSubscriptionConfirmationEmail(user.email, planType);
  // }
}

/**
 * Handle invoice.payment_failed
 * Update status to past_due but DO NOT change plan/limits
 * User keeps access during grace period
 */
async function handleInvoicePaymentFailed(invoice: Stripe.Invoice, eventId: string) {
  const invoiceSubscription = (invoice as any).subscription;
  const subscriptionId = typeof invoiceSubscription === 'string' ? invoiceSubscription : invoiceSubscription?.id;
  
  logger.error({ 
    invoiceId: invoice.id,
    subscriptionId,
    amount: invoice.amount_due,
    attemptCount: invoice.attempt_count,
    eventId
  }, 'Processing invoice.payment_failed webhook');

  // Only process subscription invoices
  if (!subscriptionId) {
    return;
  }

  // Retrieve subscription to get current status
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const user = await findUserBySubscriptionOrCustomer(subscriptionId, customerId || null);

  if (!user) {
    logger.warn({ subscriptionId, customerId, invoiceId: invoice.id }, 'User not found for invoice.payment_failed');
    return;
  }

  // Update status ONLY - do not change plan or limits
  // User keeps access during grace period while payment is retried
  await prisma.user.update({
    where: { id: user.id },
    data: {
      subscriptionStatus: subscription.status, // past_due, incomplete, etc.
    }
  });

  // Log to history
  await prisma.subscriptionHistory.create({
    data: {
      userId: user.id,
      eventType: 'payment_failed',
      fromPlan: user.planType,
      toPlan: user.planType, // Not changing
      stripeObjectId: invoice.id,
      stripeEventId: eventId,
      metadata: { 
        subscriptionId,
        amountDue: invoice.amount_due,
        attemptCount: invoice.attempt_count,
        subscriptionStatus: subscription.status
      }
    }
  });

  logger.error({ 
    subscriptionId, 
    userId: user.id,
    status: subscription.status,
    attemptCount: invoice.attempt_count,
    eventId 
  }, 'Payment failed - user notified, keeping current access');

  // TODO: Send payment failed email
  // try {
  //   await emailService.sendSubscriptionPaymentFailedEmail({
  //     email: user.email,
  //     userName: user.name,
  //     planName: user.planType,
  //     attemptCount: invoice.attempt_count || 1,
  //   });
  // } catch (emailError) {
  //   logger.error({ emailError, userId: user.id }, 'Failed to send payment failed email');
  // }
}

/**
 * Handle subscription_schedule.completed
 * This fires when a scheduled downgrade takes effect at the billing period end
 * The schedule has modified the subscription price, now we apply the plan change
 */
async function handleSubscriptionScheduleCompleted(schedule: Stripe.SubscriptionSchedule, eventId: string) {
  logger.info({ 
    scheduleId: schedule.id, 
    subscriptionId: schedule.subscription,
    status: schedule.status,
    eventId
  }, 'Processing subscription_schedule.completed webhook');

  const subscriptionId = typeof schedule.subscription === 'string' 
    ? schedule.subscription 
    : schedule.subscription?.id;

  if (!subscriptionId) {
    logger.warn({ scheduleId: schedule.id }, 'No subscription ID in schedule.completed');
    return;
  }

  // Get the current subscription to determine new plan
  const subscription = await stripeService.getSubscription(subscriptionId);
  const priceId = subscription.items.data[0]?.price.id;
  const newPlanType = priceId ? getPlanTypeFromPriceId(priceId) : 'free';
  const plan = getPlan(newPlanType as PlanType);

  const customerId = typeof subscription.customer === 'string' 
    ? subscription.customer 
    : subscription.customer?.id;
  
  const user = await findUserBySubscriptionOrCustomer(subscriptionId, customerId || null);

  if (!user) {
    logger.warn({ subscriptionId, customerId, scheduleId: schedule.id }, 'User not found for schedule.completed');
    return;
  }

  const previousPlan = user.planType;

  // Apply the downgrade - update plan and limits
  await prisma.user.update({
    where: { id: user.id },
    data: {
      planType: newPlanType,
      unitLimit: plan.limits.units,
      subscriptionStatus: subscription.status,
      currentPeriodStart: new Date(subscription.items.data[0].current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.items.data[0].current_period_end * 1000),
    }
  });

  // Log to history
  await prisma.subscriptionHistory.create({
    data: {
      userId: user.id,
      eventType: 'scheduled_downgrade_completed',
      fromPlan: previousPlan,
      toPlan: newPlanType,
      stripeObjectId: schedule.id,
      stripeEventId: eventId,
      metadata: { 
        subscriptionId,
        scheduleId: schedule.id,
        previousPlan,
        newPlan: newPlanType,
        newLimit: plan.limits.units
      }
    }
  });

  // Check if user is now over the new limit
  try {
    const enforcementState = await subscriptionEnforcementService.getEnforcementState(user.id);
    if (enforcementState.isOverLimit) {
      logger.warn({ 
        userId: user.id,
        unitCount: enforcementState.unitCount,
        limit: enforcementState.unitLimit,
        overBy: enforcementState.overLimitBy,
        newPlan: newPlanType
      }, 'User downgraded with excess units - entering read-only mode');
      
      // TODO: Send email notification about being over limit
    }
  } catch (error) {
    logger.error({ error, userId: user.id }, 'Error checking enforcement state after scheduled downgrade');
  }

  logger.info({ 
    scheduleId: schedule.id, 
    subscriptionId, 
    userId: user.id, 
    previousPlan, 
    newPlan: newPlanType,
    eventId 
  }, 'Scheduled downgrade completed');
}

export default router;
