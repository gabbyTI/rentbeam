import Stripe from 'stripe';
import { BadRequestError } from '../lib/errors.js';

// Lazy-load Stripe client
let stripeClient: Stripe | null = null;

function getStripeClient(): Stripe {
  if (!stripeClient) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is required');
    }
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2025-12-15.clover',
    });
  }
  return stripeClient;
}

export interface CreateConnectedAccountParams {
  email: string;
  country?: string;
}

export interface CreateAccountLinkParams {
  accountId: string;
  refreshUrl: string;
  returnUrl: string;
}

class StripeService {
  /**
   * Create an Express connected account
   */
  async createConnectedAccount(params: CreateConnectedAccountParams): Promise<Stripe.Account> {
    const { email, country = 'US' } = params;

    try {
      const account = await getStripeClient().accounts.create({
        type: 'express',
        country,
        email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });

      return account;
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        throw new BadRequestError(`Stripe error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Create an account link for onboarding
   */
  async createAccountLink(params: CreateAccountLinkParams): Promise<Stripe.AccountLink> {
    const { accountId, refreshUrl, returnUrl } = params;

    try {
      const accountLink = await getStripeClient().accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding',
      });

      return accountLink;
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        throw new BadRequestError(`Stripe error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Retrieve account details
   */
  async getAccount(accountId: string): Promise<Stripe.Account> {
    try {
      const account = await getStripeClient().accounts.retrieve(accountId);
      return account;
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        throw new BadRequestError(`Stripe error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Check if account has completed onboarding
   */
  async isAccountOnboarded(accountId: string): Promise<{
    onboarded: boolean;
    chargesEnabled: boolean;
    detailsSubmitted: boolean;
    payoutsEnabled: boolean;
  }> {
    const account = await this.getAccount(accountId);

    return {
      onboarded: account.charges_enabled && account.details_submitted,
      chargesEnabled: account.charges_enabled,
      detailsSubmitted: account.details_submitted,
      payoutsEnabled: account.payouts_enabled || false,
    };
  }

  /**
   * Create a login link for the Express Dashboard
   */
  async createLoginLink(accountId: string): Promise<Stripe.LoginLink> {
    try {
      const loginLink = await getStripeClient().accounts.createLoginLink(accountId);
      return loginLink;
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        throw new BadRequestError(`Stripe error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Calculate processing fee for tenant payment
   */
  calculateProcessingFee(rentAmount: number): {
    rentAmount: number;
    processingFee: number;
    totalAmount: number;
  } {
    const percentageFee = rentAmount * 0.029; // 2.9%
    const fixedFee = 0.30;
    const processingFee = percentageFee + fixedFee;
    const totalAmount = rentAmount + processingFee;

    return {
      rentAmount,
      processingFee: Math.round(processingFee * 100) / 100, // Round to 2 decimals
      totalAmount: Math.round(totalAmount * 100) / 100,
    };
  }

  /**
   * Create a Stripe Customer for a tenant
   */
  async createCustomer(params: {
    email: string;
    name: string;
  }): Promise<Stripe.Customer> {
    try {
      const customer = await getStripeClient().customers.create({
        email: params.email,
        name: params.name,
      });
      return customer;
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        throw new BadRequestError(`Stripe error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Create a SetupIntent to save payment method
   */
  async createSetupIntent(customerId: string): Promise<Stripe.SetupIntent> {
    try {
      const setupIntent = await getStripeClient().setupIntents.create({
        customer: customerId,
        payment_method_types: ['card'],
      });
      return setupIntent;
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        throw new BadRequestError(`Stripe error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Create a PaymentIntent to charge saved payment method
   */
  async createPaymentIntent(params: {
    amount: number; // Amount in cents or dollars based on context
    currency?: string;
    customerId: string;
    paymentMethodId: string;
    metadata?: Record<string, string>;
    confirm?: boolean;
    offSession?: boolean;
  }): Promise<Stripe.PaymentIntent> {
    try {
      const paymentIntent = await getStripeClient().paymentIntents.create({
        amount: params.amount, // Caller should provide cents
        currency: params.currency || 'usd',
        customer: params.customerId,
        payment_method: params.paymentMethodId,
        off_session: params.offSession !== undefined ? params.offSession : true,
        confirm: params.confirm !== undefined ? params.confirm : true,
        metadata: params.metadata || {},
      });
      return paymentIntent;
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        throw new BadRequestError(`Stripe error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Get payment method details
   */
  async getPaymentMethod(paymentMethodId: string): Promise<Stripe.PaymentMethod> {
    try {
      const paymentMethod = await getStripeClient().paymentMethods.retrieve(paymentMethodId);
      return paymentMethod;
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        throw new BadRequestError(`Stripe error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Detach payment method from customer
   */
  async detachPaymentMethod(paymentMethodId: string): Promise<Stripe.PaymentMethod> {
    try {
      const paymentMethod = await getStripeClient().paymentMethods.detach(paymentMethodId);
      return paymentMethod;
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        throw new BadRequestError(`Stripe error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Construct webhook event from raw body and signature
   */
  constructWebhookEvent(
    payload: string | Buffer,
    signature: string,
    webhookSecret: string
  ): Stripe.Event {
    try {
      return getStripeClient().webhooks.constructEvent(payload, signature, webhookSecret);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        throw new BadRequestError(`Webhook signature verification failed: ${error.message}`);
      }
      throw error;
    }
  }
}

export const stripeService = new StripeService();
