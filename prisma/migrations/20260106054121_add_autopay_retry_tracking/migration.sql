-- AlterTable
ALTER TABLE "tenant_memberships" ADD COLUMN     "autopayFailureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastAutopayFailureAt" TIMESTAMP(3);
