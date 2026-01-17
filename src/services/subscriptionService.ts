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

    // Create subscription
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

    // Save subscription ID to user so webhooks can find them
    // Do NOT update planType or unitLimit yet - let webhook handle it after payment
    await prisma.user.update({
      where: { id: userId },
      data: {
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
      }
    });

    // Log to subscription history
    await prisma.subscriptionHistory.create({
      data: {
        userId: userId,
        eventType: 'created',
        fromPlan: user.planType,
        toPlan: planType,
        stripeObjectId: subscription.id,
      }
    });

    return subscription;
  } catch (error) {
    logger.error({ error }, 'Error creating subscription');
    throw error;
  }
}

/**
 * Upgrade a user's subscription to a higher tier
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

    // Check if there's a scheduled downgrade and log its cancellation
    if (subscription.metadata?.scheduledDowngrade) {
      logger.info({ 
        userId,
        scheduledPlan: subscription.metadata.scheduledDowngrade,
        newPlan: newPlanType
      }, 'Clearing scheduled downgrade due to upgrade');
      
      await prisma.subscriptionHistory.create({
        data: {
          userId: userId,
          eventType: 'downgrade_cancelled',
          fromPlan: user.planType,
          toPlan: subscription.metadata.scheduledDowngrade as PlanType,
          stripeObjectId: subscription.id,
          metadata: { reason: 'user_upgraded' }
        }
      });
    }

    // Update subscription (prorate by default)
    const updatedSubscription = await stripe.subscriptions.update(subscription.id, {
      items: [{
        id: subscription.items.data[0].id,
        price: newPriceId,
      }],
      proration_behavior: 'create_prorations',
      metadata: {
        ...subscription.metadata,
        planType: newPlanType,
        scheduledDowngrade: null,
        scheduledPriceId: null,
      }
    });

    // Update database
    await updateUserSubscription(userId, updatedSubscription);

    // Log to history
    await prisma.subscriptionHistory.create({
      data: {
        userId: userId,
        eventType: 'upgraded',
        fromPlan: user.planType,
        toPlan: newPlanType,
        stripeObjectId: updatedSubscription.id,
      }
    });

    return updatedSubscription;
  } catch (error) {
    logger.error({ error }, 'Error upgrading subscription');
    throw error;
  }
}

/**
 * Downgrade a user's subscription (scheduled for end of period)
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

    // Schedule downgrade at period end by storing in subscription metadata
    const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    
    const updatedSubscription = await stripe.subscriptions.update(subscription.id, {
      metadata: {
        ...subscription.metadata,
        scheduledDowngrade: newPlanType,
        scheduledPriceId: newPriceId,
      }
    });

    // Log to history
    const effectiveDate = subscription.items.data[0].current_period_end 
      ? new Date(subscription.items.data[0].current_period_end * 1000).toISOString()
      : 'unknown';
      
    await prisma.subscriptionHistory.create({
      data: {
        userId: userId,
        eventType: 'downgrade_scheduled',
        fromPlan: user.planType,
        toPlan: newPlanType,
        stripeObjectId: updatedSubscription.id,
        metadata: { scheduledFor: 'end_of_period', effectiveDate }
      }
    });

    return updatedSubscription;
  } catch (error) {
    logger.error({ error }, 'Error downgrading subscription');
    throw error;
  }
}

/**
 * Cancel a subscription (at end of period)
 */
export async function cancelSubscription(subscriptionId: string, immediately: boolean = false): Promise<Stripe.Subscription> {
  try {
    // Retrieve subscription to check for scheduled downgrade
    const existingSub = await stripe.subscriptions.retrieve(subscriptionId);
    
    // Log if cancelling a scheduled downgrade
    if (existingSub.metadata?.scheduledDowngrade) {
      const user = await prisma.user.findFirst({
        where: { stripeSubscriptionId: subscriptionId }
      });
      
      if (user) {
        logger.info({ 
          subscriptionId,
          scheduledPlan: existingSub.metadata.scheduledDowngrade
        }, 'Clearing scheduled downgrade due to cancellation');
        
        await prisma.subscriptionHistory.create({
          data: {
            userId: user.id,
            eventType: 'downgrade_cancelled',
            fromPlan: user.planType,
            toPlan: existingSub.metadata.scheduledDowngrade as PlanType,
            stripeObjectId: subscriptionId,
            metadata: { reason: 'user_cancelled_subscription' }
          }
        });
      }
    }
    
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: !immediately,
      metadata: {
        ...existingSub.metadata,
        scheduledDowngrade: null,
        scheduledPriceId: null,
      }
    });

    if (immediately) {
      await stripe.subscriptions.cancel(subscriptionId);
    }

    // Update user
    const user = await prisma.user.findFirst({
      where: { stripeSubscriptionId: subscriptionId }
    });

    if (user) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          cancelAtPeriodEnd: !immediately,
          subscriptionStatus: immediately ? 'canceled' : subscription.status,
        }
      });

      // Log to history
      await prisma.subscriptionHistory.create({
        data: {
          userId: user.id,
          eventType: 'canceled',
          fromPlan: user.planType,
          toPlan: immediately ? 'free' : user.planType,
          stripeObjectId: subscriptionId,
          metadata: { immediately }
        }
      });
    }

    return subscription;
  } catch (error) {
    logger.error({ error }, 'Error canceling subscription');
    throw error;
  }
}

/**
 * Reactivate a canceled subscription (undo cancel_at_period_end)
 */
export async function reactivateSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
  try {
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    });

    // Update user
    const user = await prisma.user.findFirst({
      where: { stripeSubscriptionId: subscriptionId }
    });

    if (user) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          cancelAtPeriodEnd: false,
        }
      });

      // Log to history
      await prisma.subscriptionHistory.create({
        data: {
          userId: user.id,
          eventType: 'reactivated',
          fromPlan: user.planType,
          toPlan: user.planType,
          stripeObjectId: subscriptionId,
        }
      });
    }

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
 * Update user subscription data in database from Stripe subscription object
 */
export async function updateUserSubscription(userId: string, subscription: Stripe.Subscription): Promise<void> {
  try {
    // Determine plan type from metadata or price ID
    let planType: PlanType = 'free';
    
    if (subscription.metadata?.planType) {
      planType = subscription.metadata.planType as PlanType;
    } else {
      const priceId = subscription.items.data[0]?.price.id;
      if (priceId === STRIPE_PRICE_IDS.starter) planType = 'starter';
      else if (priceId === STRIPE_PRICE_IDS.growth) planType = 'growth';
      else if (priceId === STRIPE_PRICE_IDS.professional) planType = 'professional';
    }

    const plan = getPlan(planType);

    // Only grant benefits if subscription is active/trialing/past_due
    // Do NOT grant benefits for incomplete (unpaid) subscriptions
    const shouldGrantBenefits = ['active', 'trialing', 'past_due'].includes(subscription.status);

    if (shouldGrantBenefits) {
      // Full update with benefits
      await prisma.user.update({
        where: { id: userId },
        data: {
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
          planType: planType,
          unitLimit: plan.limits.units,
          currentPeriodStart: new Date(subscription.items.data[0].current_period_start * 1000),
          currentPeriodEnd: new Date(subscription.items.data[0].current_period_end * 1000),
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        }
      });
    } else {
      // Only update subscription ID and status, keep user on free plan
      await prisma.user.update({
        where: { id: userId },
        data: {
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        }
      });
    }
  } catch (error) {
    logger.error({ error }, 'Error updating user subscription');
    throw error;
  }
}

/**
 * Sync subscription status from Stripe (for manual refresh)
 */
export async function syncSubscriptionStatus(subscriptionId: string): Promise<void> {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    
    // Try to find user by subscription ID first
    let user = await prisma.user.findFirst({
      where: { stripeSubscriptionId: subscriptionId }
    });

    // If not found (race condition - webhook arrived before we saved subscription ID),
    // try finding by customer ID
    if (!user && typeof subscription.customer === 'string') {
      user = await prisma.user.findFirst({
        where: { stripeCustomerId: subscription.customer }
      });
      
      // If we found the user by customer ID, this is a race condition scenario
      // The subscription creation is still in progress, so just skip this webhook
      // The app will handle the subscription setup after creation completes
      if (user) {
        logger.warn({ 
          subscriptionId, 
          customerId: subscription.customer,
          userId: user.id 
        }, 'Race condition detected: webhook arrived before subscription ID saved. Skipping sync.');
        return;
      }
    }

    if (!user) {
      throw new Error('User not found for subscription');
    }

    // Check if there's a scheduled downgrade to apply
    if (subscription.metadata?.scheduledDowngrade && subscription.metadata?.scheduledPriceId) {
      const currentPeriodStart = new Date((subscription as any).current_period_start * 1000);
      const lastKnownPeriodStart = user.currentPeriodStart;

      // If period just renewed (new period start), apply the scheduled downgrade
      if (!lastKnownPeriodStart || currentPeriodStart > lastKnownPeriodStart) {
        const scheduledPlan = subscription.metadata.scheduledDowngrade as PlanType;
        
        logger.info({ subscriptionId, scheduledPlan }, 'Applying scheduled downgrade at period renewal');
        
        // Re-validate unit count before applying downgrade
        const currentUnitCount = await getUnitCount(user.id);
        const targetPlan = getPlan(scheduledPlan);
        
        if (currentUnitCount > targetPlan.limits.units) {
          // User has too many units - block the downgrade
          logger.warn({ 
            subscriptionId, 
            scheduledPlan, 
            currentUnitCount, 
            targetLimit: targetPlan.limits.units,
            userId: user.id
          }, 'Scheduled downgrade blocked - user has too many units');
          
          // Clear the scheduled downgrade
          await stripe.subscriptions.update(subscriptionId, {
            metadata: {
              ...subscription.metadata,
              scheduledDowngrade: null,
              scheduledPriceId: null,
            },
          });
          
          // Log blocked event
          await prisma.subscriptionHistory.create({
            data: {
              userId: user.id,
              eventType: 'downgrade_blocked',
              fromPlan: user.planType,
              toPlan: scheduledPlan,
              stripeObjectId: subscriptionId,
              metadata: { 
                reason: 'too_many_units',
                currentUnits: currentUnitCount,
                targetLimit: targetPlan.limits.units
              }
            }
          });
          
          // TODO: Send email notification to user
          logger.info({ userId: user.id }, 'TODO: Send email about blocked downgrade');
          
          return;
        }
        
        // Apply the downgrade
        await stripe.subscriptions.update(subscriptionId, {
          items: [{
            id: subscription.items.data[0].id,
            price: subscription.metadata.scheduledPriceId,
          }],
          metadata: {
            ...subscription.metadata,
            planType: subscription.metadata.scheduledDowngrade,
            scheduledDowngrade: null,
            scheduledPriceId: null,
          },
          proration_behavior: 'none',
        });

        // Retrieve updated subscription
        const updatedSub = await stripe.subscriptions.retrieve(subscriptionId);
        await updateUserSubscription(user.id, updatedSub);

        // Log completion
        await prisma.subscriptionHistory.create({
          data: {
            userId: user.id,
            eventType: 'downgraded',
            fromPlan: user.planType,
            toPlan: scheduledPlan,
            stripeObjectId: subscriptionId,
          }
        });
        return;
      }
    }

    await updateUserSubscription(user.id, subscription);
  } catch (error) {
    logger.error({ error }, 'Error syncing subscription status');
    throw error;
  }
}

/**
 * Handle subscription deletion (downgrade to free)
 */
export async function handleSubscriptionDeleted(subscriptionId: string): Promise<void> {
  try {
    const user = await prisma.user.findFirst({
      where: { stripeSubscriptionId: subscriptionId }
    });

    if (!user) {
      return;
    }

    // Downgrade to free tier
    await prisma.user.update({
      where: { id: user.id },
      data: {
        stripeSubscriptionId: null,
        subscriptionStatus: 'canceled',
        planType: 'free',
        unitLimit: 3,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      }
    });

    // Log to history
    await prisma.subscriptionHistory.create({
      data: {
        userId: user.id,
        eventType: 'canceled',
        fromPlan: user.planType,
        toPlan: 'free',
        stripeObjectId: subscriptionId,
      }
    });
  } catch (error) {
    console.error('Error handling subscription deletion:', error);
    throw error;
  }
}
