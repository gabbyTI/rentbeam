import prisma from '../lib/prisma.js';
import { postCharge } from '../services/ledger.js';
import { cronExecutionsTotal, cronLastRunTimestamp } from '../lib/metrics.js';
import logger from '../lib/logger.js';

interface RentChargeResult {
  processed: number;
  posted: number;
  skipped: number;
  errors: Array<{ tenantMembershipId: string; error: string }>;
}

/**
 * Post monthly rent charges to the ledger for all active tenants
 * whose due day matches today.
 *
 * Idempotency: referenceId = "RNTA-{tenantMembershipId}-{YYYY-MM}"
 * Running this multiple times in the same month is safe.
 */
export async function postMonthlyRentCharges(): Promise<RentChargeResult> {
  const result: RentChargeResult = {
    processed: 0,
    posted: 0,
    skipped: 0,
    errors: [],
  };

  try {
    const today = new Date();
    const currentDay = today.getDate();
    const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

    logger.info({ currentDay, currentMonth }, 'Starting monthly rent charge posting');

    // Find all active tenant memberships whose rent due day is today
    // AND whose move-in date is on or before today (don't charge future tenants)
    const tenants = await prisma.tenantMembership.findMany({
      where: {
        status: 'ACTIVE',
        moveInDate: { lte: today },
        unit: {
          dueDay: currentDay,
        },
      },
      include: {
        unit: true,
      },
    });

    logger.info({ count: tenants.length }, `Found tenants with rent due on day ${currentDay}`);

    for (const tenant of tenants) {
      result.processed++;

      try {
        const rentAmount = Number(tenant.unit.rentAmount);
        const referenceId = `RNTA-${tenant.id}-${currentMonth}`;

        // postCharge handles idempotency — skips if referenceId already exists
        const entry = await postCharge({
          tenantMembershipId: tenant.id,
          effectiveDate: today,
          code: 'RNTA',
          description: `Apartment Rent (${currentMonth})`,
          amount: rentAmount,
          source: 'SYSTEM',
          referenceId,
        });

        // entry is the newly created or the pre-existing row
        // If it was already posted this month the id will match the existing one
        const wasSkipped = entry.createdAt.getTime() < Date.now() - 5000; // rough heuristic
        if (wasSkipped) {
          result.skipped++;
          logger.info({ tenantMembershipId: tenant.id, referenceId }, 'Rent charge already posted this month, skipped');
        } else {
          result.posted++;
          logger.info({ tenantMembershipId: tenant.id, referenceId, amount: rentAmount }, 'Rent charge posted');
        }
      } catch (err: any) {
        result.errors.push({ tenantMembershipId: tenant.id, error: err.message });
        logger.error({ tenantMembershipId: tenant.id, error: err.message }, 'Failed to post rent charge');
      }
    }

    logger.info(result, 'Monthly rent charge posting complete');
    return result;
  } finally {
    cronExecutionsTotal.inc({ job: 'rent_charges', status: 'success' });
    cronLastRunTimestamp.set({ job: 'rent_charges' }, Math.floor(Date.now() / 1000));
  }
}
