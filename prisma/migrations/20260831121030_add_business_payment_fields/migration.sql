-- AlterEnum
ALTER TYPE "FilePurpose" ADD VALUE 'BUSINESS_RECEIPT_LOGO';

-- AlterTable
ALTER TABLE "BusinessProfile" ADD COLUMN     "receiptFooterText" TEXT,
ADD COLUMN     "receiptLogoUrl" TEXT;

-- CreateTable
CREATE TABLE "BusinessPaymentField" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessPaymentField_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessPaymentField_businessProfileId_idx" ON "BusinessPaymentField"("businessProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessPaymentField_businessProfileId_fieldKey_key" ON "BusinessPaymentField"("businessProfileId", "fieldKey");

-- AddForeignKey
ALTER TABLE "BusinessPaymentField" ADD CONSTRAINT "BusinessPaymentField_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
