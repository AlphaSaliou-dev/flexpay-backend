/*
  Warnings:

  - Added the required column `payerPhone` to the `PaymentIntent` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ApiEnvironment" AS ENUM ('LIVE', 'TEST');

-- AlterTable
ALTER TABLE "ApiClient" ADD COLUMN     "environment" "ApiEnvironment" NOT NULL DEFAULT 'LIVE',
ADD COLUMN     "webhookSecret" TEXT,
ADD COLUMN     "webhookUrl" TEXT;

-- AlterTable
ALTER TABLE "PaymentIntent" ADD COLUMN     "environment" "ApiEnvironment" NOT NULL DEFAULT 'LIVE',
ADD COLUMN     "payerPhone" TEXT NOT NULL,
ALTER COLUMN "payerUserId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "BeneficiaryGroup" (
    "id" TEXT NOT NULL,
    "businessUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BeneficiaryGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BeneficiaryGroupMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "label" TEXT,
    "phone" TEXT NOT NULL,
    "defaultAmount" DECIMAL(18,2),
    "defaultReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BeneficiaryGroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BeneficiaryGroup_businessUserId_idx" ON "BeneficiaryGroup"("businessUserId");

-- CreateIndex
CREATE INDEX "BeneficiaryGroupMember_groupId_idx" ON "BeneficiaryGroupMember"("groupId");

-- AddForeignKey
ALTER TABLE "BeneficiaryGroupMember" ADD CONSTRAINT "BeneficiaryGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "BeneficiaryGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
