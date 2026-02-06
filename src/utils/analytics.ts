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
  const rate = total > 0 ? Math.round((occupied / total) * 100) : 100;

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
  const [year, monthNum] = month.split('-').map(Number);
  const activeTenants = tenants.filter(t => t.status === 'ACTIVE');



  // Calculate expected revenue - sum rent for all active tenants
  const expected = activeTenants.reduce((sum, tenant) => {
    const rentAmount = parseFloat(tenant.unit.rentAmount.toString());


    return sum + rentAmount;
  }, 0);

  // Calculate collected revenue for this month (exclude FAILED payments and inactive tenants)
  const activeTenantIds = new Set(activeTenants.map(t => t.id));
  const monthPayments = payments.filter(p =>
    p.month === month &&
    p.status !== 'FAILED' &&
    activeTenantIds.has(p.tenantMembershipId)
  );



  const collected = monthPayments.reduce((sum, p) =>
    sum + parseFloat(p.amount.toString()), 0
  );



  const rate = expected > 0 ? Math.round((collected / expected) * 100) : 100;

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
    // Only count SUCCEEDED or PROCESSING payments as paid
    const payment = payments.find(p =>
      p.tenantMembershipId === tenant.id &&
      p.month === currentMonth &&
      (p.status === 'SUCCEEDED' || p.status === 'PROCESSING')
    );

    if (!payment) {
      // Check if payment is overdue (past grace period)
      const dueDay = tenant.unit.dueDay;
      const gracePeriodDays = tenant.unit.gracePeriodDays || 0;
      const dueDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), dueDay);
      const graceDueDate = new Date(dueDate);
      graceDueDate.setDate(graceDueDate.getDate() + gracePeriodDays);

      // Check if tenant moved in after payment window opened
      const paymentWindowOpenDate = new Date(dueDate);
      paymentWindowOpenDate.setDate(dueDate.getDate() - 5);
      const moveInDate = new Date(tenant.moveInDate);

      // Only count as outstanding if:
      // 1. Past grace period
      // 2. Tenant moved in before payment window opened
      if (currentDate > graceDueDate && moveInDate <= paymentWindowOpenDate) {
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
    // Only count SUCCEEDED or PROCESSING payments
    const payment = payments.find(p =>
      p.tenantMembershipId === tenant.id &&
      p.month === month &&
      (p.status === 'SUCCEEDED' || p.status === 'PROCESSING')
    );

    if (payment) {
      // Has payment - count it regardless of move-in date
      const dueDay = tenant.unit.dueDay;

      // Parse the payment month to get the correct year and month
      const [paymentYear, paymentMonthNum] = month.split('-').map(Number);
      const dueDate = new Date(paymentYear, paymentMonthNum - 1, dueDay);
      const paymentDate = new Date(payment.date);

      // Compare dates only (ignore time) by comparing date strings
      const dueDateString = dueDate.toISOString().split('T')[0];
      const paymentDateString = paymentDate.toISOString().split('T')[0];



      if (paymentDateString > dueDateString) {
        late++;
      } else {
        paid++;
      }
    } else {
      // No payment - check if tenant should be expected to pay yet
      const dueDay = tenant.unit.dueDay;
      const gracePeriodDays = tenant.unit.gracePeriodDays || 0;
      const dueDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), dueDay);
      const graceDueDate = new Date(dueDate);
      graceDueDate.setDate(graceDueDate.getDate() + gracePeriodDays);

      // Check if tenant moved in after payment window opened
      const paymentWindowOpenDate = new Date(dueDate);
      paymentWindowOpenDate.setDate(dueDate.getDate() - 5);
      const moveInDate = new Date(tenant.moveInDate);

      // If tenant moved in after payment window opened, don't count them as overdue
      if (moveInDate > paymentWindowOpenDate) {
        return; // Skip this tenant - they're not expected to have paid yet
      }

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
    .filter(p => p.status === 'SUCCEEDED' || p.status === 'PROCESSING') // Exclude FAILED payments
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
