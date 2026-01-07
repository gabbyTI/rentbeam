/**
 * Application configuration
 * Single source of truth for app branding and settings
 */
export const APP_CONFIG = {
  name: 'RentBeam',
  domain: 'rentbeam.app',
  url: 'https://rentbeam.app',
  email: {
    noreply: 'noreply@rentbeam.app',
    support: 'support@rentbeam.app',
  },
  metrics: {
    appLabel: 'rentbeam-api',
  },
} as const;

export type AppConfig = typeof APP_CONFIG;
