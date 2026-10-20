-- AlterEnum
ALTER TYPE "OtpPurpose" ADD VALUE 'SMS_COMMAND';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "smsReference" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_smsReference_key" ON "User"("smsReference");

