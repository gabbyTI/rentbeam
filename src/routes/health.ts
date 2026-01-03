import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import logger from '../lib/logger.js';

const router = Router();

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  return {
    days,
    hours,
    minutes,
    seconds: secs,
    formatted: `${days}d ${hours}h ${minutes}m ${secs}s`
  };
}

router.get('/', catchAsync(async (req, res) => {
  // Test database connection with a simple query
  await prisma.$connect();
  
  res.json(apiResponse({
    timestamp: new Date().toISOString(),
    database: 'connected',
    uptime: formatUptime(process.uptime()),
  }));
}));

export default router;
