import { LedgerEntry, TenantMembership, Unit } from '@prisma/client';

interface TenantWithUnit extends TenantMembership {
  unit: Unit;
}

interface LedgerEntryWithTenant extends LedgerEntry {
  tenantMembership: {
    id: string;
    user: { name: string };
  };
}

interface OccupancyMetrics {
  rate: number;
  occupied: number;
  total: number;
  vacant: number;
}

interface RevenueMetrics {
  collected: number;
  expected: number;
  rate: number;
}

interface OutstandingMetrics {
  amount: number;
  tenantCount: number;
}

interface PaymentStatusMetrics {
  paid: number;
  pending: number;
  late: number;
  unpaid: number;
}

/**
 * Calculate occupancy rate for landlord's units
 */
export const calculateOccupancyRate = (
  units: Unit[],
  tenants: TenantMembership[]
): OccupancyMetrics => {
  const total = units.length;
  const activeTenants = tenants.filter(t => t.status === 'ACTIVE');
  const occupied = activeTenants.length;
  const vacant = total - occupied;
  const rate = total > 0 ? Math.round((occupied / total) * 100) : 100;

  return { rate, occupied, total, vacant };
};

/**
 * Calculate revenue for current month
 */
export const calculateMonthlyRevenue = (
  tenants: TenantWithUnit[],
  ledgerEntries: LedgerEntry[],
  month: string
): RevenueMetrics => {
  const activeTenants = tenants.filter(t => t.status === 'ACTIVE');

  // Calculate expected revenue - sum rent for all active tenants
  const expected = activeTenants.reduce((sum, tenant) => {
    const rentAmount = parseFloat(tenant.unit.rentAmount.toString());
    return sum + rentAmount;
  }, 0);

  // Calculate collected revenue for this month from POSTED ledger payment rows
  const activeTenantIds = new Set(activeTenants.map(t => t.id));
  const monthPayments = ledgerEntries.filter((e) =>
    e.type === 'PAYMENT' &&
    e.status === 'POSTED' &&
    activeTenantIds.has(e.tenantMembershipId) &&
    `${e.effectiveDate.getFullYear()}-${String(e.effectiveDate.getMonth() + 1).padStart(2, '0')}` === month
  );

  const collected = monthPayments.reduce((sum, p) =>
    sum + parseFloat((p.paymentAmount ?? 0).toString()), 0
  );

  const rate = expected > 0 ? Math.round((collected / expected) * 100) : 100;

  return { collected, expected, rate };
};

/**
 * Get total outstanding balance
 */
export const getOutstandingBalance = (
  tenants: TenantWithUnit[],
  ledgerEntries: LedgerEntry[]
): OutstandingMetrics => {
  const activeTenants = tenants.filter(t => t.status === 'ACTIVE');
  const activeTenantIds = new Set(activeTenants.map(t => t.id));

  // Latest POSTED balance per active tenant membership
  const latestBalances = new Map<string, number>();
  const sorted = [...ledgerEntries]
    .filter((e) => e.status === 'POSTED' && activeTenantIds.has(e.tenantMembershipId))
    .sort((a, b) => {
      const byDate = b.effectiveDate.getTime() - a.effectiveDate.getTime();
      if (byDate !== 0) return byDate;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

  for (const entry of sorted) {
    if (!latestBalances.has(entry.tenantMembershipId)) {
      latestBalances.set(entry.tenantMembershipId, parseFloat(entry.balanceAfter.toString()));
    }
  }

  let totalOutstanding = 0;
  let tenantsWithOutstanding = 0;

  for (const tenant of activeTenants) {
    const balance = latestBalances.get(tenant.id) ?? 0;
    if (balance > 0.005) {
      totalOutstanding += balance;
      tenantsWithOutstanding++;
    }
  }

  return {
    amount: Math.round(totalOutstanding * 100) / 100,
    tenantCount: tenantsWithOutstanding
  };
};

/**
 * Get payment status breakdown for current month
 */
export const getPaymentStatusBreakdown = (
  tenants: TenantWithUnit[],
  ledgerEntries: LedgerEntry[],
  month: string
): PaymentStatusMetrics => {
  const currentDate = new Date();
  const activeTenants = tenants.filter(t => t.status === 'ACTIVE');

  let paid = 0;
  let pending = 0;
  let late = 0;
  let unpaid = 0;

  activeTenants.forEach(tenant => {
    const dueDay = tenant.unit.dueDay;
    const gracePeriodDays = tenant.unit.gracePeriodDays || 0;
    const [paymentYear, paymentMonthNum] = month.split('-').map(Number);
    const dueDate = new Date(paymentYear, paymentMonthNum - 1, dueDay);
    const graceDueDate = new Date(dueDate);
    graceDueDate.setDate(graceDueDate.getDate() + gracePeriodDays);

    // Skip tenants who moved in after payment window opened
    const paymentWindowOpenDate = new Date(dueDate);
    paymentWindowOpenDate.setDate(dueDate.getDate() - 5);
    const moveInDate = new Date(tenant.moveInDate);
    if (moveInDate > paymentWindowOpenDate) {
      return;
    }

    const tenantMonthEntries = ledgerEntries.filter((e) =>
      e.status === 'POSTED' &&
      e.tenantMembershipId === tenant.id &&
      `${e.effectiveDate.getFullYear()}-${String(e.effectiveDate.getMonth() + 1).padStart(2, '0')}` === month
    );

    const monthCharges = tenantMonthEntries
      .filter((e) => e.type === 'CHARGE')
      .reduce((sum, e) => sum + parseFloat((e.chargeAmount ?? 0).toString()), 0);

    const monthPayments = tenantMonthEntries
      .filter((e) => e.type === 'PAYMENT' || e.type === 'CREDIT')
      .reduce((sum, e) => sum + parseFloat((e.paymentAmount ?? 0).toString()), 0);

    if (monthCharges > 0 && monthPayments >= monthCharges) {
      const latestPaymentEntry = tenantMonthEntries
        .filter((e) => e.type === 'PAYMENT' || e.type === 'CREDIT')
        .sort((a, b) => b.effectiveDate.getTime() - a.effectiveDate.getTime())[0];

      if (latestPaymentEntry && latestPaymentEntry.effectiveDate > dueDate) {
        late++;
      } else {
        paid++;
      }
      return;
    }

    if (currentDate <= dueDate || currentDate <= graceDueDate) {
      pending++;
    } else {
      unpaid++;
    }
  });

  return { paid, pending, late, unpaid };
};

/**
 * Get recent payment activity
 */
export const getRecentPayments = (
  entries: LedgerEntryWithTenant[],
  limit: number = 10
): Array<{
  id: string;
  tenantName: string;
  amount: number;
  date: string;
  status: 'paid' | 'late';
}> => {
  return entries
    .filter((e) => e.type === 'PAYMENT' && e.status === 'POSTED')
    .sort((a, b) => new Date(b.effectiveDate).getTime() - new Date(a.effectiveDate).getTime())
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      tenantName: e.tenantMembership.user.name,
      amount: parseFloat((e.paymentAmount ?? 0).toString()),
      date: e.effectiveDate.toISOString(),
      status: 'paid' as const // Can enhance later with late detection
    }));
};
