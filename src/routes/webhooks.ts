import { Router, Request, Response } from 'express';
import { stripeService } from '../services/stripe.js';
import { emailService } from '../services/email.js';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
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
  const { tenantMembershipId, month, rentAmount, processingFee } = paymentIntent.metadata;

  if (!tenantMembershipId || !month) {
    logger.warn({ paymentIntentId: paymentIntent.id }, 'PaymentIntent missing required metadata');
    return;
  }

  // Check if payment already recorded (idempotency)
  const existingPayment = await prisma.payment.findFirst({
    where: {
      stripePaymentIntentId: paymentIntent.id,
    },
  });

  if (existingPayment) {
    logger.info({ paymentId: existingPayment.id }, 'Payment already recorded');
    return;
  }

  // Get actual fee from Stripe balance transaction
  let actualProcessingFee = parseFloat(processingFee || '0');
  if (paymentIntent.charges.data.length > 0) {
    const charge = paymentIntent.charges.data[0];
    if (charge.balance_transaction) {
      // Note: balance_transaction is just an ID, would need to fetch it
      // For now, use metadata fee
      actualProcessingFee = parseFloat(processingFee || '0');
    }
  }

  // Create payment record
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
  }, 'Payment recorded from Stripe');

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

export default router;
