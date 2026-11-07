-- CreateEnum
CREATE TYPE "GstExceptionType" AS ENUM ('NOT_IN_2B', 'NOT_IN_BOOKS', 'AMOUNT_MISMATCH', 'GSTIN_TYPO', 'PERIOD_MISMATCH', 'BLOCKED_CREDIT', 'INVALID_GSTIN', 'TAX_TYPE_MISMATCH');

-- CreateEnum
CREATE TYPE "GstExceptionStatus" AS ENUM ('OPEN', 'CLAIMED', 'DEFERRED', 'REVERSED');

-- CreateEnum
CREATE TYPE "GstItcDecision" AS ENUM ('CLAIM', 'DEFER', 'REVERSE');

-- CreateEnum
CREATE TYPE "VendorFollowupStatus" AS ENUM ('DRAFT', 'APPROVED', 'SENT', 'RESOLVED');

-- CreateEnum
CREATE TYPE "GstPeriodStatus" AS ENUM ('OPEN', 'MATCHED', 'PENDING_CA', 'SIGNED_OFF');

-- CreateTable
CREATE TABLE "gst_vendor" (
    "id" TEXT NOT NULL,
    "gstin" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "contact" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gst_vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_purchase_invoice" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "normalizedInvoiceNo" TEXT NOT NULL,
    "invoiceDate" DATE NOT NULL,
    "period" TEXT NOT NULL,
    "taxablePaise" INTEGER NOT NULL,
    "cgstPaise" INTEGER NOT NULL DEFAULT 0,
    "sgstPaise" INTEGER NOT NULL DEFAULT 0,
    "igstPaise" INTEGER NOT NULL DEFAULT 0,
    "hsn" TEXT,
    "category" TEXT,
    "source" TEXT NOT NULL DEFAULT 'purchase_register',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gst_purchase_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_gstr2b_line" (
    "id" TEXT NOT NULL,
    "supplierGstin" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "normalizedInvoiceNo" TEXT NOT NULL,
    "invoiceDate" DATE NOT NULL,
    "period" TEXT NOT NULL,
    "taxablePaise" INTEGER NOT NULL,
    "cgstPaise" INTEGER NOT NULL DEFAULT 0,
    "sgstPaise" INTEGER NOT NULL DEFAULT 0,
    "igstPaise" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gst_gstr2b_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_exception" (
    "id" TEXT NOT NULL,
    "stableId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "type" "GstExceptionType" NOT NULL,
    "status" "GstExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "evidence" JSONB NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "purchaseInvoiceId" TEXT,
    "gstr2bLineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gst_exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_itc_decision" (
    "id" TEXT NOT NULL,
    "exceptionId" TEXT NOT NULL,
    "decision" "GstItcDecision" NOT NULL,
    "actor" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gst_itc_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_vendor_followup" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "draft" TEXT NOT NULL,
    "status" "VendorFollowupStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedBy" TEXT,
    "sentAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gst_vendor_followup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_period" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" "GstPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "signedOffBy" TEXT,
    "signedOffAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gst_period_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gst_vendor_name_idx" ON "gst_vendor"("name");

-- CreateIndex
CREATE UNIQUE INDEX "gst_vendor_gstin_key" ON "gst_vendor"("gstin");

-- CreateIndex
CREATE INDEX "gst_purchase_invoice_vendorId_normalizedInvoiceNo_idx" ON "gst_purchase_invoice"("vendorId", "normalizedInvoiceNo");

-- CreateIndex
CREATE INDEX "gst_purchase_invoice_period_invoiceDate_idx" ON "gst_purchase_invoice"("period", "invoiceDate");

-- CreateIndex
CREATE INDEX "gst_gstr2b_line_supplierGstin_normalizedInvoiceNo_idx" ON "gst_gstr2b_line"("supplierGstin", "normalizedInvoiceNo");

-- CreateIndex
CREATE INDEX "gst_gstr2b_line_period_invoiceDate_idx" ON "gst_gstr2b_line"("period", "invoiceDate");

-- CreateIndex
CREATE UNIQUE INDEX "gst_exception_stableId_key" ON "gst_exception"("stableId");

-- CreateIndex
CREATE INDEX "gst_exception_period_status_idx" ON "gst_exception"("period", "status");

-- CreateIndex
CREATE INDEX "gst_exception_purchaseInvoiceId_idx" ON "gst_exception"("purchaseInvoiceId");

-- CreateIndex
CREATE INDEX "gst_exception_gstr2bLineId_idx" ON "gst_exception"("gstr2bLineId");

-- CreateIndex
CREATE INDEX "gst_itc_decision_exceptionId_createdAt_idx" ON "gst_itc_decision"("exceptionId", "createdAt");

-- CreateIndex
CREATE INDEX "gst_vendor_followup_period_status_idx" ON "gst_vendor_followup"("period", "status");

-- CreateIndex
CREATE UNIQUE INDEX "gst_vendor_followup_vendorId_period_key" ON "gst_vendor_followup"("vendorId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "gst_period_period_key" ON "gst_period"("period");

-- AddForeignKey
ALTER TABLE "gst_purchase_invoice" ADD CONSTRAINT "gst_purchase_invoice_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "gst_vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_exception" ADD CONSTRAINT "gst_exception_purchaseInvoiceId_fkey" FOREIGN KEY ("purchaseInvoiceId") REFERENCES "gst_purchase_invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_exception" ADD CONSTRAINT "gst_exception_gstr2bLineId_fkey" FOREIGN KEY ("gstr2bLineId") REFERENCES "gst_gstr2b_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_itc_decision" ADD CONSTRAINT "gst_itc_decision_exceptionId_fkey" FOREIGN KEY ("exceptionId") REFERENCES "gst_exception"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_vendor_followup" ADD CONSTRAINT "gst_vendor_followup_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "gst_vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
