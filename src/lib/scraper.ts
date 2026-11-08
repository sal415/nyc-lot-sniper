import { parse } from "node-html-parser";
import { generateAcrisBblSearchUrl } from "./links";
import { AcrisDistressSignal, acrisDistressLabel, classifyAcrisDistress } from "./acrisDistress";
import { fetchRecentPropertyNews, PropertyNewsContext } from "./propertyNews";

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

export interface ZolaData {
  zoningDistrict: string | null;
  overlays: string | null;
  specialPurposeDistrict: string | null;
  landmarkStatus: string | null;
  floodZone: string | null;
  historicDistrict: string | null;
  latitude: number | null;
  longitude: number | null;
  parcelAddress: string | null;
  rawApiData: Record<string, unknown> | null;
  sourceUrl: string;
}

export interface NearbyPlace {
  name: string;
  category: string;
  distanceMeters: number;
  distanceMiles: number;
  detail: string | null;
  latitude: number | null;
  longitude: number | null;
  sourceUrl: string;
}

export interface NearbyContext {
  transit: NearbyPlace[];
  schools: NearbyPlace[];
  sourceNotes: string[];
}

export interface SaleComp {
  bbl: string | null;
  address: string | null;
  neighborhood: string | null;
  buildingClassCategory: string | null;
  salePrice: number | null;
  saleDate: string | null;
  landSquareFeet: number | null;
  grossSquareFeet: number | null;
  pricePerLandSf: number | null;
  distanceMiles: number | null;
}

export interface TaxAssessment {
  taxClass: string | null;
  buildingClass: string | null;
  marketValue: number | null;
  assessedTotal: number | null;
  assessedLand: number | null;
  exemptionTotal: number | null;
  year: string | null;
  period: string | null;
  sourceUrl: string;
}

export interface MarketContext {
  assessment: TaxAssessment | null;
  subjectSales: SaleComp[];
  nearbySales: SaleComp[];
  medianNearbyPricePerLandSf: number | null;
  sourceNotes: string[];
}

export interface AssemblageParcel {
  bbl: string;
  address: string | null;
  owner: string | null;
  lotArea: number | null;
  builtFar: number | null;
  residFar: number | null;
  zoning: string | null;
  estimatedUnusedBuildableSf: number | null;
}

export interface AssemblageContext {
  sameOwnerSameBlock: AssemblageParcel[];
  immediateNeighbors: AssemblageParcel[];
  sameBlockUnderbuilt: AssemblageParcel[];
  potentialCombinedLotArea: number | null;
  potentialCombinedUnusedSf: number | null;
  sourceUrl: string;
  sourceNotes: string[];
}

export interface DistressCharge {
  code: string | null;
  accountType: string | null;
  balance: number | null;
  liability: number | null;
  dueDate: string | null;
  taxYear: string | null;
}

export interface DistressContext {
  openChargeBalance: number | null;
  charges: DistressCharge[];
  hasOpenCharges: boolean;
  sourceUrl: string;
  sourceNotes: string[];
}

export interface HpdRegistration {
  registrationId: string | null;
  buildingId: string | null;
  lastRegistrationDate: string | null;
  registrationEndDate: string | null;
  contacts: string[];
}

export interface RegulatoryContext {
  hpdRegistration: HpdRegistration | null;
  isHpdRegistered: boolean;
  registrationRiskNote: string | null;
  sourceUrl: string;
  sourceNotes: string[];
}

export interface DevelopmentJob {
  jobNumber: string | null;
  address: string | null;
  jobType: string | null;
  status: string | null;
  latestActionDate: string | null;
  proposedStories: number | null;
  proposedDwellingUnits: number | null;
  constructionFloorArea: number | null;
  distanceMiles: number | null;
}

export interface DevelopmentMomentumContext {
  nearbyJobs: DevelopmentJob[];
  activeNearbyJobs: number;
  totalProposedUnits: number | null;
  largestNearbyJob: DevelopmentJob | null;
  sourceUrl: string;
  sourceNotes: string[];
}

export async function scrapeZola(
  borough: string | null,
  block: string | null,
  lot: string | null
): Promise<ZolaData | null> {
  const bcode = boroughCode(borough);
  const bl = (block ?? "0").trim().replace(/^0+/, "") || "0";
  const l = (lot ?? "0").trim().replace(/^0+/, "") || "0";
  const bbl = `${bcode}${bl.padStart(5, "0")}${l.padStart(4, "0")}`;

  const zolaUrl = `https://zola.planning.nyc.gov/lot/${bcode}/${bl}/${l}`;

  // ZoLa's current app reads parcel facts from CARTO's dcp_mappluto table.
  // The previous /api/lot route now serves the HTML app shell instead of JSON.
  const sql = `
    SELECT address, bbl, borocode, borough, block, lot,
      ownername, bldgclass, lotarea, builtfar, residfar, commfar, facilfar, yearbuilt,
      zonedist1, zonedist2, zonedist3, zonedist4,
      overlay1, overlay2,
      spdist1, spdist2, spdist3,
      histdist, landmark,
      ST_Y(ST_Centroid(the_geom)) as latitude,
      ST_X(ST_Centroid(the_geom)) as longitude
    FROM dcp_mappluto
    WHERE bbl=${bbl}
  `;

  const rawData = await fetchCartoRows(sql);
  const row = rawData?.rows?.[0] ?? null;

  if (row) {
    return {
      zoningDistrict: joinFields(row, "zonedist1", "zonedist2", "zonedist3", "zonedist4"),
      overlays: joinFields(row, "overlay1", "overlay2"),
      specialPurposeDistrict: joinFields(row, "spdist1", "spdist2", "spdist3"),
      landmarkStatus: strField(row, "landmark"),
      floodZone: null,
      historicDistrict: strField(row, "histdist"),
      latitude: numField(row, "latitude"),
      longitude: numField(row, "longitude"),
      parcelAddress: strField(row, "address"),
      rawApiData: rawData,
      sourceUrl: zolaUrl,
    };
  }

  // Fallback: try the NYC GeoSearch API for basic lot confirmation
  const geoUrl = `https://geosearch.planninglabs.nyc/v2/search?text=BBL+${bcode}${padBlock(block)}${padLot(lot)}`;
  let geoData: Record<string, unknown> | null = null;
  try {
    const res = await fetch(geoUrl, { headers: { Accept: "application/json" } });
    if (res.ok) geoData = await res.json() as Record<string, unknown>;
  } catch {
    geoData = null;
  }

  // Even if both API calls fail, return a stub so the UI knows it was attempted
  return {
    zoningDistrict: null,
    overlays: null,
    specialPurposeDistrict: null,
    landmarkStatus: null,
    floodZone: null,
    historicDistrict: null,
    latitude: null,
    longitude: null,
    parcelAddress: null,
    rawApiData: geoData,
    sourceUrl: zolaUrl,
  };
}

async function fetchCartoRows(sql: string): Promise<{ rows: Record<string, unknown>[] } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const q = encodeURIComponent(sql.replace(/\s+/g, " ").trim());
    const res = await fetch(`https://planninglabs.carto.com/api/v2/sql?q=${q}&format=json`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json() as { rows?: Record<string, unknown>[] };
    return Array.isArray(data.rows) ? { rows: data.rows } : null;
  } catch {
    return null;
  }
}

function strField(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    // case-insensitive key lookup
    const matchKey = Object.keys(obj).find(
      (ok) => ok.toLowerCase() === k.toLowerCase()
    );
    if (matchKey && obj[matchKey] != null && obj[matchKey] !== "") {
      return String(obj[matchKey]);
    }
  }
  return null;
}

function numField(obj: Record<string, unknown>, ...keys: string[]): number | null {
  const value = strField(obj, ...keys);
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function joinFields(obj: Record<string, unknown>, ...keys: string[]): string | null {
  const values = keys
    .map((key) => strField(obj, key))
    .filter((value): value is string => Boolean(value));

  return values.length > 0 ? values.join(", ") : null;
}

// ── Full enrichment ───────────────────────────────────────────────────────────

export interface EnrichmentResult {
  acris: AcrisData | null;
  dob: DobData | null;
  zola: ZolaData | null;
  nearby: NearbyContext | null;
  market: MarketContext | null;
  assemblage: AssemblageContext | null;
  distress: DistressContext | null;
  regulatory: RegulatoryContext | null;
  development: DevelopmentMomentumContext | null;
  recentNews: PropertyNewsContext | null;
  summary: string;
  scrapedAt: number;
}

export async function enrichParcel(
  borough: string | null,
  block: string | null,
  lot: string | null,
  address: string | null,
  owner: string | null = null
): Promise<EnrichmentResult> {
  // Run scrapes in parallel
  const [acris, dob, zola] = await Promise.all([
    scrapeAcris(borough, block, lot),
    scrapeDob(borough, block, lot),
    scrapeZola(borough, block, lot),
  ]);

  const nearby = await scrapeNearbyContext(zola?.latitude ?? null, zola?.longitude ?? null);
  const [market, assemblage, distress, regulatory, development, recentNews] = await Promise.all([
    scrapeMarketContext(borough, block, lot, zola?.latitude ?? null, zola?.longitude ?? null),
    scrapeAssemblageContext(borough, block, lot, owner),
    scrapeDistressContext(borough, block, lot),
    scrapeRegulatoryContext(borough, block, lot, dob?.numberOfUnits ?? null),
    scrapeDevelopmentMomentumContext(borough, zola?.latitude ?? null, zola?.longitude ?? null),
    fetchRecentPropertyNews({
      address,
      bbl: `${boroughCode(borough)}${padBlock(block)}${padLot(lot)}`,
      borough,
      block,
      lot,
      owner,
    }),
  ]);
  const summary = buildSummary({ acris, dob, zola, nearby, market, assemblage, distress, regulatory, development, recentNews, address });

  return {
    acris,
    dob,
    zola,
    nearby,
    market,
    assemblage,
    distress,
    regulatory,
    development,
    recentNews,
    summary,
    scrapedAt: Date.now(),
  };
}

export async function scrapeNearbyContext(
  latitude: number | null,
  longitude: number | null
): Promise<NearbyContext | null> {
  if (latitude == null || longitude == null) return null;

  const sourceNotes: string[] = [];
  const [transit, schools] = await Promise.all([
    fetchNearbyTransit(latitude, longitude).catch(() => {
      sourceNotes.push("Transit lookup failed.");
      return [];
    }),
    fetchNearbySchools(latitude, longitude).catch(() => {
      sourceNotes.push("School lookup failed.");
      return [];
    }),
  ]);

  return {
    transit,
    schools,
    sourceNotes,
  };
}

async function fetchNearbyTransit(latitude: number, longitude: number): Promise<NearbyPlace[]> {
  const url = buildSocrataBoxUrl("https://data.ny.gov/resource/i9wp-a4ja.json", latitude, longitude, 1600, "entrance_latitude", "entrance_longitude", [
    "stop_name",
    "daytime_routes",
    "entrance_type",
    "entrance_latitude",
    "entrance_longitude",
    "complex_id",
  ]);
  const rows = await fetchJsonArray<Record<string, unknown>>(url);
  const byStation = new Map<string, NearbyPlace>();

  for (const row of rows) {
    const lat = parseNumber(row.entrance_latitude);
    const lon = parseNumber(row.entrance_longitude);
    const name = valueString(row.stop_name);
    if (lat == null || lon == null || !name) continue;

    const distanceMeters = haversineMeters(latitude, longitude, lat, lon);
    const place: NearbyPlace = {
      name,
      category: "Subway",
      distanceMeters,
      distanceMiles: metersToMiles(distanceMeters),
      detail: [valueString(row.daytime_routes), valueString(row.entrance_type)].filter(Boolean).join(" | ") || null,
      latitude: lat,
      longitude: lon,
      sourceUrl: "https://data.ny.gov/resource/i9wp-a4ja",
    };
    const key = valueString(row.complex_id) || name;
    const existing = byStation.get(key);
    if (!existing || place.distanceMeters < existing.distanceMeters) byStation.set(key, place);
  }

  return [...byStation.values()].sort(byDistance).slice(0, 5);
}

async function fetchNearbySchools(latitude: number, longitude: number): Promise<NearbyPlace[]> {
  // This dataset stores latitude/longitude as text, so Socrata numeric bounding
  // filters are unreliable. The open-school list is small enough to fetch and
  // sort locally.
  const params = new URLSearchParams({
    "$select": [
      "location_name",
      "location_category_description",
      "grades_final_text",
      "primary_address_line_1",
      "latitude",
      "longitude",
      "status_descriptions",
    ].join(","),
    "$where": "status_descriptions='Open'",
    "$limit": "5000",
  });
  const url = `https://data.cityofnewyork.us/resource/wg9x-4ke6.json?${params.toString()}`;
  const rows = await fetchJsonArray<Record<string, unknown>>(url);

  return rows
    .map((row): NearbyPlace | null => {
      const lat = parseNumber(row.latitude);
      const lon = parseNumber(row.longitude);
      const name = valueString(row.location_name);
      if (lat == null || lon == null || !name) return null;
      const distanceMeters = haversineMeters(latitude, longitude, lat, lon);
      return {
        name,
        category: valueString(row.location_category_description) || "School",
        distanceMeters,
        distanceMiles: metersToMiles(distanceMeters),
        detail: [valueString(row.grades_final_text), valueString(row.primary_address_line_1)].filter(Boolean).join(" | ") || null,
        latitude: lat,
        longitude: lon,
        sourceUrl: "https://data.cityofnewyork.us/resource/wg9x-4ke6",
      };
    })
    .filter((place): place is NearbyPlace => Boolean(place))
    .filter((place) => place.distanceMeters <= 1600)
    .sort(byDistance)
    .slice(0, 5);
}

export async function scrapeMarketContext(
  borough: string | null,
  block: string | null,
  lot: string | null,
  latitude: number | null,
  longitude: number | null
): Promise<MarketContext | null> {
  const bcode = boroughCode(borough);
  const bbl = `${bcode}${padBlock(block)}${padLot(lot)}`;
  const sourceNotes: string[] = [];

  const [assessment, subjectSales, nearbySales] = await Promise.all([
    fetchAssessment(bbl).catch(() => {
      sourceNotes.push("Assessment lookup failed.");
      return null;
    }),
    fetchSubjectSales(bbl).catch(() => {
      sourceNotes.push("Subject sales lookup failed.");
      return [];
    }),
    latitude != null && longitude != null
      ? fetchNearbySales(bcode, latitude, longitude).catch(() => {
          sourceNotes.push("Nearby sales lookup failed.");
          return [];
        })
      : Promise.resolve([]),
  ]);

  const pricePerLandSf = nearbySales
    .map((sale) => sale.pricePerLandSf)
    .filter((value): value is number => value != null && Number.isFinite(value));

  return {
    assessment,
    subjectSales,
    nearbySales,
    medianNearbyPricePerLandSf: median(pricePerLandSf),
    sourceNotes,
  };
}

async function fetchAssessment(bbl: string): Promise<TaxAssessment | null> {
  const rows = await fetchSocrata<Record<string, unknown>>("https://data.cityofnewyork.us/resource/yjxr-fw8i.json", {
    "$select": "bble,owner,taxclass,bldgcl,fullval,avtot,avland,extot,year,period,valtype",
    "$where": `bble='${bbl}'`,
    "$order": "year DESC",
    "$limit": "1",
  });
  const row = rows[0];
  if (!row) return null;
  return {
    taxClass: valueString(row.taxclass),
    buildingClass: valueString(row.bldgcl),
    marketValue: parseNumber(row.fullval),
    assessedTotal: parseNumber(row.avtot),
    assessedLand: parseNumber(row.avland),
    exemptionTotal: parseNumber(row.extot),
    year: valueString(row.year),
    period: valueString(row.period),
    sourceUrl: "https://data.cityofnewyork.us/resource/yjxr-fw8i",
  };
}

async function fetchSubjectSales(bbl: string): Promise<SaleComp[]> {
  const rows = await fetchSocrata<Record<string, unknown>>("https://data.cityofnewyork.us/resource/w2pb-icbu.json", {
    "$select": "bbl,address,neighborhood,building_class_category,sale_price,sale_date,land_square_feet,gross_square_feet,latitude,longitude",
    "$where": `bbl='${bbl}' and sale_price > 0`,
    "$order": "sale_date DESC",
    "$limit": "10",
  });
  return rows.map((row) => saleFromRow(row, null, null));
}

async function fetchNearbySales(boroughCodeValue: string, latitude: number, longitude: number): Promise<SaleComp[]> {
  const radiusMeters = 1600;
  const latDelta = radiusMeters / 111320;
  const lonDelta = radiusMeters / (111320 * Math.max(Math.cos(latitude * Math.PI / 180), 0.2));
  const rows = await fetchSocrata<Record<string, unknown>>("https://data.cityofnewyork.us/resource/w2pb-icbu.json", {
    "$select": "bbl,address,neighborhood,building_class_category,sale_price,sale_date,land_square_feet,gross_square_feet,latitude,longitude",
    "$where": [
      `borough='${boroughCodeValue}'`,
      "sale_price > 0",
      `latitude between ${latitude - latDelta} and ${latitude + latDelta}`,
      `longitude between ${longitude - lonDelta} and ${longitude + lonDelta}`,
    ].join(" and "),
    "$order": "sale_date DESC",
    "$limit": "200",
  });

  return rows
    .map((row) => saleFromRow(row, latitude, longitude))
    .filter((sale) => sale.distanceMiles == null || sale.distanceMiles <= 1)
    .filter((sale) => sale.landSquareFeet != null && sale.landSquareFeet > 0)
    .slice(0, 8);
}

function saleFromRow(row: Record<string, unknown>, latitude: number | null, longitude: number | null): SaleComp {
  const salePrice = parseNumber(row.sale_price);
  const landSf = parseNumber(row.land_square_feet);
  const lat = parseNumber(row.latitude);
  const lon = parseNumber(row.longitude);
  const distanceMeters = latitude != null && longitude != null && lat != null && lon != null
    ? haversineMeters(latitude, longitude, lat, lon)
    : null;

  return {
    bbl: valueString(row.bbl),
    address: valueString(row.address),
    neighborhood: valueString(row.neighborhood),
    buildingClassCategory: valueString(row.building_class_category),
    salePrice,
    saleDate: valueString(row.sale_date)?.slice(0, 10) ?? null,
    landSquareFeet: landSf,
    grossSquareFeet: parseNumber(row.gross_square_feet),
    pricePerLandSf: salePrice != null && landSf != null && landSf > 0
      ? Math.round(salePrice / landSf)
      : null,
    distanceMiles: distanceMeters == null ? null : metersToMiles(distanceMeters),
  };
}

export async function scrapeAssemblageContext(
  borough: string | null,
  block: string | null,
  lot: string | null,
  owner: string | null
): Promise<AssemblageContext | null> {
  const bcode = boroughCode(borough);
  const bl = (block ?? "0").trim().replace(/^0+/, "") || "0";
  const lotNum = Number((lot ?? "0").trim().replace(/^0+/, "") || "0");
  const subjectBbl = `${bcode}${padBlock(block)}${padLot(lot)}`;
  const sql = `
    SELECT bbl, address, ownername, lot, lotarea, builtfar, residfar, zonedist1
    FROM dcp_mappluto
    WHERE borocode=${bcode} AND block=${bl}
  `;
  const rawData = await fetchCartoRows(sql);
  const rows = rawData?.rows ?? [];
  if (rows.length === 0) return null;

  const subjectOwner = normalizeOwner(owner);
  const parcels = rows.map(assemblageParcelFromRow);
  const sameOwnerSameBlock = subjectOwner
    ? parcels.filter((parcel) => normalizeOwner(parcel.owner) === subjectOwner && parcel.bbl !== subjectBbl)
    : [];
  const immediateNeighbors = rows
    .filter((row) => Math.abs((parseNumber(row.lot) ?? -999999) - lotNum) <= 2 && (parseNumber(row.lot) ?? -999999) !== lotNum)
    .map(assemblageParcelFromRow)
    .slice(0, 6);
  const sameBlockUnderbuilt = parcels
    .filter((parcel) => parcel.bbl !== subjectBbl)
    .filter((parcel) => (parcel.estimatedUnusedBuildableSf ?? 0) > 2500)
    .sort((a, b) => (b.estimatedUnusedBuildableSf ?? 0) - (a.estimatedUnusedBuildableSf ?? 0))
    .slice(0, 6);

  const combined = uniqueAssemblageParcels([...sameOwnerSameBlock, ...immediateNeighbors]);

  return {
    sameOwnerSameBlock,
    immediateNeighbors,
    sameBlockUnderbuilt,
    potentialCombinedLotArea: sumNullable(combined.map((parcel) => parcel.lotArea)),
    potentialCombinedUnusedSf: sumNullable(combined.map((parcel) => parcel.estimatedUnusedBuildableSf)),
    sourceUrl: "https://planninglabs.carto.com/api/v2/sql",
    sourceNotes: [],
  };
}

export async function scrapeDistressContext(
  borough: string | null,
  block: string | null,
  lot: string | null
): Promise<DistressContext | null> {
  const bbl = `${boroughCode(borough)}${padBlock(block)}${padLot(lot)}`;
  const sourceNotes: string[] = [];
  const rows = await fetchSocrata<Record<string, unknown>>("https://data.cityofnewyork.us/resource/scjx-j6np.json", {
    "$select": "code,type_acct,sum_bal,sum_liab,due_date,taxyear",
    "$where": `parid='${bbl}' and sum_bal > 0`,
    "$order": "due_date DESC",
    "$limit": "25",
  }).catch(() => {
    sourceNotes.push("Property charges lookup failed.");
    return [];
  });

  const charges = uniqueCharges(rows.map((row) => ({
    code: valueString(row.code),
    accountType: valueString(row.type_acct),
    balance: parseNumber(row.sum_bal),
    liability: parseNumber(row.sum_liab),
    dueDate: valueString(row.due_date)?.slice(0, 10) ?? null,
    taxYear: valueString(row.taxyear),
  })));
  const openChargeBalance = sumNullable(charges.map((charge) => charge.balance));

  return {
    openChargeBalance,
    charges: charges.slice(0, 6),
    hasOpenCharges: (openChargeBalance ?? 0) > 0,
    sourceUrl: "https://data.cityofnewyork.us/resource/scjx-j6np",
    sourceNotes,
  };
}

function uniqueCharges(charges: DistressCharge[]): DistressCharge[] {
  const seen = new Set<string>();
  return charges.filter((charge) => {
    const key = `${charge.code}|${charge.accountType}|${charge.balance}|${charge.dueDate}|${charge.taxYear}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function scrapeRegulatoryContext(
  borough: string | null,
  block: string | null,
  lot: string | null,
  unitCount: string | null
): Promise<RegulatoryContext | null> {
  const boro = boroughCode(borough);
  const sourceNotes: string[] = [];
  const rows = await fetchSocrata<Record<string, unknown>>("https://data.cityofnewyork.us/resource/tesw-yqqr.json", {
    "$select": "registrationid,buildingid,lastregistrationdate,registrationenddate",
    "$where": `boroid='${boro}' and block='${Number(block ?? 0)}' and lot='${Number(lot ?? 0)}'`,
    "$order": "lastregistrationdate DESC",
    "$limit": "1",
  }).catch(() => {
    sourceNotes.push("HPD registration lookup failed.");
    return [];
  });

  const row = rows[0];
  const registrationId = row ? valueString(row.registrationid) : null;
  const contacts = registrationId ? await fetchHpdRegistrationContacts(registrationId).catch(() => {
    sourceNotes.push("HPD registration contacts lookup failed.");
    return [];
  }) : [];
  const units = parseNumber(unitCount);
  const riskNote = row
    ? "HPD multiple dwelling registration found; confirm legal occupancy and tenant status."
    : units != null && units >= 3
      ? "No HPD registration found despite 3+ reported units; verify registration and legal occupancy."
      : "No HPD registration found; this is common for true owner-occupied 1-2 family properties but should be verified for rentals.";

  return {
    hpdRegistration: row ? {
      registrationId,
      buildingId: valueString(row.buildingid),
      lastRegistrationDate: valueString(row.lastregistrationdate)?.slice(0, 10) ?? null,
      registrationEndDate: valueString(row.registrationenddate)?.slice(0, 10) ?? null,
      contacts,
    } : null,
    isHpdRegistered: Boolean(row),
    registrationRiskNote: riskNote,
    sourceUrl: "https://data.cityofnewyork.us/resource/tesw-yqqr",
    sourceNotes,
  };
}

async function fetchHpdRegistrationContacts(registrationId: string): Promise<string[]> {
  const rows = await fetchSocrata<Record<string, unknown>>("https://data.cityofnewyork.us/resource/feu5-w2e2.json", {
    "$select": "type,contactdescription,corporationname,businesshousenumber,businessstreetname,businesscity,businessstate,businesszip",
    "$where": `registrationid='${registrationId}'`,
    "$limit": "8",
  });
  return rows.map((row) => [
    valueString(row.type),
    valueString(row.contactdescription),
    valueString(row.corporationname),
    [valueString(row.businesshousenumber), valueString(row.businessstreetname), valueString(row.businesscity), valueString(row.businessstate), valueString(row.businesszip)]
      .filter(Boolean)
      .join(" "),
  ].filter(Boolean).join(" | "));
}

export async function scrapeDevelopmentMomentumContext(
  borough: string | null,
  latitude: number | null,
  longitude: number | null
): Promise<DevelopmentMomentumContext | null> {
  if (latitude == null || longitude == null) return null;
  const sourceNotes: string[] = [];
  const boroughNameValue = boroughName(boroughCode(borough));
  const rows = await fetchSocrata<Record<string, unknown>>("https://data.cityofnewyork.us/resource/ic3t-wcy2.json", {
    "$select": "job__,house__,street_name,job_type,job_status_descrp,latest_action_date,proposed_no_of_stories,proposed_dwelling_units,total_construction_floor_area,gis_latitude,gis_longitude",
    "$where": `borough='${boroughNameValue}' and gis_latitude IS NOT NULL and gis_longitude IS NOT NULL`,
    "$order": "latest_action_date DESC",
    "$limit": "5000",
  }).catch(() => {
    sourceNotes.push("Nearby DOB jobs lookup failed.");
    return [];
  });

  const nearbyJobs = rows
    .map((row): DevelopmentJob | null => {
      const lat = parseNumber(row.gis_latitude);
      const lon = parseNumber(row.gis_longitude);
      if (lat == null || lon == null) return null;
      const distanceMeters = haversineMeters(latitude, longitude, lat, lon);
      if (distanceMeters > 1600) return null;
      return {
        jobNumber: valueString(row.job__),
        address: [valueString(row.house__), valueString(row.street_name)].filter(Boolean).join(" ") || null,
        jobType: valueString(row.job_type),
        status: valueString(row.job_status_descrp),
        latestActionDate: cleanDateString(valueString(row.latest_action_date)),
        proposedStories: parseNumber(row.proposed_no_of_stories),
        proposedDwellingUnits: parseNumber(row.proposed_dwelling_units),
        constructionFloorArea: parseNumber(row.total_construction_floor_area),
        distanceMiles: metersToMiles(distanceMeters),
      };
    })
    .filter((job): job is DevelopmentJob => Boolean(job))
    .filter((job) => {
      const dateMs = parseFlexibleDate(job.latestActionDate);
      if (dateMs == null) return false;
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 5);
      return dateMs >= cutoff.getTime();
    })
    .filter(uniqueDevelopmentJob)
    .sort((a, b) => (parseFlexibleDate(b.latestActionDate) ?? 0) - (parseFlexibleDate(a.latestActionDate) ?? 0))
    .slice(0, 8);

  const activeNearbyJobs = nearbyJobs.filter((job) => !/SIGNED OFF|WITHDRAWN|DISAPPROVED/i.test(job.status ?? "")).length;
  const largestNearbyJob = nearbyJobs
    .filter((job) => job.constructionFloorArea != null)
    .sort((a, b) => (b.constructionFloorArea ?? 0) - (a.constructionFloorArea ?? 0))[0] ?? null;

  return {
    nearbyJobs,
    activeNearbyJobs,
    totalProposedUnits: sumNullable(nearbyJobs.map((job) => job.proposedDwellingUnits)),
    largestNearbyJob,
    sourceUrl: "https://data.cityofnewyork.us/resource/ic3t-wcy2",
    sourceNotes,
  };
}

function uniqueDevelopmentJob(job: DevelopmentJob, index: number, jobs: DevelopmentJob[]): boolean {
  const key = job.jobNumber ?? `${job.address}|${job.latestActionDate}|${job.jobType}`;
  return jobs.findIndex((other) => (other.jobNumber ?? `${other.address}|${other.latestActionDate}|${other.jobType}`) === key) === index;
}

function cleanDateString(value: string | null): string | null {
  return value?.trim() || null;
}

function parseFlexibleDate(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assemblageParcelFromRow(row: Record<string, unknown>): AssemblageParcel {
  const lotArea = parseNumber(row.lotarea);
  const builtFar = parseNumber(row.builtfar);
  const residFar = parseNumber(row.residfar);
  const existing = lotArea != null && builtFar != null ? lotArea * builtFar : null;
  const max = lotArea != null && residFar != null ? lotArea * residFar : null;
  return {
    bbl: String(row.bbl ?? ""),
    address: valueString(row.address),
    owner: valueString(row.ownername),
    lotArea,
    builtFar,
    residFar,
    zoning: valueString(row.zonedist1),
    estimatedUnusedBuildableSf: max != null && existing != null
      ? Math.max(0, Math.round(max - existing))
      : null,
  };
}

function normalizeOwner(value: string | null): string | null {
  if (!value) return null;
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function uniqueAssemblageParcels(items: AssemblageParcel[]): AssemblageParcel[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.bbl)) return false;
    seen.add(item.bbl);
    return true;
  });
}

function sumNullable(values: Array<number | null>): number | null {
  const usable = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (usable.length === 0) return null;
  return Math.round(usable.reduce((sum, value) => sum + value, 0));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function buildSocrataBoxUrl(
  baseUrl: string,
  latitude: number,
  longitude: number,
  radiusMeters: number,
  latField: string,
  lonField: string,
  fields: string[],
  extraWhere?: string
): string {
  const latDelta = radiusMeters / 111320;
  const lonDelta = radiusMeters / (111320 * Math.max(Math.cos(latitude * Math.PI / 180), 0.2));
  const where = [
    `${latField} between ${latitude - latDelta} and ${latitude + latDelta}`,
    `${lonField} between ${longitude - lonDelta} and ${longitude + lonDelta}`,
    extraWhere,
  ].filter(Boolean).join(" and ");

  const params = new URLSearchParams({
    "$select": fields.join(","),
    "$where": where,
    "$limit": "500",
  });
  return `${baseUrl}?${params.toString()}`;
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

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusMeters = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(value: number): number {
  return value * Math.PI / 180;
}

function metersToMiles(value: number): number {
  return Math.round((value / 1609.344) * 100) / 100;
}

function byDistance(a: NearbyPlace, b: NearbyPlace): number {
  return a.distanceMeters - b.distanceMeters;
}

function buildSummary({
  acris,
  dob,
  zola,
  nearby,
  market,
  assemblage,
  distress,
  regulatory,
  development,
  recentNews,
  address,
}: {
  acris: AcrisData | null;
  dob: DobData | null;
  zola: ZolaData | null;
  nearby: NearbyContext | null;
  market: MarketContext | null;
  assemblage: AssemblageContext | null;
  distress: DistressContext | null;
  regulatory: RegulatoryContext | null;
  development: DevelopmentMomentumContext | null;
  recentNews: PropertyNewsContext | null;
  address: string | null;
}): string {
  const lines: string[] = [];

  if (address) lines.push(`Property: ${address}`);

  // ACRIS summary
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

  // DOB summary
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
    const activeEcb = dob.ecbViolations.filter((v) => /ACTIVE|OPEN/i.test(v.status ?? ""));
    if (activeEcb.length > 0) {
      lines.push(`Active ECB/OATH violations: ${activeEcb.length} (${activeEcb[0].number ?? "unknown"}${activeEcb[0].description ? ` - ${activeEcb[0].description}` : ""})`);
    }
    if (dob.recentJobs.length > 0) {
      const job = dob.recentJobs[0];
      lines.push(`Latest DOB job: ${job.jobNumber ?? "unknown"} ${job.jobType ?? ""} ${job.status ?? ""} ${job.latestActionDate ?? ""}`.trim());
    }
  } else {
    lines.push("DOB BIS: could not retrieve data");
  }

  // ZoLa summary
  if (zola) {
    const zolaParts: string[] = [];
    if (zola.zoningDistrict) zolaParts.push(`Zone: ${zola.zoningDistrict}`);
    if (zola.overlays) zolaParts.push(`Overlay: ${zola.overlays}`);
    if (zola.specialPurposeDistrict) zolaParts.push(`Special district: ${zola.specialPurposeDistrict}`);
    if (zola.landmarkStatus) zolaParts.push(`Landmark: ${zola.landmarkStatus}`);
    if (zola.floodZone) zolaParts.push(`Flood zone: ${zola.floodZone}`);
    if (zola.historicDistrict) zolaParts.push(`Historic district: ${zola.historicDistrict}`);
    if (zolaParts.length > 0) lines.push(`ZoLa: ${zolaParts.join(" | ")}`);
    else lines.push("ZoLa: no additional data from API");
  } else {
    lines.push("ZoLa: could not retrieve data");
  }

  if (nearby) {
    if (nearby.transit.length > 0) {
      const closest = nearby.transit[0];
      lines.push(`Nearest transit: ${closest.name} (${closest.distanceMiles.toFixed(2)} mi${closest.detail ? ` | ${closest.detail}` : ""})`);
    } else {
      lines.push("Nearest transit: no subway entrance found within about 1 mile");
    }

    if (nearby.schools.length > 0) {
      const closest = nearby.schools[0];
      lines.push(`Nearest school: ${closest.name} (${closest.distanceMiles.toFixed(2)} mi${closest.detail ? ` | ${closest.detail}` : ""})`);
    } else {
      lines.push("Nearest school: no open DOE school found within about 1 mile");
    }
  }

  if (market) {
    if (market.assessment) {
      lines.push(`Assessment: ${market.assessment.year ?? "unknown year"} market value ${formatDollars(market.assessment.marketValue)} | assessed ${formatDollars(market.assessment.assessedTotal)} | tax class ${market.assessment.taxClass ?? "?"}`);
    }
    if (market.subjectSales.length > 0) {
      const latest = market.subjectSales[0];
      lines.push(`Subject DOF sale: ${latest.saleDate ?? "unknown date"} ${formatDollars(latest.salePrice)}${latest.pricePerLandSf ? ` (${formatDollars(latest.pricePerLandSf)}/land sf)` : ""}`);
    }
    if (market.nearbySales.length > 0) {
      lines.push(`Nearby sales comps: ${market.nearbySales.length} within about 1 mile; median ${formatDollars(market.medianNearbyPricePerLandSf)}/land sf`);
    }
  }

  if (assemblage) {
    if (assemblage.sameOwnerSameBlock.length > 0) {
      lines.push(`Assemblage: ${assemblage.sameOwnerSameBlock.length} same-owner parcel(s) on the block`);
    }
    if (assemblage.immediateNeighbors.length > 0) {
      lines.push(`Adjacent/nearby lots checked: ${assemblage.immediateNeighbors.length}; potential combined lot area ${formatNumber(assemblage.potentialCombinedLotArea)} sf`);
    }
    if (assemblage.sameBlockUnderbuilt.length > 0) {
      const best = assemblage.sameBlockUnderbuilt[0];
      lines.push(`Most underbuilt same-block parcel: ${best.address ?? best.bbl} with about ${formatNumber(best.estimatedUnusedBuildableSf)} unused sf`);
    }
  }

  if (distress) {
    if (distress.hasOpenCharges) {
      lines.push(`Distress signal: open DOF property charges total about ${formatDollars(distress.openChargeBalance)}`);
    } else {
      lines.push("Distress signal: no open DOF property charges found");
    }
  }

  if (regulatory) {
    lines.push(`Regulatory risk: ${regulatory.registrationRiskNote ?? "HPD registration status unknown"}`);
    if (regulatory.hpdRegistration) {
      lines.push(`HPD registration: active through ${regulatory.hpdRegistration.registrationEndDate ?? "unknown"}`);
    }
  }

  if (development) {
    lines.push(`Nearby development momentum: ${development.nearbyJobs.length} DOB job filing(s) within about 1 mile; ${development.activeNearbyJobs} appear active/recent`);
    if (development.largestNearbyJob) {
      lines.push(`Largest nearby DOB job: ${development.largestNearbyJob.address ?? development.largestNearbyJob.jobNumber ?? "unknown"} ${formatNumber(development.largestNearbyJob.constructionFloorArea)} sf, ${development.largestNearbyJob.proposedDwellingUnits ?? "?"} units`);
    }
  }

  if (recentNews) {
    if (recentNews.articles.length > 0) {
      lines.push(`Recent property news/public activity: ${recentNews.articles.length} relevant item(s) found`);
      for (const article of recentNews.articles.slice(0, 3)) {
        const date = article.publishedDate ?? "date unknown";
        lines.push(`News signal: ${date} - ${article.title} (${article.signalType}, ${article.relevance} relevance)`);
      }
    } else if (recentNews.sourceNotes.length > 0) {
      lines.push(`Recent property news/public activity: unavailable (${recentNews.sourceNotes[0]})`);
    } else {
      lines.push("Recent property news/public activity: no property-specific items found");
    }
  }

  return lines.join("\n");
}

function positiveNumberText(value: string | null): string | null {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? value : null;
}

function formatDollars(value: number | null): string {
  return value == null ? "unknown" : `$${Math.round(value).toLocaleString()}`;
}

function formatNumber(value: number | null): string {
  return value == null ? "unknown" : Math.round(value).toLocaleString();
}
