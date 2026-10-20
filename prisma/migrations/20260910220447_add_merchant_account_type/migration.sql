-- AlterEnum
ALTER TYPE "AccountType" ADD VALUE 'MERCHANT';

-- AlterTable
ALTER TABLE "BusinessProfile" ALTER COLUMN "rccmNumber" DROP NOT NULL,
ALTER COLUMN "nifNumber" DROP NOT NULL,
ALTER COLUMN "legalRepName" DROP NOT NULL,
ALTER COLUMN "legalRepIdDocumentUrl" DROP NOT NULL,
ALTER COLUMN "businessDocumentUrl" DROP NOT NULL;
