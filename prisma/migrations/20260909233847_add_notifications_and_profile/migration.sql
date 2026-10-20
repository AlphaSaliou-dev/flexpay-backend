-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('DEPOSIT_RECEIVED', 'WITHDRAWAL_COMPLETED', 'TRANSFER_SENT', 'TRANSFER_RECEIVED', 'PAYMENT_SENT', 'PAYMENT_RECEIVED', 'PAYMENT_REQUEST_PENDING', 'KYC_APPROVED', 'KYC_REJECTED', 'KYB_APPROVED', 'KYB_REJECTED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notifyOnPaymentRequests" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyOnTransactions" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
