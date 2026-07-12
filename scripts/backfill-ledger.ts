/**
 * scripts/backfill-ledger.ts
 *
 * One-time script: reads all existing SUCCEEDED Payment rows and creates
 * corresponding LedgerEntry PAYMENT rows so historical data appears on the ledger.
 *
 * Safe to run multiple times — skips entries that already have a matching referenceId.
 *
 * Usage:
 *   npx tsx scripts/backfill-ledger.ts
 */

import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Starting ledger backfill from Payment records...');

  const payments = await prisma.payment.findMany({
    where: { status: 'SUCCEEDED' },
    orderBy: { date: 'asc' },
  });

  console.log(`Found ${payments.length} SUCCEEDED payments to process`);

  let posted = 0;
  let skipped = 0;
  let errors = 0;

  for (const payment of payments) {
    const referenceId = `PMNT-BACKFILL-${payment.id}`;

    try {
      // Idempotency: skip if this payment was already backfilled
      const existing = await prisma.ledgerEntry.findUnique({ where: { referenceId } });
      if (existing) {
        skipped++;
        continue;
      }

      // Determine previous balance for this tenant up to this point
      const previousEntry = await prisma.ledgerEntry.findFirst({
        where: {
          tenantMembershipId: payment.tenantMembershipId,
          status: 'POSTED',
          effectiveDate: { lte: payment.date },
        },
        orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
      });

      const previousBalance = previousEntry ? Number(previousEntry.balanceAfter) : 0;
      const paymentAmount = Number(payment.totalAmount);
      const balanceAfter = previousBalance - paymentAmount;

      const method = payment.method === 'CARD' ? 'Online Payment (Card)' : 'Manual Payment';
      const note = payment.note ? ` – ${payment.note}` : '';

      await prisma.ledgerEntry.create({
        data: {
          tenantMembershipId: payment.tenantMembershipId,
          effectiveDate: payment.date,
          type: 'PAYMENT',
          status: 'POSTED',
          source: payment.method === 'CARD' ? 'STRIPE' : 'MANUAL',
          code: null,
          description: `${method}${note}`,
          chargeAmount: null,
          paymentAmount: new Prisma.Decimal(paymentAmount),
          balanceAfter: new Prisma.Decimal(balanceAfter),
          referenceId,
          postedBy: null,
        },
      });

      posted++;

      if (posted % 50 === 0) {
        console.log(`  Backfilled ${posted} payments so far...`);
      }
    } catch (err: any) {
      console.error(`  ERROR for payment ${payment.id}: ${err.message}`);
      errors++;
    }
  }

  console.log('\n── Backfill complete ──────────────────────────────────');
  console.log(`  Posted : ${posted}`);
  console.log(`  Skipped: ${skipped} (already existed)`);
  console.log(`  Errors : ${errors}`);
  console.log('──────────────────────────────────────────────────────');

  await prisma.$disconnect();
  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error during backfill:', err);
  process.exit(1);
});
