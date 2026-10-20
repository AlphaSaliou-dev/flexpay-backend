-- CreateEnum
CREATE TYPE "ApiPayoutStatus" AS ENUM ('COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- AlterEnum
ALTER TYPE "PaymentIntentStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "ApiClient" ADD COLUMN     "allowedIps" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "lastUsedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ApiPayout" (
    "id" TEXT NOT NULL,
    "apiClientId" TEXT NOT NULL,
    "environment" "ApiEnvironment" NOT NULL,
    "recipientPhone" TEXT NOT NULL,
    "recipientUserId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "reference" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "ApiPayoutStatus" NOT NULL,
    "transactionId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ApiPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "apiClientId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiPayout_idempotencyKey_key" ON "ApiPayout"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ApiPayout_apiClientId_idx" ON "ApiPayout"("apiClientId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_apiClientId_createdAt_idx" ON "WebhookDelivery"("apiClientId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextRetryAt_idx" ON "WebhookDelivery"("status", "nextRetryAt");

-- AddForeignKey
ALTER TABLE "ApiPayout" ADD CONSTRAINT "ApiPayout_apiClientId_fkey" FOREIGN KEY ("apiClientId") REFERENCES "ApiClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_apiClientId_fkey" FOREIGN KEY ("apiClientId") REFERENCES "ApiClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
