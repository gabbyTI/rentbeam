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
            dueDay: currentDay,
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
                rentAmount: Number(tenant.unit.rentAmount).toFixed(2),
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
