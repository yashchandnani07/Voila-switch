export type Paise = number;

export type GstTax = {
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise?: Paise;
};

export type PurchaseInvoiceInput = GstTax & {
  id: string;
  vendorGstin: string;
  vendorName: string;
  vendorStateCode: string;
  invoiceNo: string;
  invoiceDate: string;
  period: string;
  hsn?: string;
  category?: string;
  /** Section 17(5) clause, already decided by the taxonomy pass (and not overridden). */
  blockedClause?: string | null;
};

export type Gstr2bLineInput = GstTax & {
  id: string;
  supplierGstin: string;
  invoiceNo: string;
  invoiceDate: string;
  period: string;
};

export type GstExceptionType =
  | "NOT_IN_2B"
  | "NOT_IN_BOOKS"
  | "AMOUNT_MISMATCH"
  | "GSTIN_TYPO"
  | "PERIOD_MISMATCH"
  | "BLOCKED_CREDIT"
  | "INVALID_GSTIN"
  | "TAX_TYPE_MISMATCH";

export type MatchTier = "exact" | "fuzzy";

export type GstMatch = {
  purchaseInvoiceId?: string;
  gstr2bLineId?: string;
  type: "MATCHED" | "EXCEPTION";
  tier?: MatchTier;
  exceptionType?: GstExceptionType;
  stableId: string;
  amountPaise: Paise;
  evidence: string[];
};

export type GstRun = {
  matches: GstMatch[];
  stats: {
    purchaseInvoices: number;
    gstr2bLines: number;
    matched: number;
    matchedExact: number;
    matchedFuzzy: number;
    exceptions: number;
    byType: Partial<Record<GstExceptionType, number>>;
    falseMatchSafe: boolean;
  };
};
