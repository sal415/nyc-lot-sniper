import { ResearchLinks } from "./types";

const BOROUGH_CODES: Record<string, string> = {
  MN: "1", BX: "2", BK: "3", QN: "4", SI: "5",
  "1": "1", "2": "2", "3": "3", "4": "4", "5": "5",
  MANHATTAN: "1", BRONX: "2", BROOKLYN: "3", QUEENS: "4", "STATEN ISLAND": "5",
};

function boroughCode(borough: string | null): string {
  if (!borough) return "1";
  return BOROUGH_CODES[borough.toUpperCase().trim()] ?? "1";
}

export function generateAcrisBblSearchUrl(
  borough: string | null,
  block: string | null,
  lot: string | null
): string {
  const bcode = boroughCode(borough);
  const bl = (block ?? "0").toString().trim().replace(/^0+/, "") || "0";
  const l = (lot ?? "0").toString().trim().replace(/^0+/, "") || "0";

  return `https://a836-acris.nyc.gov/bblsearch/bblsearch.asp?borough=${bcode}&block=${bl}&lot=${l}`;
}

export function generateGoogleMapsQuery(
  borough: string | null,
  block: string | null,
  lot: string | null,
  address: string | null
): string {
  if (address) return `${address}, New York, NY`;

  const bcode = boroughCode(borough);
  const bl = (block ?? "").toString().trim();
  const l = (lot ?? "").toString().trim();
  return `NYC BBL ${bcode}${bl.padStart(5, "0")}${l.padStart(4, "0")}`;
}

export function generateGoogleMapsEmbedUrl(
  borough: string | null,
  block: string | null,
  lot: string | null,
  address: string | null
): string {
  const query = encodeURIComponent(generateGoogleMapsQuery(borough, block, lot, address));
  return `https://www.google.com/maps?q=${query}&t=k&z=20&output=embed`;
}

export function generateResearchLinks(
  borough: string | null,
  block: string | null,
  lot: string | null,
  address: string | null
): ResearchLinks {
  const bcode = boroughCode(borough);
  const bl = (block ?? "").toString().trim();
  const l = (lot ?? "").toString().trim();

  const zola = `https://zola.planning.nyc.gov/lot/${bcode}/${bl}/${l}`;

  // ACRIS search by borough/block/lot. This launcher page auto-posts to the result table in a browser.
  const acris = generateAcrisBblSearchUrl(borough, block, lot);

  // DOB BIS building info
  const dob = `https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?boro=${bcode}&block=${bl.padStart(5, "0")}&lot=${l.padStart(4, "0")}`;

  // Google Maps
  const query = encodeURIComponent(generateGoogleMapsQuery(borough, block, lot, address));
  const googleMaps = `https://www.google.com/maps/search/?api=1&query=${query}`;

  return { zola, acris, dob, googleMaps };
}
