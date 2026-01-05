-- AlterTable
ALTER TABLE "landlord_accounts" ADD COLUMN     "defaultDueDay" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "defaultGracePeriodDays" INTEGER NOT NULL DEFAULT 5;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "businessName" TEXT,
ADD COLUMN     "taxId" TEXT;
