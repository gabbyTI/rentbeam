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
}

export const stripeService = new StripeService();
