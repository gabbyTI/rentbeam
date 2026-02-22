-- CreateEnum
CREATE TYPE "LeaseType" AS ENUM ('FIXED_TERM', 'MONTH_TO_MONTH');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('LEASE', 'MOVE_IN_INSPECTION', 'MOVE_OUT_INSPECTION', 'NOTICE', 'ID_VERIFICATION', 'OTHER');

-- AlterTable
ALTER TABLE "tenant_memberships" ADD COLUMN     "dateOfBirth" TIMESTAMP(3),
ADD COLUMN     "emergencyContactName" TEXT,
ADD COLUMN     "emergencyContactPhone" TEXT,
ADD COLUMN     "leaseEndDate" TIMESTAMP(3),
ADD COLUMN     "leaseStartDate" TIMESTAMP(3),
ADD COLUMN     "leaseType" "LeaseType" NOT NULL DEFAULT 'FIXED_TERM',
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "rentDeposit" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "tenant_documents" (
    "id" TEXT NOT NULL,
    "tenantMembershipId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_documents_tenantMembershipId_idx" ON "tenant_documents"("tenantMembershipId");

-- AddForeignKey
ALTER TABLE "tenant_documents" ADD CONSTRAINT "tenant_documents_tenantMembershipId_fkey" FOREIGN KEY ("tenantMembershipId") REFERENCES "tenant_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
