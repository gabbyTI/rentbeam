import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { catchAsync } from '../utils/catchAsync.js';
import { apiResponse } from '../utils/apiResponse.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import {
  calculateOccupancyRate,
  calculateMonthlyRevenue,
  getOutstandingBalance,
  getPaymentStatusBreakdown,
  getRecentPayments,
} from '../utils/analytics.js';

const router = Router();

// PATCH /api/landlord/preferences - Update landlord payment preferences
router.patch('/preferences', authenticate, catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { defaultDueDay, defaultGracePeriodDays, useBusinessName } = req.body;

  // Validation
  if (defaultDueDay !== undefined) {
    const dueDay = parseInt(defaultDueDay);
    if (isNaN(dueDay) || dueDay < 1 || dueDay > 28) {
      throw new ValidationError('Default due day must be between 1 and 28');
    }
  }

  if (defaultGracePeriodDays !== undefined) {
    const graceDays = parseInt(defaultGracePeriodDays);
    if (isNaN(graceDays) || graceDays < 0 || graceDays > 10) {
      throw new ValidationError('Default grace period must be between 0 and 10 days');
    }
  }

  // Find landlord account
  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId }
  });

  if (!landlord) {
    throw new NotFoundError('Landlord account not found');
  }

  // Build update object with only provided fields
  const updateData: any = {};
  if (defaultDueDay !== undefined) updateData.defaultDueDay = parseInt(defaultDueDay);
  if (defaultGracePeriodDays !== undefined) updateData.defaultGracePeriodDays = parseInt(defaultGracePeriodDays);
  if (useBusinessName !== undefined) updateData.useBusinessName = Boolean(useBusinessName);

  // Update landlord preferences
  const updatedLandlord = await prisma.landlordAccount.update({
    where: { id: landlord.id },
    data: updateData,
    select: {
      id: true,
      defaultDueDay: true,
      defaultGracePeriodDays: true,
      useBusinessName: true,
    },
  });

  res.json(apiResponse(updatedLandlord, 'Preferences updated successfully'));
}));

// GET /api/landlord/dashboard/analytics - Get dashboard analytics
router.get('/dashboard/analytics', authenticate, catchAsync(async (req: AuthRequest, res) => {
  const userId = req.user!.id;

  // Find landlord account
  const landlord = await prisma.landlordAccount.findUnique({
    where: { userId }
  });

  if (!landlord) {
    throw new NotFoundError('Landlord account not found');
  }

  // Get current month
  const currentDate = new Date();
  const currentMonth = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;

  // Fetch all required data
  const [units, tenants, ledgerEntries] = await Promise.all([
    // Get all units for this landlord
    prisma.unit.findMany({
      where: {
        property: {
          landlordId: landlord.id
        }
      }
    }),
    // Get all tenant memberships with unit data
    prisma.tenantMembership.findMany({
      where: {
        landlordId: landlord.id
      },
      include: {
        unit: true,
        user: {
          select: {
            name: true
          }
        }
      }
    }),
    // Get all ledger entries for this landlord
    prisma.ledgerEntry.findMany({
      where: {
        tenantMembership: {
          landlordId: landlord.id
        }
      },
      include: {
        tenantMembership: {
          include: {
            user: {
              select: {
                name: true
              }
            }
          }
        }
      },
      orderBy: {
        effectiveDate: 'desc'
      }
    })
  ]);

  // Calculate metrics
  const occupancy = calculateOccupancyRate(units, tenants);
  const revenue = calculateMonthlyRevenue(tenants, ledgerEntries, currentMonth);
  const outstanding = getOutstandingBalance(tenants, ledgerEntries);
  const paymentStatus = getPaymentStatusBreakdown(tenants, ledgerEntries, currentMonth);
  const recentActivity = getRecentPayments(ledgerEntries, 10);

  // Count active tenants stats
  const activeTenants = tenants.filter(t => t.status === 'ACTIVE');
  const autopayEnabled = activeTenants.filter(t => t.autopayEnabled).length;
  const pendingInvites = activeTenants.filter(t => t.inviteStatus === 'PENDING').length;

  const analytics = {
    occupancy,
    revenue,
    outstanding,
    paymentStatus,
    activeTenants: {
      total: activeTenants.length,
      autopayEnabled,
      pendingInvites
    },
    recentActivity
  };

  res.json(apiResponse(analytics));
}));

export default router;