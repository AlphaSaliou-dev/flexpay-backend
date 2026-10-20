-- AlterTable
ALTER TABLE "BusinessProfile" ADD COLUMN     "customMaxBalance" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "declaresCommercialUse" BOOLEAN NOT NULL DEFAULT false;
