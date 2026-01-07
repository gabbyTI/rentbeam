/**
 * Prometheus Metrics
 * MVP metrics for monitoring critical business operations
 */
import client from 'prom-client';

// Revenue metrics
export const paymentsTotal = new client.Counter({
  name: 'rentbeam_payments_total',
  help: 'Total number of payments created',
  labelNames: ['method', 'status'],
});

export const paymentsAmountCents = new client.Counter({
  name: 'rentbeam_payments_amount_cents',
  help: 'Total payment amount in cents',
  labelNames: ['method'],
});

// Cron job metrics
export const cronExecutionsTotal = new client.Counter({
  name: 'rentbeam_cron_executions_total',
  help: 'Total cron job executions',
  labelNames: ['job', 'status'],
});

export const cronLastRunTimestamp = new client.Gauge({
  name: 'rentbeam_cron_last_run_timestamp',
  help: 'Timestamp of last successful cron job run',
  labelNames: ['job'],
});

// Business growth metrics
export const activeTenantsGauge = new client.Gauge({
  name: 'rentbeam_active_tenants',
  help: 'Current number of active tenant memberships',
});

export const autopayEnabledGauge = new client.Gauge({
  name: 'rentbeam_autopay_enabled_count',
  help: 'Number of tenants with autopay enabled',
});

export const invitesTotal = new client.Counter({
  name: 'rentbeam_invites_total',
  help: 'Total invites sent or accepted',
  labelNames: ['status'], // sent, accepted
});

// Helper function to update tenant count gauges
export async function updateTenantMetrics(prisma: any) {
  const [activeCount, autopayCount] = await Promise.all([
    prisma.tenantMembership.count({ where: { status: 'ACTIVE' } }),
    prisma.tenantMembership.count({ where: { status: 'ACTIVE', autopayEnabled: true } }),
  ]);

  activeTenantsGauge.set(activeCount);
  autopayEnabledGauge.set(autopayCount);
}
