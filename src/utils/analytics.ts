import { TenantMembership, Unit, Payment } from '@prisma/client';

interface TenantWithUnit extends TenantMembership {
  unit: Unit;
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
  const rate = total > 0 ? Math.round((occupied / total) * 100) : 0;

  return { rate, occupied, total, vacant };
};

/**
 * Calculate revenue for current month
 */
export const calculateMonthlyRevenue = (
  tenants: TenantWithUnit[],
  payments: Payment[],
  month: string
): RevenueMetrics => {
  // Calculate expected revenue from active tenants
  const activeTenants = tenants.filter(t => t.status === 'ACTIVE');
  const expected = activeTenants.reduce((sum, t) => 
    sum + parseFloat(t.unit.rentAmount.toString()), 0
  );

  // Calculate collected revenue for this month
  const monthPayments = payments.filter(p => p.month === month);
  const collected = monthPayments.reduce((sum, p) => 
    sum + parseFloat(p.amount.toString()), 0
  );

  const rate = expected > 0 ? Math.round((collected / expected) * 100) : 0;

  return { collected, expected, rate };
};

/**
 * Get total outstanding balance
 */
export const getOutstandingBalance = (
  tenants: TenantWithUnit[],
  payments: Payment[]
): OutstandingMetrics => {
  const currentDate = new Date();
  const currentMonth = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
  
  const activeTenants = tenants.filter(t => t.status === 'ACTIVE');
  
  let totalOutstanding = 0;
  let tenantsWithOutstanding = 0;

  activeTenants.forEach(tenant => {
    const rentAmount = parseFloat(tenant.unit.rentAmount.toString());
    const payment = payments.find(p => 
      p.tenantMembershipId === tenant.id && p.month === currentMonth
    );

    if (!payment) {
      // Check if payment is overdue (past grace period)
      const dueDay = tenant.unit.dueDay;
      const gracePeriodDays = tenant.unit.gracePeriodDays || 0;
      const dueDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), dueDay);
      const graceDueDate = new Date(dueDate);
      graceDueDate.setDate(graceDueDate.getDate() + gracePeriodDays);

      if (currentDate > graceDueDate) {
        totalOutstanding += rentAmount;
        tenantsWithOutstanding++;
      }
    }
  });

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
  payments: Payment[],
  month: string
): PaymentStatusMetrics => {
  const currentDate = new Date();
  const activeTenants = tenants.filter(t => t.status === 'ACTIVE');

  let paid = 0;
  let pending = 0;
  let late = 0;
  let unpaid = 0;

  activeTenants.forEach(tenant => {
    const payment = payments.find(p => 
      p.tenantMembershipId === tenant.id && p.month === month
    );

    if (payment) {
      // Has payment - check if it was late
      const dueDay = tenant.unit.dueDay;
      const dueDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), dueDay);
      const paymentDate = new Date(payment.date);

      if (paymentDate > dueDate) {
        late++;
      } else {
        paid++;
      }
    } else {
      // No payment - check if pending or unpaid
      const dueDay = tenant.unit.dueDay;
      const gracePeriodDays = tenant.unit.gracePeriodDays || 0;
      const dueDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), dueDay);
      const graceDueDate = new Date(dueDate);
      graceDueDate.setDate(graceDueDate.getDate() + gracePeriodDays);

      if (currentDate <= dueDate) {
        pending++; // Not due yet
      } else if (currentDate <= graceDueDate) {
        pending++; // In grace period
      } else {
        unpaid++; // Past grace period
      }
    }
  });

  return { paid, pending, late, unpaid };
};

/**
 * Get recent payment activity
 */
export const getRecentPayments = (
  payments: (Payment & { tenantMembership: { user: { name: string } } })[],
  limit: number = 10
): Array<{
  id: string;
  tenantName: string;
  amount: number;
  date: string;
  status: 'paid' | 'late';
}> => {
  return payments
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit)
    .map(p => ({
      id: p.id,
      tenantName: p.tenantMembership.user.name,
      amount: parseFloat(p.amount.toString()),
      date: p.date.toISOString(),
      status: 'paid' as const // Can enhance later with late detection
    }));
};
