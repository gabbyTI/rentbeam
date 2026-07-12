-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('CHARGE', 'PAYMENT', 'CREDIT');

-- CreateEnum
CREATE TYPE "LedgerEntryStatus" AS ENUM ('PENDING', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "LedgerEntrySource" AS ENUM ('SYSTEM', 'STRIPE', 'MANUAL');

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "tenantMembershipId" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "status" "LedgerEntryStatus" NOT NULL DEFAULT 'POSTED',
    "source" "LedgerEntrySource" NOT NULL,
    "code" TEXT,
    "description" TEXT NOT NULL,
    "chargeAmount" DECIMAL(10,2),
    "paymentAmount" DECIMAL(10,2),
    "balanceAfter" DECIMAL(10,2) NOT NULL,
    "referenceId" TEXT,
    "postedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_referenceId_key" ON "ledger_entries"("referenceId");

-- CreateIndex
CREATE INDEX "ledger_entries_tenantMembershipId_idx" ON "ledger_entries"("tenantMembershipId");

-- CreateIndex
CREATE INDEX "ledger_entries_tenantMembershipId_status_idx" ON "ledger_entries"("tenantMembershipId", "status");

-- CreateIndex
CREATE INDEX "ledger_entries_tenantMembershipId_effectiveDate_idx" ON "ledger_entries"("tenantMembershipId", "effectiveDate");

-- CreateIndex
CREATE INDEX "ledger_entries_referenceId_idx" ON "ledger_entries"("referenceId");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_tenantMembershipId_fkey" FOREIGN KEY ("tenantMembershipId") REFERENCES "tenant_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
