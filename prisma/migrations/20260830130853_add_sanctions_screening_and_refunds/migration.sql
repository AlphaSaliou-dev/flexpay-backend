-- CreateEnum
CREATE TYPE "WatchlistType" AS ENUM ('SANCTIONS', 'PEP');

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'REFUND';

-- AlterTable
ALTER TABLE "BusinessProfile" ADD COLUMN     "sanctionsDetails" JSONB,
ADD COLUMN     "sanctionsHit" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "KycProfile" ADD COLUMN     "sanctionsDetails" JSONB,
ADD COLUMN     "sanctionsHit" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "reversalOfTransactionId" TEXT;

-- CreateTable
CREATE TABLE "SanctionedEntity" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "type" "WatchlistType" NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SanctionedEntity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SanctionedEntity_fullName_idx" ON "SanctionedEntity"("fullName");

-- CreateIndex
CREATE INDEX "Transaction_reversalOfTransactionId_idx" ON "Transaction"("reversalOfTransactionId");
