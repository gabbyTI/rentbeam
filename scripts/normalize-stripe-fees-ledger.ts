/**
 * One-time script to normalize historical Stripe ledger postings so processing fees
 * are tenant liabilities (separate CHARGE rows) instead of appearing as credits.
 *
 * For each SUCCEEDED card payment with a Stripe PaymentIntent and processingFee > 0:
 * - Requires an existing PMNT-STRIPE-<paymentIntentId> ledger payment row.
 * - Creates missing FEE-STRIPE-<paymentIntentId> ledger charge row.
 *
 * Safe to run multiple times (idempotent by referenceId).
 *
 * Usage:
 *   npx tsx scripts/normalize-stripe-fees-ledger.ts
 */

import 'dotenv/config';
import prisma from '../src/lib/prisma.js';
import { postCharge } from '../src/services/ledger.js';

async function main() {
  console.log('Starting Stripe fee normalization...');

  const stripePayments = await prisma.payment.findMany({
    where: {
      method: 'CARD',
      status: 'SUCCEEDED',
      processingFee: { gt: 0 },
      stripePaymentIntentId: { not: null },
    },
    orderBy: { date: 'asc' },
  });

  console.log(`Found ${stripePayments.length} Stripe payments with non-zero fees`);

  let posted = 0;
  let skippedExisting = 0;
  let skippedMissingPayment = 0;
  let errors = 0;

  for (const payment of stripePayments) {
    const paymentIntentId = payment.stripePaymentIntentId;
    if (!paymentIntentId) continue;

    const paymentRef = `PMNT-STRIPE-${paymentIntentId}`;
    const feeRef = `FEE-STRIPE-${paymentIntentId}`;
    const feeAmount = Number(payment.processingFee);

    try {
      const existingFee = await prisma.ledgerEntry.findUnique({ where: { referenceId: feeRef } });
      if (existingFee) {
        skippedExisting++;
        continue;
      }

      const existingPayment = await prisma.ledgerEntry.findUnique({ where: { referenceId: paymentRef } });
      if (!existingPayment) {
        // Avoid creating a standalone fee if corresponding payment row was never posted.
        skippedMissingPayment++;
        continue;
      }

      await postCharge({
        tenantMembershipId: payment.tenantMembershipId,
        effectiveDate: payment.date,
        code: 'FEE',
        description: 'Card Processing Fee',
        amount: feeAmount,
        source: 'STRIPE',
        referenceId: feeRef,
      });

      posted++;
    } catch (error: any) {
      console.error(`ERROR payment ${payment.id}: ${error.message}`);
      errors++;
    }
  }

  console.log('\n-- Stripe fee normalization complete --');
  console.log(`Posted fee charges       : ${posted}`);
  console.log(`Skipped (already present): ${skippedExisting}`);
  console.log(`Skipped (no PMNT row)    : ${skippedMissingPayment}`);
  console.log(`Errors                   : ${errors}`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
