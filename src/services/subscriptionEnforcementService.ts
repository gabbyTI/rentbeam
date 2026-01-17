import prisma from '../lib/prisma.js';
import { PlanType } from '../config/stripe.js';
import { getUnitCount } from '../utils/subscriptionHelpers.js';
import { getPlan } from '../config/plans.js';
import logger from '../lib/logger.js';

/**
 * Service for enforcing subscription limits and restrictions
 * Centralized business logic for subscription-based feature access
 */

export interface EnforcementResult {
  allowed: boolean;
  reason?: string;
}

export interface EnforcementState {
  isOverLimit: boolean;
  unitCount: number;
  unitLimit: number;
  overLimitBy: number;
  restrictions: string[];
}

class SubscriptionEnforcementService {
  /**
   * Check if user can collect payments (manual or autopay)
   * Blocked when user has more units than their plan allows
   */
  async canCollectPayment(userId: string): Promise<EnforcementResult> {
    try {
      const state = await this.getEnforcementState(userId);
      
      if (state.isOverLimit) {
        return {
          allowed: false,
          reason: `You have ${state.unitCount} units but your plan allows ${state.unitLimit}. Upgrade to resume payment collection.`
        };
      }

      return { allowed: true };
    } catch (error) {
      logger.error({ error, userId }, 'Error checking payment collection permission');
      // Fail open - allow on error to avoid blocking legitimate users
      return { allowed: true };
    }
  }

  /**
   * Check if user can add a new unit
   * Blocked when user is at or over their plan limit
   */
  async canAddUnit(userId: string): Promise<EnforcementResult> {
    try {
      const state = await this.getEnforcementState(userId);
      
      if (state.unitCount >= state.unitLimit) {
        return {
          allowed: false,
          reason: `You have reached your plan limit of ${state.unitLimit} units. Upgrade to add more.`
        };
      }

      return { allowed: true };
    } catch (error) {
      logger.error({ error, userId }, 'Error checking unit addition permission');
      // Fail closed - block on error to prevent over-limit
      return { 
        allowed: false, 
        reason: 'Unable to verify unit limit. Please try again.' 
      };
    }
  }

  /**
   * Get complete enforcement state for a user
   * Returns unit counts, limits, and applicable restrictions
   */
  async getEnforcementState(userId: string): Promise<EnforcementState> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { planType: true }
    });

    if (!user) {
      throw new Error('User not found');
    }

    const plan = getPlan(user.planType as PlanType);
    const unitCount = await getUnitCount(userId);
    const isOverLimit = this.isOverLimit(unitCount, plan.limits.units);
    const overLimitBy = Math.max(0, unitCount - plan.limits.units);

    const restrictions: string[] = [];
    if (isOverLimit) {
      restrictions.push('Cannot add new units or properties');
      restrictions.push('Cannot collect payments (manual or automatic)');
      restrictions.push('Read-only access to existing data');
    }

    return {
      isOverLimit,
      unitCount,
      unitLimit: plan.limits.units,
      overLimitBy,
      restrictions
    };
  }

  /**
   * Simple check if unit count exceeds limit
   */
  private isOverLimit(unitCount: number, limit: number): boolean {
    return unitCount > limit;
  }
}

// Export singleton instance
export const subscriptionEnforcementService = new SubscriptionEnforcementService();
