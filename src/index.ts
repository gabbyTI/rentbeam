import { config } from 'dotenv';
import logger from './lib/logger.js';

// Load environment variables FIRST before any other imports
config();

// Use dynamic import to ensure dotenv loads before server and its dependencies
const { startServer } = await import('./server.js');

// Start the server
startServer().catch((error) => {
  logger.error({ err: error }, 'Failed to start application');
  process.exit(1);
});
