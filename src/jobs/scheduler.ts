import cron from 'node-cron';
import axios from 'axios';
import logger from '../lib/logger.js';
import { postMonthlyRentCharges } from './rentCharges.js';

/**
 * Initialize cron jobs
 * Only runs if ENABLE_CRON=true in environment
 */
export function initializeScheduler() {
  const enableCron = process.env.ENABLE_CRON === 'true';
  
  if (!enableCron) {
    logger.info('Cron scheduler disabled (ENABLE_CRON not set to true)');
    return;
  }

  const cronSecret = process.env.CRON_SECRET;
  const port = process.env.PORT || 3000;
  const baseUrl = process.env.API_BASE_URL || `http://localhost:${port}`;

  logger.info({ enableCron, baseUrl }, 'Initializing cron scheduler');

  // Run autopay processing daily at 00:00 (midnight)
  const autopayJob = cron.schedule('0 0 * * *', async () => {
    logger.info('Cron: Triggering autopay processing');

    try {
      const response = await axios.post(
        `${baseUrl}/api/cron/process-autopay`,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            ...(cronSecret && { Authorization: `Bearer ${cronSecret}` }),
          },
          timeout: 300000, // 5 minute timeout
        }
      );

      logger.info({ result: response.data }, 'Cron: Autopay processing completed');
    } catch (error: any) {
      logger.error(
        {
          error: error.message,
          response: error.response?.data,
        },
        'Cron: Autopay processing failed'
      );
    }
  });

  // Optional: Run at 10 AM for any failed morning attempts (grace period)
  const retryJob = cron.schedule('0 10 * * *', async () => {
    logger.info('Cron: Triggering autopay retry processing');

    try {
      const response = await axios.post(
        `${baseUrl}/api/cron/process-autopay`,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            ...(cronSecret && { Authorization: `Bearer ${cronSecret}` }),
          },
          timeout: 300000,
        }
      );

      logger.info({ result: response.data }, 'Cron: Autopay retry completed');
    } catch (error: any) {
      logger.error(
        {
          error: error.message,
          response: error.response?.data,
        },
        'Cron: Autopay retry failed'
      );
    }
  });

  // Send payment reminders daily at 09:00 (9 AM)
  const reminderJob = cron.schedule('0 9 * * *', async () => {
    logger.info('Cron: Triggering payment reminders');

    try {
      const response = await axios.post(
        `${baseUrl}/api/cron/send-reminders`,
        {},
        {
          headers: {
            'Content-Type': 'application/json',
            ...(cronSecret && { Authorization: `Bearer ${cronSecret}` }),
          },
          timeout: 300000,
        }
      );

      logger.info({ result: response.data }, 'Cron: Payment reminders completed');
    } catch (error: any) {
      logger.error(
        {
          error: error.message,
          response: error.response?.data,
        },
        'Cron: Payment reminders failed'
      );
    }
  });

  logger.info('Cron jobs scheduled: autopay at 00:00 and 10:00, reminders at 09:00, rent charges at 00:05 daily');

  // Post monthly rent charges at 00:05 daily (just after midnight, after autopay kick-off)
  const rentChargeJob = cron.schedule('5 0 * * *', async () => {
    logger.info('Cron: Posting monthly rent charges to ledger');
    try {
      const result = await postMonthlyRentCharges();
      logger.info({ result }, 'Cron: Rent charge posting complete');
    } catch (error: any) {
      logger.error({ error: error.message }, 'Cron: Rent charge posting failed');
    }
  });

  // Return jobs for potential cleanup on shutdown
  return { autopayJob, retryJob, reminderJob, rentChargeJob };
}
