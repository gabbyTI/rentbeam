import logger from '../lib/logger.js';
import { generateRecurringUnitChargesForDate } from '../services/recurringCharges.js';

export async function processRecurringChargesForToday() {
  const today = new Date();

  logger.info({ today: today.toISOString() }, 'Processing recurring unit charges');

  const result = await generateRecurringUnitChargesForDate(today);

  logger.info({ count: result.generated.length }, 'Recurring unit charge processing complete');
  return result;
}
