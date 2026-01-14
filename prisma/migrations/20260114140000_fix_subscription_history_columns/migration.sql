-- Clean up the failed migration record if it exists
DELETE FROM "_prisma_migrations" WHERE migration_name = '20260114135518_add_webhook_event_id_and_rename_stripe_fields';

-- Rename the existing stripeEventId column to stripeObjectId
ALTER TABLE "subscription_history" RENAME COLUMN "stripeEventId" TO "stripeObjectId";

-- Add the new stripeEventId column for webhook event IDs (evt_xxx)
ALTER TABLE "subscription_history" ADD COLUMN "stripeEventId" TEXT;

-- Create an index on stripeEventId for faster idempotency lookups
CREATE INDEX "subscription_history_stripeEventId_idx" ON "subscription_history"("stripeEventId");
