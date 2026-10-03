-- CreateEnum
CREATE TYPE "RecurringChargeFrequency" AS ENUM ('MONTHLY', 'WEEKLY');

-- CreateTable
CREATE TABLE "recurring_charge_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_charge_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_recurring_charge_rules" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "chargeTypeId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "frequency" "RecurringChargeFrequency" NOT NULL DEFAULT 'MONTHLY',
    "dueDay" INTEGER NOT NULL DEFAULT 1,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "lastGeneratedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unit_recurring_charge_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recurring_charge_types_code_key" ON "recurring_charge_types"("code");

-- CreateIndex
CREATE INDEX "unit_recurring_charge_rules_unitId_idx" ON "unit_recurring_charge_rules"("unitId");

-- CreateIndex
CREATE INDEX "unit_recurring_charge_rules_chargeTypeId_idx" ON "unit_recurring_charge_rules"("chargeTypeId");

-- CreateIndex
CREATE INDEX "unit_recurring_charge_rules_active_effectiveDate_idx" ON "unit_recurring_charge_rules"("active", "effectiveDate");

-- AddForeignKey
ALTER TABLE "unit_recurring_charge_rules" ADD CONSTRAINT "unit_recurring_charge_rules_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_recurring_charge_rules" ADD CONSTRAINT "unit_recurring_charge_rules_chargeTypeId_fkey" FOREIGN KEY ("chargeTypeId") REFERENCES "recurring_charge_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;
