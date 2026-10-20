-- CreateEnum
CREATE TYPE "PerDiemFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateTable
CREATE TABLE "PerDiemSchedule" (
    "id" TEXT NOT NULL,
    "businessUserId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "groupId" TEXT,
    "frequency" "PerDiemFrequency" NOT NULL DEFAULT 'DAILY',
    "timeOfDay" TEXT NOT NULL DEFAULT '07:00',
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "externalPayoutMethod" TEXT,
    "reference" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "lastRunBulkPayoutId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerDiemSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PerDiemSchedule_businessUserId_key" ON "PerDiemSchedule"("businessUserId");

-- AddForeignKey
ALTER TABLE "PerDiemSchedule" ADD CONSTRAINT "PerDiemSchedule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "BeneficiaryGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
