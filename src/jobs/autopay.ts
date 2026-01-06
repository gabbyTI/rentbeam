import prisma from '../lib/prisma.js';
import { stripeService } from '../services/stripe.js';
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
          dueDay: currentDay,
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
        // Skip if already paid this month
        if (tenant.payments.length > 0) {
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
        const { processingFee, totalAmount } = stripeService.calculateProcessingFee(rentAmount);

        // Convert to cents for Stripe
        const amountInCents = Math.round(totalAmount * 100);

        logger.info(
          {
            tenantMembershipId: tenant.id,
            rentAmount,
            processingFee,
            totalAmount,
            amountInCents,
          },
          'Processing autopay charge'
        );

        // Create payment intent with off_session flag
        const paymentIntent = await stripeService.createPaymentIntent({
          amount: amountInCents,
          currency: 'usd',
          customerId: tenant.stripeCustomerId,
          paymentMethodId: tenant.defaultPaymentMethodId,
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

        // Handle specific Stripe errors
        if (error.code === 'card_declined' || error.code === 'insufficient_funds') {
          // Increment failure count
          const currentFailureCount = tenant.autopayFailureCount + 1;
          
          await prisma.tenantMembership.update({
            where: { id: tenant.id },
            data: {
              autopayFailureCount: currentFailureCount,
              lastAutopayFailureAt: new Date(),
            },
          });

          logger.info(
            { tenantMembershipId: tenant.id, errorCode: error.code, failureCount: currentFailureCount },
            'Card declined - failure count updated'
          );

          // Disable autopay after 3 failures
          if (currentFailureCount >= 3) {
            await prisma.tenantMembership.update({
              where: { id: tenant.id },
              data: {
                autopayEnabled: false,
                autopayDisabledAt: new Date(),
                autopayDisableReason: `Autopay disabled after ${currentFailureCount} failed payment attempts. Please update your payment method.`,
              },
            });

            logger.warn(
              { tenantMembershipId: tenant.id, failureCount: currentFailureCount },
              'Autopay disabled after 3 failed attempts'
            );

            // Send autopay disabled email
            await emailService.sendAutopayDisabledEmail({
              email: tenant.user.email,
              tenantName: tenant.user.name,
              reason: `Your card was declined 3 times. Please update your payment method and re-enable autopay.`,
              propertyName: tenant.unit.property.name,
              unitName: tenant.unit.name,
            });
          } else {
            // Send payment failed email (will retry on next run)
            await emailService.sendPaymentFailedEmail({
              email: tenant.user.email,
              tenantName: tenant.user.name,
              rentAmount: rentAmount.toFixed(2),
              errorMessage: error.message || 'Card declined',
              propertyName: tenant.unit.property.name,
              unitName: tenant.unit.name,
              isAutopay: true,
              failureCount: currentFailureCount,
            });
          }
        } else if (error.code === 'authentication_required') {
          // Card requires 3D Secure, disable autopay
          await prisma.tenantMembership.update({
            where: { id: tenant.id },
            data: {
              autopayEnabled: false,
              autopayDisabledAt: new Date(),
              autopayDisableReason: 'Card requires authentication - please update payment method',
            },
          });
          logger.warn(
            { tenantMembershipId: tenant.id },
            'Autopay disabled due to authentication requirement'
          );
          
          // Send email notification
          await emailService.sendAutopayDisabledEmail({
            email: tenant.user.email,
            tenantName: tenant.user.name,
            reason: 'Your card requires additional authentication. Please update your payment method.',
            propertyName: tenant.unit.property.name,
            unitName: tenant.unit.name,
          });
        }
      }
    }

    logger.info(result, 'Autopay processing completed');
  } catch (error: any) {
    logger.error({ error: error.message }, 'Fatal error during autopay processing');
    throw error;
  }

  return result;
}
