-- CreateEnum
CREATE TYPE "SwitchDecisionStatus" AS ENUM ('ACCEPTED', 'REJECTED');

-- CreateTable
CREATE TABLE "switch_reconciliation_decision" (
    "id" TEXT NOT NULL,
    "exceptionId" TEXT NOT NULL,
    "status" "SwitchDecisionStatus" NOT NULL,
    "scope" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "switch_reconciliation_decision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "switch_reconciliation_decision_exceptionId_createdAt_idx"
ON "switch_reconciliation_decision"("exceptionId", "createdAt");