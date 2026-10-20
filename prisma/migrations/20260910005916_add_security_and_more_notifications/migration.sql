-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'KYC_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'KYB_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'NEW_LOGIN';
ALTER TYPE "NotificationType" ADD VALUE 'PASSWORD_CHANGED';
ALTER TYPE "NotificationType" ADD VALUE 'ACCOUNT_LOCKED';
ALTER TYPE "NotificationType" ADD VALUE 'VIRTUAL_CARD_ISSUED';
ALTER TYPE "NotificationType" ADD VALUE 'VIRTUAL_CARD_TOPUP';
ALTER TYPE "NotificationType" ADD VALUE 'VIRTUAL_CARD_FROZEN';
ALTER TYPE "NotificationType" ADD VALUE 'VIRTUAL_CARD_UNFROZEN';
ALTER TYPE "NotificationType" ADD VALUE 'BULK_PAYOUT_COMPLETED';
ALTER TYPE "NotificationType" ADD VALUE 'REFUND_RECEIVED';
