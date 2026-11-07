-- AlterTable
ALTER TABLE "gst_gstr2b_line" ADD COLUMN     "cessPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "itcAvailable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "supplierFiledOn" TEXT,
ADD COLUMN     "supplierName" TEXT;

-- AlterTable
ALTER TABLE "gst_itc_decision" ADD COLUMN     "approvedBy" TEXT;

-- AlterTable
ALTER TABLE "gst_period" ADD COLUMN     "businessName" TEXT,
ADD COLUMN     "matchStats" JSONB,
ADD COLUMN     "matchedAt" TIMESTAMP(3),
ADD COLUMN     "recipientGstin" TEXT,
ADD COLUMN     "signoffRecordedBy" TEXT,
ADD COLUMN     "signoffRequestedAt" TIMESTAMP(3),
ADD COLUMN     "signoffRequestedBy" TEXT;

-- AlterTable
ALTER TABLE "gst_purchase_invoice" ADD COLUMN     "blockedClause" TEXT,
ADD COLUMN     "blockedOverride" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cessPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "expenseClass" TEXT,
ADD COLUMN     "overrideApprovedBy" TEXT,
ADD COLUMN     "overrideAt" TIMESTAMP(3),
ADD COLUMN     "overrideReason" TEXT,
ADD COLUMN     "placeOfSupply" TEXT;

-- AlterTable
ALTER TABLE "gst_vendor_followup" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "draftedBy" TEXT,
ADD COLUMN     "invoiceRefs" JSONB,
ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "sentVia" TEXT;

-- CreateTable
CREATE TABLE "gst_event" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "approvedBy" TEXT,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gst_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gst_event_period_createdAt_idx" ON "gst_event"("period", "createdAt");
