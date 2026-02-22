-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "city" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "country" TEXT NOT NULL DEFAULT 'CA',
ADD COLUMN     "postalCode" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "province" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "streetAddress" TEXT NOT NULL DEFAULT '';
