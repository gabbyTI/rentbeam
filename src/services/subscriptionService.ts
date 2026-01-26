import Stripe from 'stripe';
import prisma from '../lib/prisma.js';
import { STRIPE_CONFIG, STRIPE_PRICE_IDS, PlanType } from '../config/stripe.js';
import { getPlan } from '../config/plans.js';
import { getUnitCount } from '../utils/subscriptionHelpers.js';
import logger from '../lib/logger.js';

const stripe = new Stripe(STRIPE_CONFIG.secretKey, {
  apiVersion: '2025-12-15.clover',
});

/**
 * Create a Stripe customer for a user
 */
export async function createCustomer(userId: string, email: string): Promise<string> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Check if customer already exists
    if (user.stripeCustomerId) {
      return user.stripeCustomerId;
    }

    // Create Stripe customer
    const customer = await stripe.customers.create({
      email: email,
      name: user.name,
      metadata: {
        userId: userId,
        landlordName: user.businessName || user.name,
      }
    });

    // Save customer ID to database
    await prisma.user.update({
      where: { id: userId },
      data: { stripeCustomerId: customer.id }
    });

    return customer.id;
  } catch (error) {
    logger.error({ error }, 'Error creating Stripe customer');
    throw error;
  }
}

/**
 * Create a subscription for a user
 * Returns the Stripe subscription with latest_invoice expanded
 * Database updates happen via webhook (invoice.paid)
 */
export async function createSubscription(userId: string, priceId: string): Promise<Stripe.Subscription> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Ensure user has a Stripe customer ID
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      customerId = await createCustomer(userId, user.email);
    }

    // Get the plan type from price ID
    let planType: PlanType = 'free';
    if (priceId === STRIPE_PRICE_IDS.starter) planType = 'starter';
    else if (priceId === STRIPE_PRICE_IDS.growth) planType = 'growth';
    else if (priceId === STRIPE_PRICE_IDS.professional) planType = 'professional';

    // Validate unit count against new plan
    const unitCount = await getUnitCount(userId);
    const plan = getPlan(planType);
    
    if (unitCount > plan.limits.units) {
      throw new Error(`You have ${unitCount} units but the ${plan.name} plan only allows ${plan.limits.units} units.`);
    }

    // Create subscription with incomplete status (requires payment)
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      metadata: {
        userId: userId,
        planType: planType
      },
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice'],
    });

    // Save ONLY subscription ID so webhook can find the user
    // Do NOT update planType or unitLimit - webhook handles after payment
    await prisma.user.update({
      where: { id: userId },
      data: {
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status, // 'incomplete'
      }
    });

    logger.info({ userId, planType, subscriptionId: subscription.id }, 'Subscription created - awaiting payment');

    return subscription;
  } catch (error) {
    logger.error({ error }, 'Error creating subscription');
    throw error;
  }
}

/**
 * Upgrade a user's subscription to a higher tier
 * Creates a prorated invoice and requires payment
 * Database updates happen via webhook (invoice.paid)
 */
export async function upgradeSubscription(userId: string, newPriceId: string): Promise<Stripe.Subscription> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || !user.stripeSubscriptionId) {
      throw new Error('User or subscription not found');
    }

    // Get new plan type
    let newPlanType: PlanType = 'free';
    if (newPriceId === STRIPE_PRICE_IDS.starter) newPlanType = 'starter';
    else if (newPriceId === STRIPE_PRICE_IDS.growth) newPlanType = 'growth';
    else if (newPriceId === STRIPE_PRICE_IDS.professional) newPlanType = 'professional';

    // Validate unit count
    const unitCount = await getUnitCount(userId);
    const newPlan = getPlan(newPlanType);
    
    if (unitCount > newPlan.limits.units) {
      throw new Error(`You have ${unitCount} units but the ${newPlan.name} plan only allows ${newPlan.limits.units} units.`);
    }

    // Get current subscription
    const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);

    // Update subscription with proration - creates invoice requiring payment
    const updatedSubscription = await stripe.subscriptions.update(subscription.id, {
      items: [{
        id: subscription.items.data[0].id,
        price: newPriceId,
      }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'default_incomplete',
      metadata: {
        ...subscription.metadata,
        planType: newPlanType,
      },
      expand: ['latest_invoice'],
    });

    logger.info({ 
      userId, 
      fromPlan: user.planType, 
      toPlan: newPlanType, 
      subscriptionId: subscription.id 
    }, 'Upgrade initiated - awaiting payment');

    // NOTE: Database NOT updated here - webhook handles after payment
    return updatedSubscription;
  } catch (error) {
    logger.error({ error }, 'Error upgrading subscription');
    throw error;
  }
}

/**
 * Downgrade a user's subscription (scheduled for end of period)
 * Uses Stripe subscription schedules to change price at renewal
 * Database updates happen via webhook at period end
 */
export async function downgradeSubscription(userId: string, newPriceId: string): Promise<Stripe.Subscription> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || !user.stripeSubscriptionId) {
      throw new Error('User or subscription not found');
    }

    // Get new plan type
    let newPlanType: PlanType = 'free';
    if (newPriceId === STRIPE_PRICE_IDS.starter) newPlanType = 'starter';
    else if (newPriceId === STRIPE_PRICE_IDS.growth) newPlanType = 'growth';
    else if (newPriceId === STRIPE_PRICE_IDS.professional) newPlanType = 'professional';

    // Validate unit count
    const unitCount = await getUnitCount(userId);
    const newPlan = getPlan(newPlanType);
    
    if (unitCount > newPlan.limits.units) {
      throw new Error(`You have ${unitCount} units but the ${newPlan.name} plan only allows ${newPlan.limits.units}. Please remove ${unitCount - newPlan.limits.units} unit(s) before downgrading.`);
    }

    // Get subscription
    const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    
    // Schedule downgrade using subscription schedule
    // This changes the price at the next billing period
    let schedule;
    if (subscription.schedule) {
      // Update existing schedule
      schedule = await stripe.subscriptionSchedules.update(subscription.schedule as string, {
        phases: [
          {
            items: [{ price: subscription.items.data[0].price.id, quantity: 1 }],
            start_date: subscription.items.data[0].current_period_start,
            end_date: subscription.items.data[0].current_period_end,
          },
          {
            items: [{ price: newPriceId, quantity: 1 }],
            start_date: subscription.items.data[0].current_period_end,
          },
        ],
      });
    } else {
      // Create new schedule from subscription
      schedule = await stripe.subscriptionSchedules.create({
        from_subscription: subscription.id,
      });
      
      // Update the schedule with the downgrade
      await stripe.subscriptionSchedules.update(schedule.id, {
        phases: [
          {
            items: [{ price: subscription.items.data[0].price.id, quantity: 1 }],
            start_date: subscription.items.data[0].current_period_start,
            end_date: subscription.items.data[0].current_period_end,
          },
          {
            items: [{ price: newPriceId, quantity: 1 }],
            start_date: subscription.items.data[0].current_period_end,
          },
        ],
      });
    }

    const periodEnd = new Date(subscription.items.data[0].current_period_end * 1000);
    
    logger.info({ 
      userId, 
      fromPlan: user.planType, 
      toPlan: newPlanType, 
      effectiveDate: periodEnd.toISOString()
    }, 'Downgrade scheduled for period end');

    // NOTE: Database NOT updated here - webhook handles at period end
    return subscription;
  } catch (error) {
    logger.error({ error }, 'Error downgrading subscription');
    throw error;
  }
}

/**
 * Cancel a subscription (at end of period or immediately)
 * Database updates happen via webhook
 */
export async function cancelSubscription(subscriptionId: string, immediately: boolean = false): Promise<Stripe.Subscription> {
  try {
    let subscription: Stripe.Subscription;
    
    if (immediately) {
      // Cancel immediately - triggers subscription.deleted webhook
      subscription = await stripe.subscriptions.cancel(subscriptionId);
    } else {
      // Schedule cancellation at period end - triggers subscription.updated webhook
      subscription = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
      });
    }

    logger.info({ 
      subscriptionId, 
      immediately, 
      cancelAtPeriodEnd: subscription.cancel_at_period_end 
    }, 'Subscription cancellation processed');

    // NOTE: Database NOT updated here - webhook handles it
    return subscription;
  } catch (error) {
    logger.error({ error }, 'Error canceling subscription');
    throw error;
  }
}

/**
 * Reactivate a canceled subscription (undo cancel_at_period_end)
 * Database updates happen via webhook
 */
export async function reactivateSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
  try {
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    });

    logger.info({ subscriptionId }, 'Subscription reactivated');

    // NOTE: Database NOT updated here - webhook handles it
    return subscription;
  } catch (error) {
    logger.error({ error }, 'Error reactivating subscription');
    throw error;
  }
}

/**
 * Get Stripe Customer Portal URL for managing subscription
 */
export async function getCustomerPortalUrl(customerId: string, returnUrl: string): Promise<string> {
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    return session.url;
  } catch (error) {
    logger.error({ error }, 'Error creating portal session');
    throw error;
  }
}

/**
 * Cancel an incomplete subscription (cleanup abandoned checkouts)
 * Used when user abandons payment and wants to try again
 */
export async function cancelIncompleteSubscription(subscriptionId: string): Promise<void> {
  try {
    await stripe.subscriptions.cancel(subscriptionId);
    logger.info({ subscriptionId }, 'Incomplete subscription cancelled');
  } catch (error) {
    logger.error({ error, subscriptionId }, 'Error cancelling incomplete subscription');
    throw error;
  }
}

/**
 * Cancel any scheduled downgrade for a subscription
 * Used when user upgrades after scheduling a downgrade
 */
export async function cancelScheduledDowngrade(subscriptionId: string): Promise<void> {
  try {
    // Find schedules associated with this subscription
    const schedules = await stripe.subscriptionSchedules.list({
      customer: (await stripe.subscriptions.retrieve(subscriptionId)).customer as string,
      limit: 10,
    });

    // Find active schedule for this subscription
    const activeSchedule = schedules.data.find(
      s => s.subscription === subscriptionId && ['active', 'not_started'].includes(s.status)
    );

    if (activeSchedule) {
      // Release the schedule (keeps current subscription as-is)
      await stripe.subscriptionSchedules.release(activeSchedule.id);
      logger.info({ scheduleId: activeSchedule.id, subscriptionId }, 'Scheduled downgrade cancelled');
    }
  } catch (error) {
    // Log but don't throw - this is a best-effort cleanup
    logger.warn({ error, subscriptionId }, 'No scheduled downgrade found or error cancelling');
  }
}
