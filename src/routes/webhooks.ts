import { Router, Request, Response } from 'express';
import { stripeService } from '../services/stripe.js';
import { emailService } from '../services/email.js';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { 
  syncSubscriptionStatus, 
  updateUserSubscription,
  handleSubscriptionDeleted 
} from '../services/subscriptionService.js';
import Stripe from 'stripe';

const router = Router();

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
 * Sync subscription details to database
 */
async function handleSubscriptionCreated(subscription: Stripe.Subscription, eventId: string) {
  logger.info({ 
    subscriptionId: subscription.id, 
    customerId: subscription.customer,
    status: subscription.status,
    eventId
  }, 'Processing customer.subscription.created webhook');

  await syncSubscriptionStatus(subscription.id);

  // Log webhook event to history
  // Try subscription ID first, fallback to customer ID (race condition)
  let user = await prisma.user.findFirst({
    where: { stripeSubscriptionId: subscription.id }
  });

  if (!user && typeof subscription.customer === 'string') {
    user = await prisma.user.findFirst({
      where: { stripeCustomerId: subscription.customer }
    });
  }

  if (user) {
    await prisma.subscriptionHistory.create({
      data: {
        userId: user.id,
        eventType: 'webhook_received',
        fromPlan: user.planType,
        toPlan: user.planType,
        stripeObjectId: subscription.id,
        stripeEventId: eventId,
        metadata: { webhookType: 'customer.subscription.created', status: subscription.status }
      }
    });
  }

  logger.info({ subscriptionId: subscription.id, eventId }, 'Subscription created and synced to database');
}

/**
 * Handle customer.subscription.updated
 * Sync subscription changes to database (status, plan, period, cancellation)
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription, eventId: string) {
  logger.info({ 
    subscriptionId: subscription.id, 
    customerId: subscription.customer,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    eventId
  }, 'Processing customer.subscription.updated webhook');

  await syncSubscriptionStatus(subscription.id);

  // Log webhook event to history
  // Try subscription ID first, fallback to customer ID (race condition)
  let user = await prisma.user.findFirst({
    where: { stripeSubscriptionId: subscription.id }
  });

  if (!user && typeof subscription.customer === 'string') {
    user = await prisma.user.findFirst({
      where: { stripeCustomerId: subscription.customer }
    });
  }

  if (user) {
    await prisma.subscriptionHistory.create({
      data: {
        userId: user.id,
        eventType: 'webhook_received',
        fromPlan: user.planType,
        toPlan: user.planType,
        stripeObjectId: subscription.id,
        stripeEventId: eventId,
        metadata: { 
          webhookType: 'customer.subscription.updated', 
          status: subscription.status,
          cancelAtPeriodEnd: subscription.cancel_at_period_end
        }
      }
    });
  }

  logger.info({ subscriptionId: subscription.id, eventId }, 'Subscription updated and synced to database');
}

/**
 * Handle customer.subscription.deleted
 * Update user to free plan and remove subscription details
 */
async function handleSubscriptionDeletedWebhook(subscription: Stripe.Subscription, eventId: string) {
  logger.info({ 
    subscriptionId: subscription.id, 
    customerId: subscription.customer,
    eventId
  }, 'Processing customer.subscription.deleted webhook');

  // Get user before deletion for logging
  // Try subscription ID first, fallback to customer ID (race condition)
  let user = await prisma.user.findFirst({
    where: { stripeSubscriptionId: subscription.id }
  });

  if (!user && typeof subscription.customer === 'string') {
    user = await prisma.user.findFirst({
      where: { stripeCustomerId: subscription.customer }
    });
  }

  await handleSubscriptionDeleted(subscription.id);

  // Log webhook event to history
  if (user) {
    await prisma.subscriptionHistory.create({
      data: {
        userId: user.id,
        eventType: 'webhook_received',
        fromPlan: user.planType,
        toPlan: 'free',
        stripeObjectId: subscription.id,
        stripeEventId: eventId,
        metadata: { webhookType: 'customer.subscription.deleted' }
      }
    });
  }

  logger.info({ subscriptionId: subscription.id, eventId }, 'Subscription deleted and user downgraded to free plan');
}

/**
 * Handle invoice.payment_succeeded
 * Confirms successful subscription payment (first payment or renewal)
 */
async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice, eventId: string) {
  logger.info({ 
    invoiceId: invoice.id,
    subscriptionId: (invoice as any).subscription,
    amount: invoice.amount_paid,
    status: invoice.status,
    eventId
  }, 'Processing invoice.payment_succeeded webhook');

  // If this invoice is for a subscription, sync the subscription status
  const subscriptionId = (invoice as any).subscription;
  if (subscriptionId && typeof subscriptionId === 'string') {
    await syncSubscriptionStatus(subscriptionId);
    
    // Log webhook event to history
    const user = await prisma.user.findFirst({
      where: { stripeSubscriptionId: subscriptionId }
    });

    if (user) {
      await prisma.subscriptionHistory.create({
        data: {
          userId: user.id,
          eventType: 'webhook_received',
          fromPlan: user.planType,
          toPlan: user.planType,
          stripeObjectId: invoice.id,
          stripeEventId: eventId,
          metadata: { 
            webhookType: 'invoice.payment_succeeded',
            subscriptionId,
            amountPaid: invoice.amount_paid
          }
        }
      });
    }
    
    logger.info({ subscriptionId, eventId }, 'Subscription synced after successful payment');
  }
}

/**
 * Handle invoice.payment_failed
 * Handle failed subscription payments (first payment or renewal)
 */
async function handleInvoicePaymentFailed(invoice: Stripe.Invoice, eventId: string) {
  logger.error({ 
    invoiceId: invoice.id,
    subscriptionId: (invoice as any).subscription,
    amount: invoice.amount_due,
    attemptCount: invoice.attempt_count,
    eventId
  }, 'Processing invoice.payment_failed webhook');

  // If this invoice is for a subscription, sync the subscription status
  // This will update the status to past_due or unpaid
  const subscriptionId = (invoice as any).subscription;
  if (subscriptionId && typeof subscriptionId === 'string') {
    await syncSubscriptionStatus(subscriptionId);
    
    // Get user for notification
    const user = await prisma.user.findFirst({
      where: { stripeSubscriptionId: subscriptionId }
    });

    if (user) {
      logger.error({ 
        userId: user.id,
        userEmail: user.email,
        subscriptionId,
        attemptCount: invoice.attempt_count,
        eventId
      }, 'Subscription payment failed');

      // Log webhook event to history
      await prisma.subscriptionHistory.create({
        data: {
          userId: user.id,
          eventType: 'webhook_received',
          fromPlan: user.planType,
          toPlan: user.planType,
          stripeObjectId: invoice.id,
          stripeEventId: eventId,
          metadata: { 
            webhookType: 'invoice.payment_failed',
            subscriptionId,
            amountDue: invoice.amount_due,
            attemptCount: invoice.attempt_count
          }
        }
      });

      // TODO: Send email notification to user about payment failure
      // await emailService.sendPaymentFailedNotification(user.email, ...);
    }
  }
}

export default router;
