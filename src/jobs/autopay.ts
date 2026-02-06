import prisma from '../lib/prisma.js';
import { stripeService } from '../services/stripe.js';
import { cronExecutionsTotal, cronLastRunTimestamp, paymentsTotal, paymentsAmountCents } from '../lib/metrics.js';
import { emailService } from '../services/email.js';
import logger from '../lib/logger.js';

interface AutopayResult {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: Array<{
    tenantMembershipId: string;
    error: string;
  }>;
}

/**
 * Process autopay charges for all eligible tenants
 * Called daily by cron job or EventBridge
 */
export async function processAutopayCharges(): Promise<AutopayResult> {
  const startTime = Date.now();
  try {
    const today = new Date();
    const currentDay = today.getDate();
    const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

    logger.info({ date: today, currentDay, currentMonth }, 'Starting autopay processing');

    const result: AutopayResult = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    };

    try {
      // Find all tenants eligible for autopay today
      const eligibleTenants = await prisma.tenantMembership.findMany({
        where: {
          autopayEnabled: true,
          status: 'ACTIVE',
          defaultPaymentMethodId: { not: null },
          unit: {
            property: {
              acceptOnlinePayments: true, // Only process tenants in properties that accept online payments
            },
          },
        },
        include: {
          user: true,
          unit: {
            include: {
              property: {
                include: {
                  landlord: {
                    include: {
                      user: true,
                    },
                  },
                },
              },
            },
          },
          payments: {
            where: {
              month: currentMonth,
            },
          },
        },
      });

      logger.info({ count: eligibleTenants.length }, 'Found eligible tenants for autopay');

      for (const tenant of eligibleTenants) {
        result.processed++;

        try {
          const dueDay = tenant.unit.dueDay;
          const gracePeriodDays = tenant.unit.gracePeriodDays;

          // Check if today is within the grace period (dueDay to dueDay + gracePeriodDays)
          if (currentDay < dueDay || currentDay > (dueDay + gracePeriodDays)) {
            logger.info(
              { tenantMembershipId: tenant.id, currentDay, dueDay, gracePeriodDays },
              'Not within grace period, skipping'
            );
            result.skipped++;
            continue;
          }

          // Skip if already paid this month (SUCCEEDED or PROCESSING only, not FAILED)
          const successfulPayment = tenant.payments.find(p => p.status === 'SUCCEEDED' || p.status === 'PROCESSING');
          if (successfulPayment) {
            logger.info(
              { tenantMembershipId: tenant.id, month: currentMonth },
              'Payment already exists for this month, skipping'
            );
            result.skipped++;
            continue;
          }

          // Skip if no payment method
          if (!tenant.defaultPaymentMethodId || !tenant.stripeCustomerId) {
            logger.warn(
              { tenantMembershipId: tenant.id },
              'Missing payment method or customer ID, skipping'
            );
            result.skipped++;
            continue;
          }

          const rentAmount = Number(tenant.unit.rentAmount);
          // Use paymentMethodType to calculate correct fee (Card vs PAD)
          const paymentMethodType = (tenant as any).paymentMethodType || 'card';
          const { processingFee, totalAmount } = stripeService.calculateProcessingFee(rentAmount, paymentMethodType);

          // Convert to cents for Stripe
          const amountInCents = Math.round(totalAmount * 100);

          // Check if landlord has Stripe account
          const landlordStripeAccountId = tenant.unit.property.landlord.stripeAccountId;
          if (!landlordStripeAccountId) {
            logger.warn(
              { tenantMembershipId: tenant.id, landlordId: tenant.unit.property.landlord.id },
              'Landlord has not completed payment setup, skipping'
            );
            result.skipped++;
            continue;
          }

          // Determine currency based on landlord's country
          const landlordCountry = tenant.unit.property.landlord.user.country;
          const currency = landlordCountry === 'CA' ? 'cad' : 'usd';

          logger.info(
            {
              tenantMembershipId: tenant.id,
              rentAmount,
              processingFee,
              totalAmount,
              amountInCents,
              currency,
            },
            'Processing autopay charge'
          );

          // Determine payment method types based on tenant's saved payment method
          const paymentMethodTypes = paymentMethodType === 'acss_debit' ? ['acss_debit'] : ['card'];

          // Create payment intent with off_session flag
          const paymentIntent = await stripeService.createPaymentIntent({
            amount: amountInCents,
            currency,
            customerId: tenant.stripeCustomerId,
            paymentMethodId: tenant.defaultPaymentMethodId,
            connectedAccountId: landlordStripeAccountId, // Route to landlord
            mandateId: (tenant as any).mandateId || undefined, // Pass mandate for ACSS Debit
            paymentMethodTypes, // Pass correct payment method types
            metadata: {
              tenantMembershipId: tenant.id,
              month: currentMonth,
              rentAmount: rentAmount.toFixed(2),
              processingFee: processingFee.toFixed(2),
              autopay: 'true',
            },
            confirm: true,
            offSession: true,
          });

          if (paymentIntent.status === 'succeeded') {
            // Reset failure count on successful payment
            if (tenant.autopayFailureCount > 0) {
              await prisma.tenantMembership.update({
                where: { id: tenant.id },
                data: {
                  autopayFailureCount: 0,
                  lastAutopayFailureAt: null,
                },
              });
              logger.info(
                { tenantMembershipId: tenant.id },
                'Autopay failure count reset after successful payment'
              );
            }

            logger.info(
              {
                tenantMembershipId: tenant.id,
                paymentIntentId: paymentIntent.id,
                amount: totalAmount,
              },
              'Autopay charge succeeded'
            );
            result.succeeded++;
          } else {
            logger.warn(
              {
                tenantMembershipId: tenant.id,
                paymentIntentId: paymentIntent.id,
                status: paymentIntent.status,
              },
              'Autopay charge in unexpected state'
            );
          }
        } catch (error: any) {
          logger.error(
            {
              tenantMembershipId: tenant.id,
              error: error.message,
              code: error.code,
            },
            'Autopay charge failed'
          );

          result.failed++;
          result.errors.push({
            tenantMembershipId: tenant.id,
            error: error.message || 'Unknown error',
          });

          // Webhook will handle:
          // - Creating FAILED payment record
          // - Incrementing failure count
          // - Sending failure email
          // - Disabling autopay after 3 strikes
        }
      }

      logger.info(
        {
          processed: result.processed,
          succeeded: result.succeeded,
          failed: result.failed,
          skipped: result.skipped,
        },
        'Autopay processing complete'
      );

      logger.info(result, 'Autopay processing completed');
      return result;
    } catch (error: any) {
      logger.error({ error: error.message }, 'Fatal error during autopay processing');
      throw error;
    } finally {
      cronExecutionsTotal.inc({ job: "autopay", status: "success" });
      cronLastRunTimestamp.set({ job: "autopay" }, Math.floor(Date.now() / 1000));
    }
  } catch (error: any) {
    logger.error({ error: error.message }, 'Unexpected error in autopay processing');
    throw error;
  }
}
