-- AlterTable
ALTER TABLE "landlord_accounts" ADD COLUMN     "useBusinessName" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "country" TEXT,
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "lastName" TEXT;

-- Data Migration: Split existing name into firstName and lastName
-- First word becomes firstName, rest becomes lastName
UPDATE "users" SET
  "firstName" = SPLIT_PART("name", ' ', 1),
  "lastName" = CASE 
    WHEN POSITION(' ' IN "name") > 0 THEN SUBSTRING("name" FROM POSITION(' ' IN "name") + 1)
    ELSE ''
  END
WHERE "firstName" IS NULL;
