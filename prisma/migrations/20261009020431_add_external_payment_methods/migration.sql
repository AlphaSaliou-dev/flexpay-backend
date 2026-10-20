-- AlterTable
ALTER TABLE "ApiClient" ADD COLUMN     "enabledExternalMethods" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "BulkPayoutItem" ADD COLUMN     "payoutChannel" TEXT;
