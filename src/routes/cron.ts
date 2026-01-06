import { Router, Request, Response } from 'express';
import { processAutopayCharges } from '../jobs/autopay.js';
import { sendPaymentReminders } from '../jobs/reminders.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import logger from '../lib/logger.js';

const router = Router();

// Middleware to verify cron requests
const verifyCronSecret = (req: Request, res: Response, next: Function) => {
  const cronSecret = process.env.CRON_SECRET;
  
  // If CRON_SECRET is not set, allow in development only
  if (!cronSecret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('CRON_SECRET not set in production');
      return res.status(500).json({ error: 'Server misconfiguration' });
    }
    logger.warn('CRON_SECRET not set, allowing request in development');
    return next();
  }

  const authHeader = req.headers.authorization;
  const providedSecret = authHeader?.replace('Bearer ', '');

  if (providedSecret !== cronSecret) {
    logger.warn({ ip: req.ip }, 'Unauthorized cron request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
};

// POST /api/cron/process-autopay
// Process autopay charges for all eligible tenants
router.post('/process-autopay', verifyCronSecret, catchAsync(async (req: Request, res: Response) => {
  logger.info({ source: 'cron-endpoint' }, 'Processing autopay charges via HTTP endpoint');

  const result = await processAutopayCharges();

  res.json(apiResponse(result, 'Autopay processing completed'));
}));

// POST /api/cron/send-reminders
// Send payment reminders to tenants 3 days before due date
router.post('/send-reminders', verifyCronSecret, catchAsync(async (req: Request, res: Response) => {
  logger.info({ source: 'cron-endpoint' }, 'Sending payment reminders via HTTP endpoint');

  const result = await sendPaymentReminders();

  res.json(apiResponse(result, 'Payment reminders sent'));
}));

// GET /api/cron/health
// Health check endpoint for monitoring
router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;
