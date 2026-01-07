import prisma from '../lib/prisma.js';
import { emailService } from '../services/email.js';
import { cronExecutionsTotal, cronLastRunTimestamp } from '../lib/metrics.js';
import logger from '../lib/logger.js';

interface ReminderResult {
  processed: number;
  sent: number;
  skipped: number;
  errors: Array<{
    tenantMembershipId: string;
    error: string;
  }>;
}

/**
 * Send payment reminders to tenants
 * Called daily by cron job - sends reminders 3 days before due date
 */
export async function sendPaymentReminders(): Promise<ReminderResult> {
  const result: ReminderResult = {
    processed: 0,
    sent: 0,
    skipped: 0,
    errors: [],
  };

  try {
  const today = new Date();
  const currentDay = today.getDate();
  const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

  // Calculate target due day (3 days from now)
  const reminderDate = new Date(today);
  reminderDate.setDate(today.getDate() + 3);
  const targetDueDay = reminderDate.getDate();

  logger.info({ 
    date: today, 
    currentDay, 
    targetDueDay,
    currentMonth 
  }, 'Starting payment reminder processing');

    // Find all active tenants whose rent is due in 3 days (only in properties accepting online payments)
    const eligibleTenants = await prisma.tenantMembership.findMany({
      where: {
        status: 'ACTIVE',
        unit: {
          dueDay: targetDueDay,
          property: {
            acceptOnlinePayments: true, // Only send reminders for properties with online payments enabled
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

    logger.info({ count: eligibleTenants.length }, 'Found tenants with rent due in 3 days');

    for (const tenant of eligibleTenants) {
      result.processed++;

      try {
        // Skip if already paid this month
        if (tenant.payments.length > 0) {
          logger.info(
            { tenantMembershipId: tenant.id, month: currentMonth },
            'Payment already exists for this month, skipping reminder'
          );
          result.skipped++;
          continue;
        }

        const rentAmount = Number(tenant.unit.rentAmount);
        const dueDate = new Date(today.getFullYear(), today.getMonth(), tenant.unit.dueDay);

        logger.info(
          {
            tenantMembershipId: tenant.id,
            tenantName: tenant.user.name,
            rentAmount,
            dueDay: tenant.unit.dueDay,
            autopayEnabled: tenant.autopayEnabled,
          },
          'Sending payment reminder'
        );

        // Send reminder email
        await emailService.sendPaymentReminderEmail({
          email: tenant.user.notificationEmail || tenant.user.email,
          tenantName: tenant.user.name,
          rentAmount: rentAmount.toFixed(2),
          dueDate: dueDate.toLocaleDateString(),
          propertyName: tenant.unit.property.name,
          unitName: tenant.unit.name,
          autopayEnabled: tenant.autopayEnabled,
          gracePeriodDays: tenant.unit.gracePeriodDays,
        });

        result.sent++;

        logger.info(
          { tenantMembershipId: tenant.id },
          'Payment reminder sent successfully'
        );
      } catch (error: any) {
        logger.error(
          {
            tenantMembershipId: tenant.id,
            error: error.message,
          },
          'Failed to send payment reminder'
        );

        result.errors.push({
          tenantMembershipId: tenant.id,
          error: error.message || 'Unknown error',
        });
      }
    }

    logger.info(result, 'Payment reminder processing completed');
    return result;
  } catch (error: any) {
    logger.error({ error: error.message }, 'Fatal error during reminder processing');
    throw error;
  } finally {
    cronExecutionsTotal.inc({ job: "reminders", status: "success" });
    cronLastRunTimestamp.set({ job: "reminders" }, Math.floor(Date.now() / 1000));
  }
}
