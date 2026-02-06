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

      case 'payment_intent.processing':
        await handlePaymentIntentProcessing(event.data.object as Stripe.PaymentIntent);
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
  const mandateId = setupIntent.mandate as string; // Capture mandate ID for PAD

  let label = 'Card';
  let type = 'card';

  if (paymentMethod.card) {
    label = `${paymentMethod.card.brand.charAt(0).toUpperCase() + paymentMethod.card.brand.slice(1)} •••• ${paymentMethod.card.last4}`;
    type = 'card';
  } else if (paymentMethod.acss_debit) {
    label = `Bank Account •••• ${paymentMethod.acss_debit.last4}`;
    type = 'acss_debit';
  }

  // Update tenant membership
  await prisma.tenantMembership.update({
    where: { id: membership.id },
    data: {
      defaultPaymentMethodId: paymentMethodId,
      paymentMethodLabel: label,
      paymentMethodType: type,
      mandateId: mandateId || null,
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

  const { tenantMembershipId, month, rentAmount, processingFee, autopay } = paymentIntent.metadata;

  if (!tenantMembershipId || !month) {
    logger.warn({
      paymentIntentId: paymentIntent.id,
      metadata: paymentIntent.metadata
    }, 'PaymentIntent missing required metadata');
    return;
  }

  logger.info({ tenantMembershipId, month, rentAmount, processingFee }, 'Extracted metadata from payment intent');

  // Use processing fee from metadata
  const actualProcessingFee = parseFloat(processingFee || '0');

  logger.info({
    rentAmount,
    processingFee: actualProcessingFee,
    totalAmount: paymentIntent.amount / 100
  }, 'Calculated payment amounts');

  // Upsert payment record - update PROCESSING to SUCCEEDED, or create new
  try {
    const existingPayment = await prisma.payment.findUnique({
      where: { stripePaymentIntentId: paymentIntent.id },
    });

    let payment;
    if (existingPayment) {
      // Update existing PROCESSING payment to SUCCEEDED
      payment = await prisma.payment.update({
        where: { stripePaymentIntentId: paymentIntent.id },
        data: { status: 'SUCCEEDED' },
        include: {
          tenantMembership: {
            include: {
              user: true,
              unit: { include: { property: true } },
            },
          },
        },
      });
      logger.info({ paymentId: payment.id }, 'Updated PROCESSING payment to SUCCEEDED');
    } else {
      // Create new SUCCEEDED payment (card payments skip processing)
      payment = await prisma.payment.create({
        data: {
          tenantMembershipId,
          rentAmount: parseFloat(rentAmount || '0'),
          processingFee: actualProcessingFee,
          platformFee: 0,
          totalAmount: paymentIntent.amount / 100,
          amount: parseFloat(rentAmount || '0'),
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
              unit: { include: { property: true } },
            },
          },
        },
      });
      logger.info({ paymentId: payment.id }, 'Created new SUCCEEDED payment (card)');
    }

    // Send success email (for both update and create)
    logger.info({
      paymentId: payment.id,
      tenantMembershipId,
      amount: payment.totalAmount,
      month,
      stripePaymentIntentId: paymentIntent.id,
    }, 'Payment record created successfully');

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

    // Reset autopay failure count on successful autopay payment
    if (autopay === 'true' && payment.tenantMembership.autopayFailureCount > 0) {
      await prisma.tenantMembership.update({
        where: { id: tenantMembershipId },
        data: {
          autopayFailureCount: 0,
          lastAutopayFailureAt: null,
        },
      });

      logger.info(
        { tenantMembershipId, paymentId: payment.id },
        'Autopay failure count reset after successful payment'
      );
    }
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
 * Handle payment_intent.processing
 * Create PROCESSING payment record for bank transfers (ACSS Debit)
 */
async function handlePaymentIntentProcessing(paymentIntent: Stripe.PaymentIntent) {
  logger.info({
    paymentIntentId: paymentIntent.id,
    metadata: paymentIntent.metadata,
    amount: paymentIntent.amount,
  }, 'Processing payment_intent.processing webhook');

  const { tenantMembershipId, month, rentAmount, processingFee } = paymentIntent.metadata;

  if (!tenantMembershipId || !month) {
    logger.warn({ paymentIntentId: paymentIntent.id }, 'PaymentIntent missing required metadata');
    return;
  }

  // Check if payment already exists (idempotency)
  const existingPayment = await prisma.payment.findUnique({
    where: { stripePaymentIntentId: paymentIntent.id },
  });

  if (existingPayment) {
    logger.info({ paymentId: existingPayment.id }, 'Payment already exists for this PaymentIntent');
    return;
  }

  const actualProcessingFee = parseFloat(processingFee || '0');

  // Create PROCESSING payment record
  try {
    const payment = await prisma.payment.create({
      data: {
        tenantMembershipId,
        rentAmount: parseFloat(rentAmount || '0'),
        processingFee: actualProcessingFee,
        platformFee: 0,
        totalAmount: paymentIntent.amount / 100,
        amount: parseFloat(rentAmount || '0'),
        method: 'CARD',
        status: 'PROCESSING',
        date: new Date(),
        month,
        stripePaymentIntentId: paymentIntent.id,
        note: 'Bank transfer',
      },
    });

    logger.info({
      paymentId: payment.id,
      tenantMembershipId,
      month,
      status: 'PROCESSING',
    }, 'PROCESSING payment record created');
  } catch (error: any) {
    logger.error({
      error: error.message,
      paymentIntentId: paymentIntent.id,
    }, 'Failed to create PROCESSING payment record');
    throw error;
  }
}

/**
 * Handle payment_intent.payment_failed
 * Create FAILED payment record and handle autopay failure tracking
 */
async function handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent) {
  const { tenantMembershipId, month, rentAmount, processingFee, autopay } = paymentIntent.metadata;

  logger.error({
    paymentIntentId: paymentIntent.id,
    tenantMembershipId,
    month,
    error: paymentIntent.last_payment_error?.message,
  }, 'Payment intent failed');

  if (!tenantMembershipId || !month) {
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

  // Create FAILED payment record
  const actualProcessingFee = parseFloat(processingFee || '0');
  const errorMessage = paymentIntent.last_payment_error?.message || 'Payment could not be processed';

  try {
    await prisma.payment.create({
      data: {
        tenantMembershipId,
        rentAmount: parseFloat(rentAmount || '0'),
        processingFee: actualProcessingFee,
        platformFee: 0,
        totalAmount: paymentIntent.amount / 100,
        amount: parseFloat(rentAmount || '0'),
        method: 'CARD',
        status: 'FAILED',
        date: new Date(),
        month,
        stripePaymentIntentId: paymentIntent.id,
        note: `Payment failed: ${errorMessage}`,
      },
    });

    logger.info({
      paymentIntentId: paymentIntent.id,
      tenantMembershipId,
      month,
    }, 'FAILED payment record created');
  } catch (error: any) {
    logger.error({
      error: error.message,
      paymentIntentId: paymentIntent.id,
    }, 'Failed to create FAILED payment record');
  }

  // Handle autopay failure tracking
  if (autopay === 'true') {
    const currentFailureCount = membership.autopayFailureCount + 1;

    await prisma.tenantMembership.update({
      where: { id: tenantMembershipId },
      data: {
        autopayFailureCount: currentFailureCount,
        lastAutopayFailureAt: new Date(),
      },
    });

    logger.info(
      { tenantMembershipId, failureCount: currentFailureCount },
      'Autopay failure count updated'
    );

    // Disable autopay after 3 failures
    if (currentFailureCount >= 3) {
      await prisma.tenantMembership.update({
        where: { id: tenantMembershipId },
        data: {
          autopayEnabled: false,
          autopayDisabledAt: new Date(),
          autopayDisableReason: `Autopay disabled after ${currentFailureCount} failed payment attempts. Please update your payment method.`,
        },
      });

      logger.warn(
        { tenantMembershipId, failureCount: currentFailureCount },
        'Autopay disabled after 3 failed attempts'
      );

      // Send autopay disabled email
      await emailService.sendAutopayDisabledEmail({
        email: membership.user.email,
        tenantName: membership.user.name,
        reason: `Your payment method was declined 3 times. Please update your payment method and re-enable autopay.`,
        propertyName: membership.unit.property.name,
        unitName: membership.unit.name,
      });

      return; // Don't send regular failure email, autopay disabled email sent instead
    }
  }

  // Send failure email
  await emailService.sendPaymentFailedEmail({
    email: membership.user.email,
    tenantName: membership.user.name,
    rentAmount: rentAmount || '0',
    errorMessage,
    propertyName: membership.unit.property.name,
    unitName: membership.unit.name,
    isAutopay: autopay === 'true',
  });
}

export default router;
