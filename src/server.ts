import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import promBundle from 'express-prom-bundle';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import propertyRoutes from './routes/properties.js';
import unitRoutes from './routes/units.js';
import tenantRoutes from './routes/tenants.js';
import landlordRoutes from './routes/landlord.js';
import paymentRoutes from './routes/payments.js';
import inviteRoutes from './routes/invites.js';
import stripeRoutes from './routes/stripe.js';
import webhookRoutes from './routes/webhooks.js';
import cronRoutes from './routes/cron.js';
import { errorHandler } from './middleware/errorHandler.js';
import prisma from './lib/prisma.js';
import logger from './lib/logger.js';
import { initializeScheduler } from './jobs/scheduler.js';

// Initialize Express app
const app = express();

// Prometheus metrics middleware (before other middleware)
const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  includeStatusCode: true,
  includeUp: true,
  customLabels: { app: 'renttrack-api' },
  promClient: {
    collectDefaultMetrics: {},
  },
});
app.use(metricsMiddleware);

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

// Webhook routes BEFORE json middleware (needs raw body)
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

// JSON middleware for all other routes
app.use(express.json());
app.use(pinoHttp({ 
  logger,
  autoLogging: {
    ignore: (req) => req.url === '/health'
  },
  customSuccessMessage: (req, res) => {
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    return `${req.method} ${fullUrl} ${res.statusCode}`;
  },
  customErrorMessage: (req, res, err) => {
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    return `${req.method} ${fullUrl} ${res.statusCode} - ${err.message}`;
  },
  serializers: {
    req: () => undefined,
    res: () => undefined
  }
}));

// Routes
app.use('/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/units', unitRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/landlord', landlordRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/stripe/connect', stripeRoutes);
app.use('/api/stripe', stripeRoutes); // Add non-connect Stripe routes
app.use('/api/cron', cronRoutes); // Cron endpoints

// Error handler (must be last)
app.use(errorHandler);

// Server startup function
export async function startServer() {
  const PORT = process.env.PORT || 3000;
  
  try {
    // Test database connection
    await prisma.$connect();
    logger.info('Successfully connected to database');

    const server = app.listen(PORT, () => {
      logger.info(`Server running on http://localhost:${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
      
      // Initialize cron scheduler after server starts
      initializeScheduler();
    });

    // Graceful shutdown handling
    async function gracefulShutdown(signal: string) {
      logger.info(`${signal} received. Starting graceful shutdown...`);

      try {
        // Close server first (stop accepting new requests)
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        logger.info('HTTP server closed');

        // Close database connections
        await prisma.$disconnect();
        logger.info('Database connections closed');

        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during graceful shutdown');
        process.exit(1);
      }
    }

    // Handle shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    return { app, server };
  } catch (error) {
    logger.error({ err: error, stack: (error instanceof Error) ? error.stack : undefined }, 'Failed to start server');
    throw error;
  }
}

export { app, logger };
