import { STRIPE_PRICE_IDS, PlanType } from './stripe';

/**
 * Plan Configuration
 * Define features, limits, and pricing for each subscription tier
 */

export interface PlanConfig {
  id: PlanType;
  name: string;
  price: number; // Monthly price in dollars
  stripePriceId: string | null; // Stripe Price ID (null for free)
  features: string[];
  limits: {
    units: number; // Maximum units allowed
    properties: number; // -1 = unlimited
    users: number; // Multi-user access
    supportLevel: 'community' | 'priority' | 'dedicated';
    features: {
      autopay: boolean;
      manualPayments: boolean;
      emailReminders: boolean;
      smsReminders: boolean;
      dataExport: boolean;
      advancedReporting: boolean;
      customReminderTemplates: boolean;
      brandedInvites: boolean;
      apiAccess: boolean;
      whiteLabel: boolean;
    };
    rateLimit?: {
      emailsPerMonth: number;
      smsPerMonth: number;
    };
  };
}

export const PLANS: Record<PlanType, PlanConfig> = {
  free: {
    id: 'free',
    name: 'Free Forever',
    price: 0,
    stripePriceId: null,
    features: [
      'Automated Rent Collection',
      'Real-Time Dashboard',
      'Email Reminders',
      'Secure Card Payments',
      'Community Support',
    ],
    limits: {
      units: 3,
      properties: -1, // Unlimited properties
      users: 1,
      supportLevel: 'community',
      features: {
        autopay: false,
        manualPayments: true,
        emailReminders: true,
        smsReminders: false,
        dataExport: false,
        advancedReporting: false,
        customReminderTemplates: false,
        brandedInvites: false,
        apiAccess: false,
        whiteLabel: false,
      },
      rateLimit: {
        emailsPerMonth: 1000,
        smsPerMonth: 0,
      },
    },
  },
  
  starter: {
    id: 'starter',
    name: 'Starter',
    price: 29,
    stripePriceId: STRIPE_PRICE_IDS.starter,
    features: [
      'Everything in Free',
      'Autopay',
      'SMS Reminders',
      'Priority Support',
      'Payment History Export',
      'Advanced Reporting',
    ],
    limits: {
      units: 10,
      properties: -1,
      users: 1,
      supportLevel: 'priority',
      features: {
        autopay: true,
        manualPayments: true,
        emailReminders: true,
        smsReminders: true,
        dataExport: true,
        advancedReporting: true,
        customReminderTemplates: false,
        brandedInvites: false,
        apiAccess: false,
        whiteLabel: false,
      },
      rateLimit: {
        emailsPerMonth: 5000,
        smsPerMonth: 500,
      },
    },
  },
  
  growth: {
    id: 'growth',
    name: 'Growth',
    price: 79,
    stripePriceId: STRIPE_PRICE_IDS.growth,
    features: [
      'Everything in Starter',
      'Multi-User Access',
      'Branded Tenant Invites',
      'Custom Reminders',
      'Dedicated Support',
    ],
    limits: {
      units: 50,
      properties: -1,
      users: 5,
      supportLevel: 'dedicated',
      features: {
        autopay: true,
        manualPayments: true,
        emailReminders: true,
        smsReminders: true,
        dataExport: true,
        advancedReporting: true,
        customReminderTemplates: true,
        brandedInvites: true,
        apiAccess: false,
        whiteLabel: false,
      },
      rateLimit: {
        emailsPerMonth: 20000,
        smsPerMonth: 2000,
      },
    },
  },
  
  professional: {
    id: 'professional',
    name: 'Professional',
    price: 149,
    stripePriceId: STRIPE_PRICE_IDS.professional,
    features: [
      'Everything in Growth',
      'White-Label Options',
      'API Access',
      'Custom Integrations',
      'Account Manager',
    ],
    limits: {
      units: 100,
      properties: -1,
      users: -1, // Unlimited
      supportLevel: 'dedicated',
      features: {
        autopay: true,
        manualPayments: true,
        emailReminders: true,
        smsReminders: true,
        dataExport: true,
        advancedReporting: true,
        customReminderTemplates: true,
        brandedInvites: true,
        apiAccess: true,
        whiteLabel: true,
      },
      rateLimit: {
        emailsPerMonth: -1, // Unlimited
        smsPerMonth: -1, // Unlimited
      },
    },
  },
};

/**
 * Get plan configuration by plan type
 */
export function getPlan(planType: PlanType): PlanConfig {
  return PLANS[planType];
}

/**
 * Get all available plans
 */
export function getAllPlans(): PlanConfig[] {
  return Object.values(PLANS);
}

/**
 * Get paid plans only (exclude free)
 */
export function getPaidPlans(): PlanConfig[] {
  return Object.values(PLANS).filter(plan => plan.price > 0);
}

/**
 * Determine which plan a user should be on based on unit count
 */
export function getRecommendedPlan(unitCount: number): PlanType {
  if (unitCount <= 3) return 'free';
  if (unitCount <= 10) return 'starter';
  if (unitCount <= 50) return 'growth';
  return 'professional';
}

/**
 * Check if a plan upgrade is valid
 */
export function canUpgradeToPlan(currentPlan: PlanType, targetPlan: PlanType, currentUnitCount: number): boolean {
  const target = getPlan(targetPlan);
  
  // Check if target plan can accommodate current units
  if (currentUnitCount > target.limits.units) {
    return false;
  }
  
  return true;
}

/**
 * Check if a plan downgrade is valid
 */
export function canDowngradeToPlan(currentPlan: PlanType, targetPlan: PlanType, currentUnitCount: number): boolean {
  const target = getPlan(targetPlan);
  
  // Check if target plan can accommodate current units
  if (currentUnitCount > target.limits.units) {
    return false;
  }
  
  // Can't "downgrade" to a higher tier
  const currentPrice = getPlan(currentPlan).price;
  const targetPrice = target.price;
  
  if (targetPrice >= currentPrice) {
    return false;
  }
  
  return true;
}

/**
 * Check if a plan has a specific feature enabled
 */
export function hasFeature(planType: PlanType, feature: keyof PlanConfig['limits']['features']): boolean {
  const plan = getPlan(planType);
  return plan.limits.features[feature];
}

/**
 * Get the rate limit for a specific resource
 */
export function getRateLimit(planType: PlanType, resource: 'emails' | 'sms'): number {
  const plan = getPlan(planType);
  if (!plan.limits.rateLimit) {
    return -1; // Unlimited
  }
  return resource === 'emails' ? plan.limits.rateLimit.emailsPerMonth : plan.limits.rateLimit.smsPerMonth;
}
