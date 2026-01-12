/**
 * Stripe Configuration
 * 
 * IMPORTANT: Update these Price IDs after creating products in Stripe Dashboard
 * For now, these are placeholder values for TEST mode
 */

export const STRIPE_PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_ID_STARTER || 'price_starter_placeholder',
  growth: process.env.STRIPE_PRICE_ID_GROWTH || 'price_growth_placeholder',
  professional: process.env.STRIPE_PRICE_ID_PROFESSIONAL || 'price_professional_placeholder',
} as const;

export const STRIPE_CONFIG = {
  secretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  // Add test mode flag for easier debugging
  isTestMode: process.env.STRIPE_SECRET_KEY?.includes('_test_') || false,
} as const;

// Type for valid plan types
export type PlanType = 'free' | 'starter' | 'growth' | 'professional';
