-- CreateEnum
CREATE TYPE "FaceMatchStatus" AS ENUM ('NONE', 'PENDING', 'MATCH', 'NO_MATCH', 'INCONCLUSIVE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FilePurpose" ADD VALUE 'KYC_SELFIE';
ALTER TYPE "FilePurpose" ADD VALUE 'KYB_UBO_ID_DOCUMENT';

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totpSecret" TEXT;

-- AlterTable
ALTER TABLE "KycProfile" ADD COLUMN     "faceMatchScore" DOUBLE PRECISION,
ADD COLUMN     "faceMatchStatus" "FaceMatchStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "selfieUrl" TEXT;

-- CreateTable
CREATE TABLE "BusinessUBO" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "ownershipPercentage" DECIMAL(5,2) NOT NULL,
    "idDocumentUrl" TEXT NOT NULL,
    "sanctionsHit" BOOLEAN NOT NULL DEFAULT false,
    "sanctionsDetails" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessUBO_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessUBO_businessProfileId_idx" ON "BusinessUBO"("businessProfileId");

-- AddForeignKey
ALTER TABLE "BusinessUBO" ADD CONSTRAINT "BusinessUBO_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
