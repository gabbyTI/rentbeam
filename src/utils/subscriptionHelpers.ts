import { User } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { getPlan, getRecommendedPlan } from '../config/plans.js';
import { PlanType } from '../config/stripe.js';

/**
 * Check if a user's subscription is currently active
 */
export function isSubscriptionActive(user: User): boolean {
  // Free plan is always "active"
  if (user.planType === 'free') {
    return true;
  }

  // Check subscription status
  const activeStatuses = ['active', 'trialing'];
  return activeStatuses.includes(user.subscriptionStatus || '');
}

/**
 * Check if a user's subscription is in grace period (past_due but not canceled yet)
 */
export function isInGracePeriod(user: User): boolean {
  return user.subscriptionStatus === 'past_due';
}

/**
 * Check if a user can add more units based on their plan limit
 */
export async function canAddUnit(userId: string): Promise<{ allowed: boolean; reason?: string; currentCount: number; limit: number }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      landlordAccount: {
        include: {
          properties: {
            include: {
              units: true
            }
          }
        }
      }
    }
  });

  if (!user || !user.landlordAccount) {
    return { allowed: false, reason: 'User or landlord account not found', currentCount: 0, limit: 0 };
  }

  const currentUnitCount = await getUnitCount(userId);
  const plan = getPlan(user.planType as PlanType);

  if (currentUnitCount >= plan.unitLimit) {
    return {
      allowed: false,
      reason: `You've reached your plan limit of ${plan.unitLimit} units. Upgrade to add more.`,
      currentCount: currentUnitCount,
      limit: plan.unitLimit
    };
  }

  return {
    allowed: true,
    currentCount: currentUnitCount,
    limit: plan.unitLimit
  };
}

/**
 * Get the total number of units for a landlord
 */
export async function getUnitCount(userId: string): Promise<number> {
  const count = await prisma.unit.count({
    where: {
      property: {
        landlord: {
          userId: userId
        }
      }
    }
  });

  return count;
}

/**
 * Get unit count by landlord account ID
 */
export async function getUnitCountByLandlordId(landlordId: string): Promise<number> {
  const count = await prisma.unit.count({
    where: {
      property: {
        landlordId: landlordId
      }
    }
  });

  return count;
}

/**
 * Determine which plan a user should upgrade to based on their current unit count
 */
export async function getSuggestedPlanForUser(userId: string): Promise<PlanType> {
  const unitCount = await getUnitCount(userId);
  return getRecommendedPlan(unitCount);
}

/**
 * Generate an upgrade required message
 */
export function getUpgradeRequiredMessage(currentUnits: number, planLimit: number): string {
  return `You have ${currentUnits} units but your current plan allows ${planLimit}. Please upgrade your plan or remove some units.`;
}

/**
 * Check if a user needs to upgrade based on their unit count
 */
export async function shouldUpgrade(userId: string): Promise<{ shouldUpgrade: boolean; suggestedPlan?: PlanType }> {
  const user = await prisma.user.findUnique({
    where: { id: userId }
  });

  if (!user) {
    return { shouldUpgrade: false };
  }

  const currentUnitCount = await getUnitCount(userId);
  const currentPlan = getPlan(user.planType as PlanType);

  if (currentUnitCount > currentPlan.unitLimit) {
    const suggestedPlan = getRecommendedPlan(currentUnitCount);
    return {
      shouldUpgrade: true,
      suggestedPlan
    };
  }

  return { shouldUpgrade: false };
}

/**
 * Get subscription details for a user in a formatted way
 */
export async function getSubscriptionDetails(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId }
  });

  if (!user) {
    return null;
  }

  const plan = getPlan(user.planType as PlanType);
  const currentUnitCount = await getUnitCount(userId);
  const isActive = isSubscriptionActive(user);
  const gracePeriod = isInGracePeriod(user);

  return {
    planType: user.planType,
    planName: plan.name,
    price: plan.price,
    unitLimit: plan.unitLimit,
    currentUnitCount,
    unitsRemaining: Math.max(0, plan.unitLimit - currentUnitCount),
    subscriptionStatus: user.subscriptionStatus,
    isActive,
    isInGracePeriod: gracePeriod,
    currentPeriodEnd: user.currentPeriodEnd,
    cancelAtPeriodEnd: user.cancelAtPeriodEnd,
    stripeCustomerId: user.stripeCustomerId,
    stripeSubscriptionId: user.stripeSubscriptionId
  };
}

/**
 * Check if downgrade would exceed new plan's unit limit
 */
export async function canDowngradeToPlain(userId: string, targetPlan: PlanType): Promise<{ allowed: boolean; reason?: string }> {
  const currentUnitCount = await getUnitCount(userId);
  const targetPlanConfig = getPlan(targetPlan);

  if (currentUnitCount > targetPlanConfig.unitLimit) {
    return {
      allowed: false,
      reason: `You have ${currentUnitCount} units, but the ${targetPlanConfig.name} plan only allows ${targetPlanConfig.unitLimit}. Please remove ${currentUnitCount - targetPlanConfig.unitLimit} unit(s) before downgrading.`
    };
  }

  return { allowed: true };
}

/**
 * Calculate days until subscription ends
 */
export function getDaysUntilPeriodEnd(user: User): number | null {
  if (!user.currentPeriodEnd) {
    return null;
  }

  const now = new Date();
  const periodEnd = new Date(user.currentPeriodEnd);
  const diffTime = periodEnd.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  return diffDays;
}

/**
 * Check if user is on free plan
 */
export function isFreePlan(user: User): boolean {
  return user.planType === 'free';
}

/**
 * Check if user has a paid subscription
 */
export function hasPaidSubscription(user: User): boolean {
  return !isFreePlan(user) && isSubscriptionActive(user);
}
