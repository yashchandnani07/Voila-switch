/**
 * Deterministic expense taxonomy and Section 17(5) blocked-credit rules.
 *
 * The rules are data, not prompts: each class lists the ledger words and HSN/SAC prefixes
 * that identify it, and blocked classes carry the clause of Section 17(5) of the CGST Act
 * that denies the credit. The taxonomy agent explains these results; it never decides them.
 * A blocked flag can only be lifted by a human-approved override recorded on the invoice.
 */

export type ExpenseRule = {
  id: string;
  label: string;
  /** Section 17(5) clause when ITC on this class is blocked. */
  blockedClause?: string;
  blockedReason?: string;
  keywords: string[];
  hsnPrefixes: string[];
};

export const EXPENSE_RULES: ExpenseRule[] = [
  {
    id: "motor_vehicle",
    label: "Motor vehicles and their repairs, insurance, fuel",
    blockedClause: "17(5)(a)/(ab)",
    blockedReason: "Motor vehicles for carrying ≤13 persons, and their repair, servicing and insurance, are blocked unless used for onward supply, passenger transport, driving training or goods transport.",
    keywords: ["motor vehicle", "car ", "car-", "vehicle", "sedan", "suv", "car hire", "car rental", "vehicle insurance", "vehicle repair", "car service"],
    hsnPrefixes: ["8703", "8711", "998714"],
  },
  {
    id: "food_beverage",
    label: "Food, beverages and outdoor catering",
    blockedClause: "17(5)(b)(i)",
    blockedReason: "Food and beverages, outdoor catering, beauty treatment, health services and cosmetic surgery are blocked unless used for an outward supply of the same category or mandated by law.",
    keywords: ["food", "beverage", "restaurant", "catering", "canteen", "meals", "refreshment", "pantry", "lunch", "dinner", "snacks"],
    hsnPrefixes: ["9963", "2106", "2202"],
  },
  {
    id: "club_fitness",
    label: "Club membership, health and fitness",
    blockedClause: "17(5)(b)(ii)",
    blockedReason: "Membership of a club, health or fitness centre is blocked.",
    keywords: ["club", "gym", "fitness", "membership"],
    hsnPrefixes: ["999723", "999791"],
  },
  {
    id: "employee_travel",
    label: "Leave travel and employee holidays",
    blockedClause: "17(5)(b)(iii)",
    blockedReason: "Travel benefits extended to employees on vacation (leave or home travel concession) are blocked.",
    keywords: ["leave travel", "ltc", "holiday package", "vacation"],
    hsnPrefixes: ["998552"],
  },
  {
    id: "construction",
    label: "Construction of immovable property",
    blockedClause: "17(5)(c)/(d)",
    blockedReason: "Works contracts and goods or services for constructing immovable property on own account are blocked, except plant and machinery.",
    keywords: ["construction", "civil work", "building work", "works contract", "cement", "flooring"],
    hsnPrefixes: ["9954", "2523"],
  },
  {
    id: "personal_gift",
    label: "Personal consumption, gifts and free samples",
    blockedClause: "17(5)(g)/(h)",
    blockedReason: "Goods or services for personal consumption, and goods given away as gifts or free samples, are blocked.",
    keywords: ["personal use", "personal consumption", "gift", "diwali gift", "free sample", "hamper"],
    hsnPrefixes: [],
  },
  { id: "raw_material", label: "Raw materials and components", keywords: ["raw material", "component", "steel", "aluminium", "copper", "resin", "pcb", "castings", "fasteners"], hsnPrefixes: ["72", "73", "74", "76", "39", "8534"] },
  { id: "packaging", label: "Packaging material", keywords: ["packaging", "carton", "corrugated", "pallet"], hsnPrefixes: ["4819", "4415"] },
  { id: "logistics", label: "Freight and logistics", keywords: ["freight", "logistics", "transport", "courier", "gta"], hsnPrefixes: ["9965", "9968"] },
  { id: "professional", label: "Professional and consulting services", keywords: ["consulting", "legal", "audit", "professional", "advisory"], hsnPrefixes: ["9982", "9983"] },
  { id: "software_it", label: "Software, cloud and IT services", keywords: ["software", "saas", "cloud", "it services", "hosting", "licence", "license"], hsnPrefixes: ["9973", "9984", "998313", "998315"] },
  { id: "capital_goods", label: "Plant, machinery and capital goods", keywords: ["machinery", "machine", "equipment", "plant", "tooling", "cnc"], hsnPrefixes: ["84", "85"] },
  { id: "office_supplies", label: "Office supplies and stationery", keywords: ["office", "stationery", "printer", "toner", "furniture"], hsnPrefixes: ["4820", "9403"] },
  { id: "repairs_maintenance", label: "Repairs and maintenance (non-vehicle)", keywords: ["repair", "maintenance", "amc", "servicing"], hsnPrefixes: ["9987"] },
  { id: "rent_utilities", label: "Rent, power and utilities", keywords: ["rent", "lease", "electricity", "utility", "telecom", "internet"], hsnPrefixes: ["9972", "9984"] },
];

export type Classification = {
  expenseClass: string;
  label: string;
  blockedClause: string | null;
  blockedReason: string | null;
  /** What matched: the HSN prefix or the ledger word. Shown as evidence, never guessed. */
  basis: string;
  confidence: "high" | "medium" | "low";
};

/**
 * Classify one purchase line. HSN/SAC prefix wins over ledger words because it is what the
 * supplier declared; the longest prefix wins among HSN rules. Blocked rules are checked
 * before ordinary ones, so a "car repair" ledger never lands in repairs and maintenance.
 */
export function classifyExpense(category: string | null | undefined, hsn: string | null | undefined): Classification {
  const code = (hsn ?? "").replace(/\s/g, "");
  if (code) {
    let best: { rule: ExpenseRule; prefix: string } | null = null;
    for (const rule of EXPENSE_RULES) {
      for (const prefix of rule.hsnPrefixes) {
        if (code.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { rule, prefix };
      }
    }
    if (best) return result(best.rule, `HSN/SAC ${code} starts with ${best.prefix}`, best.prefix.length >= 4 ? "high" : "medium");
  }
  const text = ` ${(category ?? "").toLowerCase()} `;
  const ordered = [...EXPENSE_RULES.filter((rule) => rule.blockedClause), ...EXPENSE_RULES.filter((rule) => !rule.blockedClause)];
  for (const rule of ordered) {
    const word = rule.keywords.find((keyword) => text.includes(keyword));
    if (word) return result(rule, `ledger "${category}" contains "${word.trim()}"`, "medium");
  }
  return {
    expenseClass: "unclassified",
    label: "Unclassified",
    blockedClause: null,
    blockedReason: null,
    basis: category ? `no rule matched ledger "${category}"` : "no ledger or HSN supplied",
    confidence: "low",
  };
}

function result(rule: ExpenseRule, basis: string, confidence: Classification["confidence"]): Classification {
  return {
    expenseClass: rule.id,
    label: rule.label,
    blockedClause: rule.blockedClause ?? null,
    blockedReason: rule.blockedReason ?? null,
    basis,
    confidence,
  };
}

/** Kept for callers that only need the yes/no answer. */
export function isBlockedCredit(category: string | undefined, hsn: string | undefined) {
  return classifyExpense(category, hsn).blockedClause !== null;
}
