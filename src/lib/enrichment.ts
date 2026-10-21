// NYC Open Data (Socrata) bulk enrichment for parcels.
// All endpoints are free. App token is optional — without it we hit a lower
// rate limit. Set SOCRATA_APP_TOKEN env var to raise limits.
//
// Sources:
//   ACRIS Real Property Master   bnx9-e6tj   (sales / mortgages)
//   ACRIS Real Property Legals   8h5j-fqxa   (BBL ↔ document_id)
//   DOB NOW Job Filings          w9ak-ipjd   (active jobs)
//   DOB Permit Issuance (legacy) ipu4-2q9a   (recent permits)
//   DOB Violations               3h2n-5cm9   (open violations)
//   HPD Housing Maintenance      wvxf-dwi5   (open HPD violations)
//   Tax Lien Sale List           9rz4-mjek   (distress flag)

import { EnrichmentBlob } from "./scoring";
import { classifyAcrisDistress } from "./acrisDistress";

const TOKEN = process.env.SOCRATA_APP_TOKEN || "";
const HEADERS: Record<string, string> = TOKEN ? { "X-App-Token": TOKEN } : {};

const ENDPOINTS = {
  ACRIS_LEGALS:  "https://data.cityofnewyork.us/resource/8h5j-fqxa.json",
  ACRIS_MASTER:  "https://data.cityofnewyork.us/resource/bnx9-e6tj.json",
  ACRIS_PARTIES: "https://data.cityofnewyork.us/resource/636b-3b5g.json",
  DOB_JOBS:      "https://data.cityofnewyork.us/resource/ic3t-wcy2.json",
  DOB_PERMITS:   "https://data.cityofnewyork.us/resource/ipu4-2q9a.json",
  DOB_VIOLS:     "https://data.cityofnewyork.us/resource/3h2n-5cm9.json",
  HPD_VIOLS:     "https://data.cityofnewyork.us/resource/wvxf-dwi5.json",
  TAX_LIEN:      "https://data.cityofnewyork.us/resource/9rz4-mjek.json",
};

export type EnrichmentSource = "acris" | "permits" | "dobViolations" | "hpdViolations";

export interface EnrichmentProgressEvent {
  source: EnrichmentSource;
  status: "started" | "done" | "failed";
  message: string;
  parcelsWithData?: number;
}

interface BblParts { borough: string; block: string; lot: string; }

function parseBbl(bbl: string): BblParts | null {
  if (!bbl || bbl.length < 10) return null;
  return { borough: bbl[0], block: bbl.slice(1, 6), lot: bbl.slice(6, 10) };
}

/** DOB datasets store block/lot as 5-digit zero-padded text. BBL has block
 *  5-padded already and lot 4-padded; pad lot up to 5. */
function dobBlock(p: BblParts): string { return p.block; }                // already 5
function dobLot(p: BblParts):   string { return "0" + p.lot; }            // 4 -> 5

async function socrata(url: string, query: Record<string, string>): Promise<unknown[]> {
  const params = new URLSearchParams(query);
  const full = `${url}?${params.toString()}`;
  if (full.length > 16000) {
    console.warn(`[enrich] URL ${full.length} chars — Socrata may truncate. Reduce batch size.`);
  }
  try {
    const res = await fetch(full, { headers: HEADERS });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[enrich] Socrata ${res.status} ${url}\n  query: ${JSON.stringify(query).slice(0, 300)}\n  body: ${body.slice(0, 200)}`);
      return [];
    }
    return res.json() as Promise<unknown[]>;
  } catch (e) {
    console.error(`[enrich] Socrata fetch failed ${url}:`, e);
    return [];
  }
}

/** Quote a list of strings into Socrata IN-clause format. */
function inList(values: string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "")}'`).join(",");
}

/** Chunk an array into pieces. */
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Source-specific fetchers — each returns Map<bbl, partial enrichment>
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAcris(bbls: string[]): Promise<Map<string, Partial<EnrichmentBlob>>> {
  const out = new Map<string, Partial<EnrichmentBlob>>();
  // ACRIS Legals lets us join BBL → document_id; then Master gives sale/mortgage.
  // Batch size kept small — Socrata silently truncates long $where predicates.
  let totalLegals = 0, totalMaster = 0;
  for (const batch of chunk(bbls, 20)) {
    // Pull all legals rows for this batch in one go
    const parts = batch.map(parseBbl).filter((b): b is BblParts => b !== null);
    if (!parts.length) continue;

    // Build a multi-OR predicate
    const predicates = parts.map(
      (p) => `(borough='${p.borough}' AND block='${parseInt(p.block)}' AND lot='${parseInt(p.lot)}')`
    ).join(" OR ");

    const legals = await socrata(ENDPOINTS.ACRIS_LEGALS, {
      $where: predicates,
      $select: "document_id,borough,block,lot",
      $limit: "10000",
    }) as Array<{ document_id: string; borough: string; block: string; lot: string }>;
    totalLegals += legals.length;

    if (!legals.length) continue;

    // Map document_id → bbl (10-char)
    const docToBbl = new Map<string, string>();
    for (const r of legals) {
      const bbl =
        String(r.borough).padStart(1, "0") +
        String(r.block).padStart(5, "0") +
        String(r.lot).padStart(4, "0");
      docToBbl.set(r.document_id, bbl);
    }

    // Pull master records for these documents (deed/mortgage type filters)
    const docIds = Array.from(docToBbl.keys()).slice(0, 5000);
    if (!docIds.length) continue;

    // Master doc IDs come in batches of ≤500 — Socrata IN(...) lists explode
    // the predicate string, so chunk here too.
    const master: Array<{ document_id: string; doc_type: string; document_date: string; document_amt: string }> = [];
    for (const docBatch of chunk(docIds, 200)) {
      const rows = await socrata(ENDPOINTS.ACRIS_MASTER, {
        $where: `document_id IN(${inList(docBatch)})`,
        $select: "document_id,doc_type,document_date,document_amt",
        $limit: "20000",
      }) as Array<{ document_id: string; doc_type: string; document_date: string; document_amt: string }>;
      master.push(...rows);
    }
    totalMaster += master.length;

    // Pull party (grantee) info to detect LLC sales — chunk same as master.
    const parties: Array<{ document_id: string; name: string }> = [];
    for (const docBatch of chunk(docIds, 200)) {
      const rows = await socrata(ENDPOINTS.ACRIS_PARTIES, {
        $where: `document_id IN(${inList(docBatch)}) AND party_type='2'`,
        $select: "document_id,name",
        $limit: "20000",
      }) as Array<{ document_id: string; name: string }>;
      parties.push(...rows);
    }

    const granteeMap = new Map<string, string>();
    for (const p of parties) granteeMap.set(p.document_id, p.name);

    for (const m of master) {
      const bbl = docToBbl.get(m.document_id);
      if (!bbl) continue;
      const cur = out.get(bbl) ?? {};
      const date = m.document_date;
      const amt  = parseFloat(m.document_amt) || 0;
      const distressKind = classifyAcrisDistress(m.doc_type);

      // Some legacy ACRIS rows have no document_date; only update when we have
      // a real date AND it's newer than what's already stored.
      if (m.doc_type === "DEED" || m.doc_type === "DEEDO") {
        if (date && (!cur.last_sale_date || date > cur.last_sale_date)) {
          cur.last_sale_date  = date;
          cur.last_sale_price = amt || cur.last_sale_price;
          const grantee = granteeMap.get(m.document_id) ?? "";
          cur.last_sale_to_llc = /\bLLC\b|\bL\.L\.C\b|\bINC\b|\bCORP\b/i.test(grantee);
        } else if (!cur.last_sale_price && amt) {
          cur.last_sale_price = amt;
        }
      } else if (m.doc_type === "MTGE" || m.doc_type === "AGMT") {
        if (date && (!cur.recent_mortgage_date || date > cur.recent_mortgage_date)) {
          cur.recent_mortgage_date   = date;
          cur.recent_mortgage_amount = amt || cur.recent_mortgage_amount;
        } else if (!cur.recent_mortgage_amount && amt) {
          cur.recent_mortgage_amount = amt;
        }
      }
      if (distressKind) {
        cur.acris_distress_doc_count = (cur.acris_distress_doc_count ?? 0) + 1;
        cur.latest_acris_distress_date = date && (!cur.latest_acris_distress_date || date > cur.latest_acris_distress_date)
          ? date
          : cur.latest_acris_distress_date;
        cur.latest_acris_distress_type = date && cur.latest_acris_distress_date === date
          ? m.doc_type
          : (cur.latest_acris_distress_type ?? m.doc_type);
        if (distressKind === "tax_lien") {
          cur.acris_tax_lien_count = (cur.acris_tax_lien_count ?? 0) + 1;
        } else if (distressKind === "lis_pendens") {
          cur.acris_lis_pendens_count = (cur.acris_lis_pendens_count ?? 0) + 1;
        } else if (distressKind === "foreclosure") {
          cur.acris_foreclosure_count = (cur.acris_foreclosure_count ?? 0) + 1;
        } else {
          cur.acris_lien_count = (cur.acris_lien_count ?? 0) + 1;
        }
      }
      out.set(bbl, cur);
    }
  }
  console.log(`[enrich] ACRIS legals=${totalLegals} master=${totalMaster} parcelsWithData=${out.size}/${bbls.length}`);
  return out;
}

/** PLUTO borough digit → DOB Permits uppercase borough name. */
const BORO_NAME: Record<string, string> = {
  "1": "MANHATTAN", "2": "BRONX", "3": "BROOKLYN", "4": "QUEENS", "5": "STATEN ISLAND",
};

async function fetchDobJobs(bbls: string[]): Promise<Map<string, Partial<EnrichmentBlob>>> {
  // DOB Permit Issuance (ipu4-2q9a) has no `bbl` column — uses borough (full
  // uppercase name), block (text), lot (text). Filter by tuples.
  const out = new Map<string, Partial<EnrichmentBlob>>();
  const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 2);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  let totalRows = 0;
  let totalRecent = 0;
  for (const batch of chunk(bbls, 25)) {
    const parts = batch.map(parseBbl).filter((b): b is BblParts => b !== null);
    if (!parts.length) continue;
    const predicates = parts.map((p) => {
      const boro = BORO_NAME[p.borough];
      if (!boro) return null;
      // DOB Permits mostly stores lot as 5-digit zero-padded text, but a
      // small tail appears as 4-digit. Accept both, matching other DOB feeds.
      return `(borough='${boro}' AND block='${dobBlock(p)}' AND (lot='${dobLot(p)}' OR lot='${p.lot}'))`;
    }).filter(Boolean).join(" OR ");
    if (!predicates) continue;

    const rows = await socrata(ENDPOINTS.DOB_PERMITS, {
      $where: predicates,
      $select: "borough,block,lot,filing_date,issuance_date,permit_status",
      $limit: "20000",
    }) as Array<{ borough: string; block: string; lot: string; filing_date?: string; issuance_date?: string; permit_status?: string }>;
    totalRows += rows.length;

    for (const r of rows) {
      const permitDate = parsePermitDate(r.issuance_date ?? r.filing_date);
      if (!permitDate || permitDate < cutoffISO) continue;
      totalRecent += 1;

      const boroDigit = Object.entries(BORO_NAME).find(([, n]) => n === r.borough)?.[0];
      if (!boroDigit) continue;
      // r.lot comes back as "00001" (5-pad) — need to convert to 4-pad for BBL.
      const lot4 = String(r.lot).replace(/^0+/, "").padStart(4, "0") || "0000";
      const bbl =
        boroDigit +
        String(r.block).padStart(5, "0") +
        lot4;
      const cur = out.get(bbl) ?? {};
      cur.recent_permits_2y = (cur.recent_permits_2y ?? 0) + 1;
      const status = r.permit_status ?? "";
      if (/ACTIVE|IN PROCESS|FILED|ISSUED/i.test(status)) {
        cur.active_dob_jobs = (cur.active_dob_jobs ?? 0) + 1;
      }
      out.set(bbl, cur);
    }
  }
  console.log(`[enrich] DOB Permits rows=${totalRows} recent=${totalRecent} parcelsWithData=${out.size}/${bbls.length}`);
  return out;
}

function parsePermitDate(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!us) return null;
  const [, mm, dd, yyyy] = us;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

async function fetchDobViolations(bbls: string[]): Promise<Map<string, Partial<EnrichmentBlob>>> {
  // DOB Violations (3h2n-5cm9) uses `boro` (1-digit), `block`, `lot`.
  const out = new Map<string, Partial<EnrichmentBlob>>();
  let totalRows = 0;
  for (const batch of chunk(bbls, 25)) {
    const parts = batch.map(parseBbl).filter((b): b is BblParts => b !== null);
    if (!parts.length) continue;
    // DOB Violations: block/lot are 5-digit zero-padded (mostly). A small
    // tail uses 4-digit lot — accept both via OR.
    const predicates = parts.map(
      (p) => `(boro='${p.borough}' AND block='${dobBlock(p)}' AND (lot='${dobLot(p)}' OR lot='${p.lot}'))`
    ).join(" OR ");

    const rows = await socrata(ENDPOINTS.DOB_VIOLS, {
      $where: `(${predicates}) AND violation_category NOT LIKE '%RESOLVED%' AND violation_category NOT LIKE '%DISMISSED%'`,
      $select: "boro,block,lot",
      $limit: "20000",
    }) as Array<{ boro: string; block: string; lot: string }>;
    totalRows += rows.length;
    for (const r of rows) {
      const lot4 = String(r.lot).replace(/^0+/, "").padStart(4, "0") || "0000";
      const bbl =
        String(r.boro).padStart(1, "0") +
        String(r.block).padStart(5, "0") +
        lot4;
      const cur = out.get(bbl) ?? {};
      cur.open_dob_violations = (cur.open_dob_violations ?? 0) + 1;
      out.set(bbl, cur);
    }
  }
  console.log(`[enrich] DOB Violations rows=${totalRows} parcelsWithData=${out.size}/${bbls.length}`);
  return out;
}

async function fetchHpdViolations(bbls: string[]): Promise<Map<string, Partial<EnrichmentBlob>>> {
  const out = new Map<string, Partial<EnrichmentBlob>>();
  let totalRows = 0;
  for (const batch of chunk(bbls, 25)) {
    // HPD uses borough/block/lot columns separately, not bbl
    const parts = batch.map(parseBbl).filter((b): b is BblParts => b !== null);
    if (!parts.length) continue;
    const predicates = parts.map(
      (p) => `(boroid='${p.borough}' AND block='${parseInt(p.block)}' AND lot='${parseInt(p.lot)}')`
    ).join(" OR ");
    const rows = await socrata(ENDPOINTS.HPD_VIOLS, {
      $where: `(${predicates}) AND currentstatus NOT IN('VIOLATION CLOSED','VIOLATION DISMISSED')`,
      $select: "boroid,block,lot",
      $limit: "10000",
    }) as Array<{ boroid: string; block: string; lot: string }>;
    totalRows += rows.length;
    for (const r of rows) {
      const bbl =
        String(r.boroid).padStart(1, "0") +
        String(r.block).padStart(5, "0") +
        String(r.lot).padStart(4, "0");
      const cur = out.get(bbl) ?? {};
      cur.open_hpd_violations = (cur.open_hpd_violations ?? 0) + 1;
      out.set(bbl, cur);
    }
  }
  console.log(`[enrich] HPD Violations rows=${totalRows} parcelsWithData=${out.size}/${bbls.length}`);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry — fetch all sources for a BBL list, return merged enrichments.
// ─────────────────────────────────────────────────────────────────────────────

export async function bulkEnrich(
  bbls: string[],
  onProgress?: (event: EnrichmentProgressEvent) => void
): Promise<Map<string, EnrichmentBlob>> {
  const unique = Array.from(new Set(bbls)).filter((b) => b && b.length === 10);
  if (!unique.length) return new Map();
  const t0 = Date.now();
  console.log(`[enrich] starting bulkEnrich for ${unique.length} BBLs (token=${TOKEN ? "yes" : "no"})`);

  async function runSource(
    source: EnrichmentSource,
    label: string,
    fn: () => Promise<Map<string, Partial<EnrichmentBlob>>>
  ): Promise<Map<string, Partial<EnrichmentBlob>>> {
    onProgress?.({ source, status: "started", message: `${label} lookup started.` });
    try {
      const result = await fn();
      onProgress?.({
        source,
        status: "done",
        message: `${label} complete. Found signals for ${result.size.toLocaleString()} parcel${result.size === 1 ? "" : "s"}.`,
        parcelsWithData: result.size,
      });
      return result;
    } catch (e) {
      console.error(`${label} failed:`, e);
      onProgress?.({
        source,
        status: "failed",
        message: `${label} failed; continuing with remaining sources.`,
      });
      return new Map();
    }
  }

  // Run sources in parallel
  const [acris, jobs, dobV, hpdV] = await Promise.all([
    runSource("acris", "ACRIS sales and mortgages", () => fetchAcris(unique)),
    runSource("permits", "DOB jobs and permits", () => fetchDobJobs(unique)),
    runSource("dobViolations", "DOB violations", () => fetchDobViolations(unique)),
    runSource("hpdViolations", "HPD violations", () => fetchHpdViolations(unique)),
  ]);

  const merged = new Map<string, EnrichmentBlob>();
  for (const bbl of unique) {
    const e: EnrichmentBlob = {
      ...(acris.get(bbl) ?? {}),
      ...(jobs.get(bbl)  ?? {}),
      ...(dobV.get(bbl)  ?? {}),
      ...(hpdV.get(bbl)  ?? {}),
    };
    // Total open charges is open_dob_violations + open_hpd_violations as a rough count
    e.open_charges_total =
      (e.open_dob_violations ?? 0) + (e.open_hpd_violations ?? 0);
    e.acris_multiple_liens = ((e.acris_tax_lien_count ?? 0) + (e.acris_lien_count ?? 0)) >= 2;
    merged.set(bbl, e);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const stats = {
    withSale:    [...merged.values()].filter((e) => e.last_sale_date).length,
    withMortg:   [...merged.values()].filter((e) => e.recent_mortgage_date).length,
    withPermits: [...merged.values()].filter((e) => (e.recent_permits_2y ?? 0) > 0).length,
    withDobV:    [...merged.values()].filter((e) => (e.open_dob_violations ?? 0) > 0).length,
    withHpdV:    [...merged.values()].filter((e) => (e.open_hpd_violations ?? 0) > 0).length,
    withAcrisDistress: [...merged.values()].filter((e) => (e.acris_distress_doc_count ?? 0) > 0).length,
  };
  console.log(`[enrich] DONE in ${elapsed}s. parcels=${unique.length}`, stats);
  return merged;
}
