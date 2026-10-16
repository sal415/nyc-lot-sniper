// NYC Open Data (Socrata) enrichment for parcels.
// All endpoints are free. App token is optional — without it we hit a lower
// rate limit. Set SOCRATA_APP_TOKEN env var to raise limits.
//
// Sources:
//   ACRIS Real Property Master   bnx9-e6tj   (sales / mortgages / liens)
//   ACRIS Real Property Legals   8h5j-fqxa   (BBL ↔ document_id)
//   ACRIS Real Property Parties  636b-3b5g   (grantee names)

import { EnrichmentBlob } from "./scoring";
import { classifyAcrisDistress } from "./acrisDistress";

const TOKEN = process.env.SOCRATA_APP_TOKEN || "";
const HEADERS: Record<string, string> = TOKEN ? { "X-App-Token": TOKEN } : {};

const ENDPOINTS = {
  ACRIS_LEGALS:  "https://data.cityofnewyork.us/resource/8h5j-fqxa.json",
  ACRIS_MASTER:  "https://data.cityofnewyork.us/resource/bnx9-e6tj.json",
  ACRIS_PARTIES: "https://data.cityofnewyork.us/resource/636b-3b5g.json",
};

export interface EnrichmentProgressEvent {
  source: "acris";
  status: "started" | "done" | "failed";
  message: string;
  parcelsWithData?: number;
}

interface BblParts { borough: string; block: string; lot: string; }

function parseBbl(bbl: string): BblParts | null {
  if (!bbl || bbl.length < 10) return null;
  return { borough: bbl[0], block: bbl.slice(1, 6), lot: bbl.slice(6, 10) };
}

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
// ACRIS — sales, mortgages and distress filings per BBL
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


// ─────────────────────────────────────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────────────────────────────────────

export async function bulkEnrich(
  bbls: string[],
  onProgress?: (event: EnrichmentProgressEvent) => void
): Promise<Map<string, EnrichmentBlob>> {
  const unique = Array.from(new Set(bbls)).filter((b) => b && b.length === 10);
  if (!unique.length) return new Map();

  onProgress?.({ source: "acris", status: "started", message: "ACRIS sales and mortgages lookup started." });
  let acris = new Map<string, Partial<EnrichmentBlob>>();
  try {
    acris = await fetchAcris(unique);
    onProgress?.({
      source: "acris",
      status: "done",
      message: `ACRIS complete. Found signals for ${acris.size.toLocaleString()} parcels.`,
      parcelsWithData: acris.size,
    });
  } catch (e) {
    console.error("ACRIS lookup failed:", e);
    onProgress?.({ source: "acris", status: "failed", message: "ACRIS failed; continuing without it." });
  }

  const merged = new Map<string, EnrichmentBlob>();
  for (const bbl of unique) {
    merged.set(bbl, { ...(acris.get(bbl) ?? {}) });
  }
  return merged;
}
