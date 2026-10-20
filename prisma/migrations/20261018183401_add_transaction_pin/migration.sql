-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'TRANSACTION_PIN_CHANGED';
ALTER TYPE "NotificationType" ADD VALUE 'TRANSACTION_PIN_LOCKED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "transactionPinFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "transactionPinHash" TEXT,
ADD COLUMN     "transactionPinLockedUntil" TIMESTAMP(3);
