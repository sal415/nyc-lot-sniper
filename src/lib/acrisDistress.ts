export type AcrisDistressKind =
  | "tax_lien"
  | "lis_pendens"
  | "foreclosure"
  | "judgment"
  | "other_lien";

export interface AcrisDistressSignal {
  documentId?: string | null;
  type: string;
  date: string | null;
  amount?: string | number | null;
  party1?: string | null;
  party2?: string | null;
  kind: AcrisDistressKind;
  label: string;
}

const RELEASE_OR_CLEARING_TYPES = new Set([
  "SAT",
  "PSAT",
  "WSAT",
  "REL",
  "PREL",
  "DTL",
  "RTXL",
  "TERL",
  "TERA",
  "TERT",
  "TERDECL",
]);

const TAX_LIEN_TYPES = new Set([
  "FTL",
  "CNFL",
  "AMFL",
  "ATL",
  "AMTL",
  "TLS",
  "LTPA",
  "ESTL",
]);

const OTHER_LIEN_TYPES = new Set([
  "ML",
  "MEL",
  "JL",
  "BOND",
  "JUDG",
]);

export function classifyAcrisDistress(type: string | null | undefined): AcrisDistressKind | null {
  const normalized = normalizeDocType(type);
  if (!normalized || RELEASE_OR_CLEARING_TYPES.has(normalized)) return null;

  const text = normalized.replace(/[,\-_]+/g, " ");
  if (text.includes("FORECLOS")) return "foreclosure";
  if (text === "LP TL" || text === "LPTL") return "foreclosure";
  if (text.includes("LIS PENDENS") || text === "LP" || text.startsWith("LP ")) return "lis_pendens";
  if (TAX_LIEN_TYPES.has(normalized) || text.includes("TAX LIEN") || text.includes("FEDERAL LIEN")) return "tax_lien";
  if (normalized === "JUDG" || text.includes("JUDGMENT")) return "judgment";
  if (OTHER_LIEN_TYPES.has(normalized) || /\bLIEN\b/.test(text)) return "other_lien";

  return null;
}

export function acrisDistressLabel(kind: AcrisDistressKind): string {
  switch (kind) {
    case "tax_lien": return "Tax lien";
    case "lis_pendens": return "Lis pendens";
    case "foreclosure": return "Foreclosure filing";
    case "judgment": return "Judgment";
    case "other_lien": return "Lien";
  }
}

export function normalizeDocType(type: string | null | undefined): string {
  return String(type ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}
