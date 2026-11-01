import { parse } from "node-html-parser";
import { generateAcrisBblSearchUrl } from "./links";
import { AcrisDistressSignal, acrisDistressLabel, classifyAcrisDistress } from "./acrisDistress";

const BOROUGH_CODE: Record<string, string> = {
  MN: "1", BX: "2", BK: "3", QN: "4", SI: "5",
  "1": "1", "2": "2", "3": "3", "4": "4", "5": "5",
};

const SOCRATA_ENDPOINTS = {
  ACRIS_LEGALS: "https://data.cityofnewyork.us/resource/8h5j-fqxa.json",
  ACRIS_MASTER: "https://data.cityofnewyork.us/resource/bnx9-e6tj.json",
  ACRIS_PARTIES: "https://data.cityofnewyork.us/resource/636b-3b5g.json",
};

function boroughCode(borough: string | null): string {
  return BOROUGH_CODE[(borough ?? "").toUpperCase().trim()] ?? "1";
}

function padBlock(block: string | null) {
  return (block ?? "0").trim().padStart(5, "0");
}
function padLot(lot: string | null) {
  return (lot ?? "0").trim().padStart(4, "0");
}

async function fetchHtml(url: string, timeoutMs = 12000): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function postFormHtml(
  url: string,
  body: URLSearchParams,
  timeoutMs = 12000
): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://a836-acris.nyc.gov/bblsearch/bblsearch.asp",
      },
      body,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── ACRIS ─────────────────────────────────────────────────────────────────────

async function fetchSocrataRows<T>(
  url: string,
  query: Record<string, string>,
  timeoutMs = 12000
): Promise<T[]> {
  const token = process.env.SOCRATA_APP_TOKEN;
  const headers: Record<string, string> = token ? { "X-App-Token": token } : {};
  const params = new URLSearchParams(query);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(`${url}?${params.toString()}`, {
      signal: ctrl.signal,
      headers,
    });
    if (!res.ok) return [];
    return await res.json() as T[];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function quoteSocrata(value: string): string {
  return `'${value.replace(/'/g, "")}'`;
}

export interface AcrisDocument {
  documentId?: string | null;
  type: string;
  date: string;
  party1: string;
  party2: string;
  amount: string | null;
}

export interface AcrisData {
  totalDocuments: number;
  lastSaleDate: string | null;
  lastSaleAmount: string | null;
  lastSaleGrantee: string | null;
  lastSaleGrantor: string | null;
  lastMortgageDate: string | null;
  lastMortgageAmount: string | null;
  recentDocuments: AcrisDocument[];
  distressSignals: AcrisDistressSignal[];
  taxLienCount: number;
  lienCount: number;
  lisPendensCount: number;
  foreclosureCount: number;
  latestDistressDate: string | null;
  sourceUrl: string;
}

export async function scrapeAcris(
  borough: string | null,
  block: string | null,
  lot: string | null
): Promise<AcrisData | null> {
  const socrata = await scrapeAcrisFromSocrata(borough, block, lot);
  if (socrata) return socrata;

  const bcode = boroughCode(borough);
  const bl = (block ?? "0").trim().replace(/^0+/, "") || "0";
  const l = (lot ?? "0").trim().replace(/^0+/, "") || "0";

  const url = generateAcrisBblSearchUrl(borough, block, lot);
  const form = new URLSearchParams({
    hid_borough: bcode,
    hid_borough_name: boroughName(bcode),
    hid_block: bl,
    hid_block_value: bl,
    hid_lot: l,
    hid_lot_value: l,
    hid_unit: "",
    hid_selectdate: "",
    hid_datefromm: "",
    hid_datefromd: "",
    hid_datefromy: "",
    hid_datetom: "",
    hid_datetod: "",
    hid_datetoy: "",
    hid_doctype: "",
    hid_doctype_name: "All Document Classes",
    hid_max_rows: "25",
    hid_page: "1",
    hid_ReqID: "",
    hid_SearchType: "BBL",
    hid_ISIntranet: "N",
    hid_sort: "",
  });

  const html = await postFormHtml("https://a836-acris.nyc.gov/DS/DocumentSearch/BBLResult", form);
  if (!html) return null;

  const root = parse(html);

  const docs: AcrisDocument[] = [];

  for (const tr of root.querySelectorAll("table tr")) {
    const cells = tr
      .querySelectorAll("td")
      .map((td) => td.text.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const doc = parseAcrisRow(cells);
    if (doc.type && doc.date) docs.push(doc);
  }

  // Last deed sale
  const deeds = docs.filter((d) =>
    /^DEED/i.test(d.type) || /^RPTT/i.test(d.type)
  );
  const mortgages = docs.filter((d) => /MORTGAGE|MTGE/i.test(d.type));

  const lastDeed = deeds[0] ?? null;
  const lastMortgage = mortgages[0] ?? null;
  const distressSignals = extractAcrisDistressSignals(docs);

  // Parse total count from page text like "Your search found 42 documents"
  const pageText = root.text;
  const countMatch = pageText.match(/found\s+(\d[\d,]*)\s+document/i);
  const total = countMatch ? parseInt(countMatch[1].replace(/,/g, ""), 10) : docs.length;

  return {
    totalDocuments: total,
    lastSaleDate: lastDeed?.date ?? null,
    lastSaleAmount: lastDeed?.amount ?? null,
    lastSaleGrantor: lastDeed?.party1 ?? null,
    lastSaleGrantee: lastDeed?.party2 ?? null,
    lastMortgageDate: lastMortgage?.date ?? null,
    lastMortgageAmount: lastMortgage?.amount ?? null,
    recentDocuments: docs.slice(0, 8),
    distressSignals,
    taxLienCount: distressSignals.filter((signal) => signal.kind === "tax_lien").length,
    lienCount: distressSignals.filter((signal) => signal.kind === "tax_lien" || signal.kind === "other_lien" || signal.kind === "judgment").length,
    lisPendensCount: distressSignals.filter((signal) => signal.kind === "lis_pendens").length,
    foreclosureCount: distressSignals.filter((signal) => signal.kind === "foreclosure").length,
    latestDistressDate: distressSignals[0]?.date ?? null,
    sourceUrl: url,
  };
}

async function scrapeAcrisFromSocrata(
  borough: string | null,
  block: string | null,
  lot: string | null
): Promise<AcrisData | null> {
  const bcode = boroughCode(borough);
  const bl = String(parseInt((block ?? "0").trim(), 10) || 0);
  const l = String(parseInt((lot ?? "0").trim(), 10) || 0);
  const sourceUrl = generateAcrisBblSearchUrl(borough, block, lot);

  const legals = await fetchSocrataRows<{ document_id?: string }>(
    SOCRATA_ENDPOINTS.ACRIS_LEGALS,
    {
      $select: "document_id",
      $where: `borough='${bcode}' AND block='${bl}' AND lot='${l}'`,
      $limit: "5000",
    }
  );

  const documentIds = Array.from(
    new Set(legals.map((row) => row.document_id).filter((id): id is string => Boolean(id)))
  );
  if (!documentIds.length) return null;

  const lookupDocumentIds = documentIds.slice(0, 500);
  const quotedIds = lookupDocumentIds.map(quoteSocrata).join(",");
  const [master, parties] = await Promise.all([
    fetchSocrataRows<{
      document_id?: string;
      doc_type?: string;
      document_date?: string;
      recorded_datetime?: string;
      document_amt?: string;
    }>(SOCRATA_ENDPOINTS.ACRIS_MASTER, {
      $select: "document_id,doc_type,document_date,recorded_datetime,document_amt",
      $where: `document_id IN(${quotedIds})`,
      $order: "recorded_datetime DESC",
      $limit: "5000",
    }),
    fetchSocrataRows<{
      document_id?: string;
      party_type?: string;
      name?: string;
    }>(SOCRATA_ENDPOINTS.ACRIS_PARTIES, {
      $select: "document_id,party_type,name",
      $where: `document_id IN(${quotedIds}) AND party_type IN('1','2')`,
      $limit: "10000",
    }),
  ]);

  if (!master.length) return null;

  const partyMap = new Map<string, { party1: string; party2: string }>();
  for (const party of parties) {
    if (!party.document_id || !party.name) continue;
    const current = partyMap.get(party.document_id) ?? { party1: "", party2: "" };
    if (party.party_type === "1" && !current.party1) current.party1 = party.name;
    if (party.party_type === "2" && !current.party2) current.party2 = party.name;
    partyMap.set(party.document_id, current);
  }

  const docs = master
    .map((row): AcrisDocument => {
      const partiesForDoc = row.document_id ? partyMap.get(row.document_id) : null;
      return {
        documentId: row.document_id ?? null,
        type: row.doc_type ?? "",
        date: formatSocrataDate(row.document_date ?? row.recorded_datetime ?? ""),
        party1: partiesForDoc?.party1 ?? "",
        party2: partiesForDoc?.party2 ?? "",
        amount: normalizeAmount(row.document_amt),
      };
    })
    .filter((doc) => doc.type && doc.date)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (!docs.length) return null;

  const deeds = docs.filter((d) => /^DEED/i.test(d.type) || /^RPTT/i.test(d.type));
  const mortgages = docs.filter((d) => /MORTGAGE|MTGE|AGMT/i.test(d.type));
  const lastDeed = deeds[0] ?? null;
  const lastMortgage = mortgages[0] ?? null;
  const distressSignals = extractAcrisDistressSignals(docs);

  return {
    totalDocuments: documentIds.length,
    lastSaleDate: lastDeed?.date ?? null,
    lastSaleAmount: lastDeed?.amount ?? null,
    lastSaleGrantor: lastDeed?.party1 ?? null,
    lastSaleGrantee: lastDeed?.party2 ?? null,
    lastMortgageDate: lastMortgage?.date ?? null,
    lastMortgageAmount: lastMortgage?.amount ?? null,
    recentDocuments: docs.slice(0, 8),
    distressSignals,
    taxLienCount: distressSignals.filter((signal) => signal.kind === "tax_lien").length,
    lienCount: distressSignals.filter((signal) => signal.kind === "tax_lien" || signal.kind === "other_lien" || signal.kind === "judgment").length,
    lisPendensCount: distressSignals.filter((signal) => signal.kind === "lis_pendens").length,
    foreclosureCount: distressSignals.filter((signal) => signal.kind === "foreclosure").length,
    latestDistressDate: distressSignals[0]?.date ?? null,
    sourceUrl,
  };
}

function extractAcrisDistressSignals(docs: AcrisDocument[]): AcrisDistressSignal[] {
  return docs
    .map((doc): AcrisDistressSignal | null => {
      const kind = classifyAcrisDistress(doc.type);
      if (!kind) return null;
      return {
        documentId: doc.documentId ?? null,
        type: doc.type,
        date: doc.date || null,
        amount: doc.amount,
        party1: doc.party1,
        party2: doc.party2,
        kind,
        label: acrisDistressLabel(kind),
      };
    })
    .filter((signal): signal is AcrisDistressSignal => signal !== null)
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))
    .slice(0, 12);
}

function formatSocrataDate(value: string): string {
  return value ? value.slice(0, 10) : "";
}

function boroughName(code: string): string {
  return {
    "1": "MANHATTAN",
    "2": "BRONX",
    "3": "BROOKLYN",
    "4": "QUEENS",
    "5": "STATEN ISLAND",
  }[code] ?? "";
}

function parseAcrisRow(cells: string[]): AcrisDocument {
  // BBLResult rows usually contain:
  // CRFN, Lot, Partial, Doc Date, Recorded/File Date, Type, Pages, Party1, Party2, Amount
  if (cells.length >= 10 && looksLikeDocType(cells[5])) {
    return {
      documentId: cells[0] || null,
      type: cells[5],
      date: cells[3] || cells[4] || "",
      party1: cells[7] || "",
      party2: cells[8] || "",
      amount: normalizeAmount(cells[9]),
    };
  }

  // Older ACRIS rows omit the Recorded/File Date column.
  if (cells.length >= 9 && looksLikeDocType(cells[4])) {
    return {
      documentId: cells[0] || null,
      type: cells[4],
      date: cells[3] || "",
      party1: cells[6] || "",
      party2: cells[7] || "",
      amount: normalizeAmount(cells[8]),
    };
  }

  // Defensive fallback for any table shaped as Type | Date | Party1 | Party2 | Amount.
  if (cells.length >= 4 && looksLikeDocType(cells[0])) {
    return {
      documentId: null,
      type: cells[0],
      date: cells[1] || "",
      party1: cells[2] || "",
      party2: cells[3] || "",
      amount: normalizeAmount(cells[4]),
    };
  }

  return { documentId: null, type: "", date: "", party1: "", party2: "", amount: null };
}

function looksLikeDocType(value: string): boolean {
  return /DEED|MORTGAGE|AGREEMENT|LEASE|SATISFACTION|ASSIGNMENT|UCC|POWER OF ATTORNEY/i.test(value);
}

function normalizeAmount(value: string | undefined): string | null {
  if (!value || value === "0") return null;
  return value;
}

// ── DOB BIS ───────────────────────────────────────────────────────────────────

export interface DobData {
  buildingClass: string | null;
  numberOfFloors: string | null;
  numberOfUnits: string | null;
  openViolations: string | null;
  activeJobs: string | null;
  lastPermitDate: string | null;
  certificateOfOccupancy: string | null;
  recentJobs: DobJobRecord[];
  recentPermits: DobPermitRecord[];
  dobViolations: DobViolationRecord[];
  ecbViolations: DobViolationRecord[];
  hpdViolations: HpdViolationRecord[];
  complaints: DobComplaintRecord[];
  certificatesOfOccupancy: DobCertificateRecord[];
  sourceNotes: string[];
  sourceUrl: string;
}

export interface DobJobRecord {
  jobNumber: string | null;
  jobType: string | null;
  status: string | null;
  latestActionDate: string | null;
  description: string | null;
}

export interface DobPermitRecord {
  jobNumber: string | null;
  permitType: string | null;
  workType: string | null;
  status: string | null;
  issuanceDate: string | null;
  expirationDate: string | null;
}

export interface DobViolationRecord {
  number: string | null;
  status: string | null;
  issueDate: string | null;
  type: string | null;
  description: string | null;
}

export interface HpdViolationRecord {
  violationId: string | null;
  status: string | null;
  class: string | null;
  inspectionDate: string | null;
  description: string | null;
}

export interface DobComplaintRecord {
  complaintNumber: string | null;
  status: string | null;
  dateEntered: string | null;
  category: string | null;
  dispositionDate: string | null;
}

export interface DobCertificateRecord {
  jobNumber: string | null;
  issueDate: string | null;
  issueType: string | null;
  status: string | null;
}

export async function scrapeDob(
  borough: string | null,
  block: string | null,
  lot: string | null
): Promise<DobData | null> {
  const bcode = boroughCode(borough);
  const bl = padBlock(block);
  const l = padLot(lot);

  const url = `https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?boro=${bcode}&block=${bl}&lot=${l}`;
  const [html, openData] = await Promise.all([
    fetchHtml(url),
    fetchDobOpenData(bcode, bl, l),
  ]);

  const root = html ? parse(html) : null;

  // BIS overview page has labeled table rows: "Building Class", "# Floors", etc.
  const allText = root?.text ?? "";

  function extract(pattern: RegExp): string | null {
    const m = allText.match(pattern);
    return m ? m[1].trim() : null;
  }

  // BIS page text patterns (labels followed by values in nearby cells)
  const rows = root?.querySelectorAll("table tr") ?? [];
  const kvMap: Record<string, string> = {};
  for (const tr of rows) {
    const cells = tr.querySelectorAll("td");
    if (cells.length >= 2) {
      const key = cells[0].text.trim().toLowerCase().replace(/[^a-z0-9]/g, "_");
      const val = cells[1].text.trim();
      if (key && val) kvMap[key] = val;
    }
  }

  // Fallback regex patterns on raw text
  const openViol = extract(/open\s+violations?\s*[:\-]?\s*(\d+)/i)
    ?? extract(/(\d+)\s+open\s+violation/i)
    ?? kvMap["open_violations"] ?? kvMap["violations_open"] ?? null;

  const floors = extract(/(?:number\s+of\s+)?floors?\s*[:\-]?\s*(\d+)/i)
    ?? kvMap["floors"] ?? kvMap["_floors"] ?? null;

  const units = extract(/(?:number\s+of\s+)?(?:dwelling\s+)?units?\s*[:\-]?\s*(\d+)/i)
    ?? kvMap["dwelling_units"] ?? kvMap["units"] ?? null;

  const bldgCls = extract(/building\s+class\s*[:\-]?\s*([A-Z]\d*)/i)
    ?? kvMap["building_class"] ?? null;

  const activeJobs = extract(/active\s+(?:work\s+)?(?:jobs?|permits?)\s*[:\-]?\s*(\d+)/i)
    ?? String(openData.activeJobs);
  const totalOpenViolations =
    openData.openDobViolationsCount +
    openData.openEcbViolationsCount +
    openData.openHpdViolationsCount;
  const certificateOfOccupancy =
    openData.certificatesOfOccupancy[0]
      ? [openData.certificatesOfOccupancy[0].issueType, openData.certificatesOfOccupancy[0].issueDate]
          .filter(Boolean)
          .join(" ")
      : extract(/certificate\s+of\s+occupancy\s*[:\-]?\s*(\S+)/i);

  return {
    buildingClass: bldgCls,
    numberOfFloors: floors,
    numberOfUnits: units,
    openViolations: totalOpenViolations > 0 ? String(totalOpenViolations) : openViol ?? "0",
    activeJobs: activeJobs,
    lastPermitDate: openData.recentPermits[0]?.issuanceDate ?? null,
    certificateOfOccupancy,
    recentJobs: openData.recentJobs,
    recentPermits: openData.recentPermits,
    dobViolations: openData.dobViolations,
    ecbViolations: openData.ecbViolations,
    hpdViolations: openData.hpdViolations,
    complaints: openData.complaints,
    certificatesOfOccupancy: openData.certificatesOfOccupancy,
    sourceNotes: openData.sourceNotes,
    sourceUrl: url,
  };
}

async function fetchDobOpenData(boro: string, block: string, lot: string) {
  const borough = boroughName(boro);
  const bbl = `${boro}${block}${lot}`;
  const sourceNotes: string[] = [];

  const [jobs, permits, dobViolations, ecbViolations, hpdViolations, complaints, certificates] = await Promise.all([
    fetchDobJobs(borough, block, lot).catch(() => {
      sourceNotes.push("DOB job filings lookup failed.");
      return [];
    }),
    fetchDobPermits(borough, block, lot).catch(() => {
      sourceNotes.push("DOB permit lookup failed.");
      return [];
    }),
    fetchDobViolations(boro, block, lot).catch(() => {
      sourceNotes.push("DOB violations lookup failed.");
      return [];
    }),
    fetchEcbViolations(boro, block, lot).catch(() => {
      sourceNotes.push("ECB violations lookup failed.");
      return [];
    }),
    fetchHpdViolations(boro, block, lot).catch(() => {
      sourceNotes.push("HPD violations lookup failed.");
      return [];
    }),
    fetchDobComplaints(block, lot).catch(() => {
      sourceNotes.push("DOB complaints lookup failed.");
      return [];
    }),
    fetchCertificatesOfOccupancy(bbl).catch(() => {
      sourceNotes.push("Certificate of occupancy lookup failed.");
      return [];
    }),
  ]);

  return {
    activeJobs: uniqueActiveJobCount(jobs),
    recentJobs: jobs.slice(0, 5),
    recentPermits: permits.slice(0, 5),
    openDobViolationsCount: dobViolations.length,
    openEcbViolationsCount: ecbViolations.filter((v) => !/RESOLVE|DISMISSED|CURED/i.test(v.status ?? "")).length,
    openHpdViolationsCount: hpdViolations.filter((v) => /OPEN/i.test(v.status ?? "")).length,
    dobViolations: dobViolations.slice(0, 5),
    ecbViolations: ecbViolations.slice(0, 5),
    hpdViolations: hpdViolations.slice(0, 5),
    complaints: complaints.slice(0, 5),
    certificatesOfOccupancy: certificates.slice(0, 3),
    sourceNotes,
  };
}

function uniqueActiveJobCount(jobs: DobJobRecord[]): number {
  const active = new Set<string>();
  for (const job of jobs) {
    if (/SIGNED OFF|WITHDRAWN|DISAPPROVED/i.test(job.status ?? "")) continue;
    active.add(job.jobNumber ?? `${job.jobType ?? ""}|${job.latestActionDate ?? ""}|${job.description ?? ""}`);
  }
  return active.size;
}

async function fetchDobJobs(borough: string, block: string, lot: string): Promise<DobJobRecord[]> {
  const lot4 = lot.replace(/^0+/, "").padStart(4, "0");
  const lot5 = lot.replace(/^0+/, "").padStart(5, "0");
  const rows = await fetchSocrata<Record<string, unknown>>("https://data.cityofnewyork.us/resource/ic3t-wcy2.json", {
    "$select": "job__,job_type,job_status_descrp,latest_action_date,other_description",
    "$where": `borough='${borough}' and block='${block}' and (lot='${lot4}' or lot='${lot5}')`,
    "$order": "latest_action_date DESC",
    "$limit": "25",
  });
  return rows.map((row) => ({
    jobNumber: valueString(row.job__),
    jobType: valueString(row.job_type),
    status: valueString(row.job_status_descrp),
    latestActionDate: valueString(row.latest_action_date),
    description: valueString(row.other_description),
  }));
}

async function fetchDobPermits(borough: string, block: string, lot: string): Promise<DobPermitRecord[]> {
  const lot4 = lot.replace(/^0+/, "").padStart(4, "0");
  const lot5 = lot.replace(/^0+/, "").padStart(5, "0");
  const rows = await fetchSocrata<Record<string, unknown>>("https://data.cityofnewyork.us/resource/ipu4-2q9a.json", {
    "$select": "job__,permit_type,work_type,permit_status,issuance_date,expiration_date",
    "$where": `borough='${borough}' and block='${block}' and (lot='${lot4}' or lot='${lot5}')`,
    "$order": "issuance_date DESC",
    "$limit": "25",
  });
  return rows.map((row) => ({
    jobNumber: valueString(row.job__),
    permitType: valueString(row.permit_type),
    workType: valueString(row.work_type),
    status: valueString(row.permit_status),
    issuanceDate: valueString(row.issuance_date),
    expirationDate: valueString(row.expiration_date),
  }));
}

async function fetchDobViolations(boro: string, block: string, lot: string): Promise<DobViolationRecord[]> {
  const lot4 = lot.replace(/^0+/, "").padStart(4, "0");
  const lot5 = lot.replace(/^0+/, "").padStart(5, "0");
  const rows = await fetchSocrata<Record<string, unknown>>("https://data.cityofnewyork.us/resource/3h2n-5cm9.json", {
    "$select": "number,violation_category,issue_date,violation_type,description",
    "$where": `boro='${boro}' and block='${block}' and (lot='${lot4}' or lot='${lot5}') and violation_category NOT LIKE '%RESOLVED%' and violation_category NOT LIKE '%DISMISSED%'`,
    "$order": "issue_date DESC",
    "$limit": "5000",
  });
  return rows.map((row) => ({
    number: valueString(row.number),
    status: valueString(row.violation_category),
    issueDate: formatDobDate(valueString(row.issue_date)),
    type: valueString(row.violation_type),
    description: valueString(row.description),
  }));
}

async function fetchEcbViolations(boro: string, block: string, lot: string): Promise<DobViolationRecord[]> {
  const rows = await fetchSocrata<Record<string, unknown>>("https://data.cityofnewyork.us/resource/6bgk-3dad.json", {
    "$select": "ecb_violation_number,ecb_violation_status,issue_date,violation_type,violation_description",
    "$where": `boro='${boro}' and block='${block}' and lot='${lot}'`,
    "$order": "issue_date DESC",
    "$limit": "25",
  });
  return rows.map((row) => ({
    number: valueString(row.ecb_violation_number),
    status: valueString(row.ecb_violation_status),
    issueDate: formatDobDate(valueString(row.issue_date)),
    type: valueString(row.violation_type),
    description: valueString(row.violation_description),
  }));
}

async function fetchHpdViolations(boro: string, block: string, lot: string): Promise<HpdViolationRecord[]> {
  const rows = await fetchSocrata<Record<string, unknown>>("https://data.cityofnewyork.us/resource/wvxf-dwi5.json", {
    "$select": "violationid,currentstatus,class,inspectiondate,novdescription",
    "$where": `boroid='${boro}' and block='${Number(block)}' and lot='${Number(lot)}'`,
    "$order": "inspectiondate DESC",
    "$limit": "25",
  });
  return rows.map((row) => ({
    violationId: valueString(row.violationid),
    status: valueString(row.currentstatus),
    class: valueString(row.class),
    inspectionDate: valueString(row.inspectiondate)?.slice(0, 10) ?? null,
    description: valueString(row.novdescription),
  }));
}

async function fetchDobComplaints(block: string, lot: string): Promise<DobComplaintRecord[]> {
  const rows = await fetchSocrata<Record<string, unknown>>("https://data.cityofnewyork.us/resource/eabe-havv.json", {
    "$select": "complaint_number,status,date_entered,complaint_category,disposition_date",
    "$where": `block='${block}' and lot='${lot}'`,
    "$order": "date_entered DESC",
    "$limit": "25",
  });
  return rows.map((row) => ({
    complaintNumber: valueString(row.complaint_number),
    status: valueString(row.status),
    dateEntered: valueString(row.date_entered),
    category: valueString(row.complaint_category),
    dispositionDate: valueString(row.disposition_date),
  }));
}

async function fetchCertificatesOfOccupancy(bbl: string): Promise<DobCertificateRecord[]> {
  const rows = await fetchSocrata<Record<string, unknown>>("https://data.cityofnewyork.us/resource/bs8b-p36w.json", {
    "$select": "job_number,c_o_issue_date,issue_type,application_status_raw",
    "$where": `bbl='${bbl}'`,
    "$order": "c_o_issue_date DESC",
    "$limit": "10",
  });
  return rows.map((row) => ({
    jobNumber: valueString(row.job_number),
    issueDate: valueString(row.c_o_issue_date)?.slice(0, 10) ?? null,
    issueType: valueString(row.issue_type),
    status: valueString(row.application_status_raw),
  }));
}

async function fetchSocrata<T>(baseUrl: string, params: Record<string, string>): Promise<T[]> {
  const query = new URLSearchParams(params);
  return fetchJsonArray<T>(`${baseUrl}?${query.toString()}`);
}

function formatDobDate(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{8}$/.test(value)) return `${value.slice(4, 6)}/${value.slice(6, 8)}/${value.slice(0, 4)}`;
  return value;
}

// ── ZoLa / NYC Planning Labs API ─────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// Parcel-level enrichment: ACRIS + DOB for a single lot
// ─────────────────────────────────────────────────────────────────────────────

export interface EnrichmentResult {
  acris: AcrisData | null;
  dob: DobData | null;
  summary: string;
  scrapedAt: number;
}

function buildSummary({
  acris,
  dob,
  address,
}: {
  acris: AcrisData | null;
  dob: DobData | null;
  address: string | null;
}): string {
  const lines: string[] = [];

  if (address) lines.push(`Property: ${address}`);

  if (acris) {
    if (acris.lastSaleDate && acris.lastSaleAmount) {
      lines.push(`Last sale: ${acris.lastSaleDate} — ${acris.lastSaleAmount} (${acris.lastSaleGrantor ?? "?"} → ${acris.lastSaleGrantee ?? "?"})`);
    } else if (acris.lastSaleDate) {
      lines.push(`Last deed: ${acris.lastSaleDate} (${acris.lastSaleGrantor ?? "?"} → ${acris.lastSaleGrantee ?? "?"})`);
    }
    if (acris.lastMortgageDate) {
      lines.push(`Last mortgage: ${acris.lastMortgageDate}${acris.lastMortgageAmount ? ` — ${acris.lastMortgageAmount}` : ""}`);
    }
    if (acris.distressSignals.length > 0) {
      const counts = [
        acris.taxLienCount ? `${acris.taxLienCount} tax lien` : null,
        acris.lienCount > acris.taxLienCount ? `${acris.lienCount} lien/judgment` : null,
        acris.lisPendensCount ? `${acris.lisPendensCount} lis pendens` : null,
        acris.foreclosureCount ? `${acris.foreclosureCount} foreclosure` : null,
      ].filter(Boolean).join(", ");
      lines.push(`ACRIS distress filings: ${counts || `${acris.distressSignals.length} filing(s)`}${acris.latestDistressDate ? `; latest ${acris.latestDistressDate}` : ""}`);
    }
    lines.push(`ACRIS documents on file: ${acris.totalDocuments}`);
  } else {
    lines.push("ACRIS: could not retrieve data");
  }

  if (dob) {
    const dobParts: string[] = [];
    const floors = positiveNumberText(dob.numberOfFloors);
    const units = positiveNumberText(dob.numberOfUnits);
    if (floors) dobParts.push(`${floors} floors`);
    if (units) dobParts.push(`${units} units`);
    if (dobParts.length > 0) lines.push(`DOB profile: ${dobParts.join(", ")}`);
    if (dob.openViolations != null) {
      lines.push(`Open violations: ${dob.openViolations}`);
    }
    if (dob.activeJobs) lines.push(`Active jobs/permits: ${dob.activeJobs}`);
    if (dob.lastPermitDate) lines.push(`Last DOB permit: ${dob.lastPermitDate}`);
    if (dob.certificatesOfOccupancy.length > 0) {
      const co = dob.certificatesOfOccupancy[0];
      lines.push(`Certificate of occupancy: ${[co.issueType, co.issueDate, co.status].filter(Boolean).join(" | ")}`);
    } else if (dob.certificateOfOccupancy) {
      lines.push(`Certificate of occupancy: ${dob.certificateOfOccupancy}`);
    }
    if (dob.recentJobs.length > 0) {
      const job = dob.recentJobs[0];
      lines.push(`Latest DOB job: ${job.jobNumber ?? "unknown"} ${job.jobType ?? ""} ${job.status ?? ""} ${job.latestActionDate ?? ""}`.trim());
    }
  } else {
    lines.push("DOB BIS: could not retrieve data");
  }

  return lines.join("\n");
}

function positiveNumberText(value: string | null): string | null {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? value : null;
}

export async function enrichParcel(
  borough: string | null,
  block: string | null,
  lot: string | null,
  address: string | null,
  _owner: string | null = null
): Promise<EnrichmentResult> {
  const [acris, dob] = await Promise.all([
    scrapeAcris(borough, block, lot),
    scrapeDob(borough, block, lot),
  ]);

  return {
    acris,
    dob,
    summary: buildSummary({ acris, dob, address }),
    scrapedAt: Date.now(),
  };
}

async function fetchJsonArray<T>(url: string): Promise<T[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data as T[] : [];
  } finally {
    clearTimeout(timer);
  }
}

function valueString(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

function parseNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

