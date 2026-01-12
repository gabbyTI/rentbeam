import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { PlanType } from '../config/stripe.js';
import { canAddUnit, isSubscriptionActive, getUnitCount } from '../utils/subscriptionHelpers.js';
import { getPlan } from '../config/plans.js';
import { AuthRequest } from './auth.js';
import logger from '../lib/logger.js';

const prisma = new PrismaClient();

/**
 * Middleware to check if user can add a new unit (property/tenant)
 * Verifies they haven't exceeded their plan's unit limit
 */
export async function checkUnitLimit(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Check if user can add another unit
    const canAdd = await canAddUnit(userId);

    if (!canAdd) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { planType: true, unitLimit: true }
      });

      const currentCount = await getUnitCount(userId);
      const plan = getPlan(user?.planType as PlanType || 'free');

      logger.warn({ userId, planType: user?.planType, currentCount, limit: plan.unitLimit }, 'Unit limit reached - request blocked');

      res.status(403).json({
        error: 'Unit limit reached',
        message: `You have reached your plan limit of ${plan.unitLimit} units. Please upgrade your plan to add more.`,
        currentCount,
        limit: plan.unitLimit,
        planType: user?.planType,
        upgradeRequired: true
      });
      return;
    }

    logger.info({ userId }, 'Unit limit check passed');
    next();
  } catch (error) {
    logger.error({ error }, 'Error checking unit limit');
    res.status(500).json({ error: 'Failed to verify unit limit' });
  }
}

/**
 * Middleware to require an active subscription
 * Blocks access if subscription is canceled, past_due, or expired
 */
export async function requireActiveSubscription(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const isActive = isSubscriptionActive(user);

    if (!isActive) {
      logger.warn({ userId, subscriptionStatus: user.subscriptionStatus, planType: user.planType }, 'Inactive subscription - request blocked');

      res.status(403).json({
        error: 'Active subscription required',
        message: 'This feature requires an active subscription. Please renew or update your subscription.',
        subscriptionStatus: user.subscriptionStatus,
        subscriptionRequired: true
      });
      return;
    }

    logger.info({ userId, planType: user.planType }, 'Active subscription check passed');
    next();
  } catch (error) {
    logger.error({ error }, 'Error checking subscription status');
    res.status(500).json({ error: 'Failed to verify subscription status' });
  }
}

/**
 * Middleware factory to require a specific plan or higher
 * Usage: requirePlan('growth') - requires growth or professional plan
 */
export function requirePlan(minimumPlan: PlanType) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { planType: true }
      });

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const currentPlan = getPlan(user.planType as PlanType);
      const requiredPlan = getPlan(minimumPlan);

      // Compare plan tiers (higher price = higher tier)
      if (currentPlan.price < requiredPlan.price) {
        res.status(403).json({
          error: 'Plan upgrade required',
          message: `This feature requires the ${requiredPlan.name} plan or higher. You are currently on the ${currentPlan.name} plan.`,
          currentPlan: user.planType,
          requiredPlan: minimumPlan,
          upgradeRequired: true
        });
        return;
      }

      next();
    } catch (error) {
      logger.error({ error }, 'Error checking plan requirement');
      res.status(500).json({ error: 'Failed to verify plan requirement' });
    }
  };
}

/**
 * Middleware to check if user has any paid subscription (not free tier)
 */
export async function requirePaidPlan(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { planType: true }
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (user.planType === 'free') {
      logger.warn({ userId }, 'Free tier user attempted to access paid feature - request blocked');

      res.status(403).json({
        error: 'Paid plan required',
        message: 'This feature is only available on paid plans. Please upgrade to access this feature.',
        currentPlan: 'free',
        upgradeRequired: true
      });
      return;
    }

    logger.info({ userId, planType: user.planType }, 'Paid plan check passed');
    next();
  } catch (error) {
    logger.error({ error }, 'Error checking paid plan requirement');
    res.status(500).json({ error: 'Failed to verify plan requirement' });
  }
}
