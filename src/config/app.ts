/**
 * Application configuration
 * Single source of truth for app branding and settings
 */
export const APP_CONFIG = {
  name: 'RentBeam',
  domain: 'rentbeam.ca',
  url: 'https://rentbeam.ca',
  email: {
    noreply: 'noreply@rentbeam.ca',
    support: 'support@rentbeam.ca',
  },
  metrics: {
    appLabel: 'rentbeam-api',
  },
} as const;

export type AppConfig = typeof APP_CONFIG;
