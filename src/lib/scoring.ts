import { RawParcel, Parcel } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// NYC Development Opportunity Scoring
//
// Raw 0–100 score from weighted dimensions, minus hard caps for blockers and
// plus targeted boosts. A dataset-relative percentile rank maps the raw score
// to the final label. Every threshold lives in CONFIG below.
// ─────────────────────────────────────────────────────────────────────────────

export const CONFIG = {
  CURRENT_YEAR: 2026,

  // Dimension weights (must sum to 100 when fully populated)
  WEIGHTS: {
    development_upside:    35,
    feasibility:           20,
    actionability:         20, // building class
    zoning:                10,
    acquisition_friction:  10,
  },

  // Layer 2 percentile cutoffs — tuned to deliver ~6% Strong on this dataset
  LABELS: {
    STRONG:    94, // top ~6%
    REVIEWING: 76, // next ~18%
    WEAK:      35, // middle
    // < 35 → Likely skip
  },

  // Underbuilt ratio tiers (lower = more underbuilt)
  UNDERBUILT_TIERS: [
    { lt: 0.10, pts: 15 },
    { lt: 0.20, pts: 12 },
    { lt: 0.30, pts: 8  },
    { lt: 0.50, pts: 4  },
    { lt: 0.70, pts: 1  },
  ],

  // Unused buildable SF — primary discriminator on this dataset
  UNUSED_SF_TIERS: [
    { gte: 100000, pts: 15 },
    { gte:  50000, pts: 12 },
    { gte:  25000, pts: 9  },
    { gte:  12000, pts: 6  },
    { gte:   7000, pts: 3  },
    { gte:   4000, pts: 1  },
  ],

  // Unused FAR
  UNUSED_FAR_TIERS: [
    { gte: 3.0, pts: 5 },
    { gte: 2.0, pts: 3 },
    { gte: 1.0, pts: 1 },
  ],

  // Lot area
  LOT_AREA_TIERS: [
    { gte: 20000, pts: 12 },
    { gte: 10000, pts: 9  },
    { gte:  5000, pts: 6  },
    { gte:  3000, pts: 3  },
    { gte:  2000, pts: 1  },
  ],

  // Frontage
  FRONTAGE_TIERS: [
    { gte: 50, pts: 4 },
    { gte: 30, pts: 2 },
    { gte: 20, pts: 1 },
  ],

  // Building-class points (full PLUTO classes, not first-letter heuristic)
  BLDGCLASS_PTS: {
    V: 20, // vacant land
    G: 18, // garage / parking
    Z: 14, // misc / other vacant
    O: 10, // office (often demolishable)
    S: 10, // primarily residential mixed-use
    A: 12, // 1-family
    B: 11, // 2-family
    C: 6,  // walkup multifamily
    K: 7,  // commercial w/ residential
    M:  3, R: 3, T: 3, P: 3, U: 3,
    D:  2, // elevator multifamily
    E:  4, F: 4,
    H:  4, I: 4, J: 4, L: 4, N: 4,
    W:  1, Q: 1, Y: 1,
  } as Record<string, number>,

  // Zoning base points
  ZONING_PTS: {
    R7A: 10, R7D: 10, R7X: 10,
    R7B:  8, R6A:  8, R8A: 9,
    R6:   5, R6B:  6,
    R5:   2, R5A:  2, R5B:  2, R5D: 2,
    R4:   2, R3:   1, R2:   0, R1: 0,
  } as Record<string, number>,

  C2_OVERLAY_BONUS: 2,

  // Hard caps (multiplicative — score cannot exceed)
  CAPS: {
    OWNERTYPE_GOVT:       25, // X/C/O/M owner
    NEW_BUILD:            35, // yearbuilt >= 2010 and not vacant
    RECENT_RENOVATION:    45, // yearalter1 >= 2018 and not vacant
    UNUSED_SF_TINY:       40, // unused_sf < 5000
    UNUSED_SF_TRIVIAL:    20, // unused_sf < 2500
    NEAR_MAXED:           30, // built/resid > 0.85
    D_CLASS_LOW_UPSIDE:   35, // D-class with unused_sf < 25000
    AWKWARD_SHAPE:        50, // front<18 or depth<50
  },

  // Boost thresholds
  BOOSTS: {
    VACANT_PRIME:          { unused_sf: 25000, pts: 8 },
    SMALL_TEARDOWN:        { unused_sf: 12000, ratio: 0.25, pts: 6 },
    C2_OVERLAY_VACANT:     { pts: 4 },
    HUGE_UPSIDE:           { unused_sf: 100000, pts: 5 },
    LONG_TENURE:           { yearbuilt: 1940, alter: 1990, pts: 3 },
  },

  // Owner type codes that block private acquisition (NYC PLUTO: X=tax-exempt,
  // C=fully city-owned, O=other public, M=mixed city/private)
  GOVT_OWNERTYPES: new Set(["X", "C", "O", "M"]),

  // Patterns suggesting institutional/government ownership when ownertype is null
  GOVT_OWNERNAME_PATTERNS: [
    /\bCITY OF NEW YORK\b/i, /\bNYCHA\b/i, /\bMTA\b/i, /\bDEPT\b/i,
    /\bDEPARTMENT\b/i, /\bAUTHORITY\b/i, /\bCHURCH\b/i, /\bDIOCESE\b/i,
    /\bSCHOOL\b/i, /\bUNIVERSITY\b/i, /\bHOSPITAL\b/i, /\bSTATE OF\b/i,
    /\bUSA\b/, /\bUNITED STATES\b/i,
  ],

  // Recently-built / altered cutoffs
  NEW_BUILD_YEAR:         2010,
  RECENT_ALTER_YEAR:      2018,
  NEAR_MAXED_RATIO:       0.85,
  AWKWARD_FRONT:          18,
  AWKWARD_DEPTH:          50,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function steppedLT(value: number, tiers: { lt: number; pts: number }[]): number {
  for (const t of tiers) if (value < t.lt) return t.pts;
  return 0;
}
function steppedGTE(value: number, tiers: { gte: number; pts: number }[]): number {
  for (const t of tiers) if (value >= t.gte) return t.pts;
  return 0;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Build BBL string from borough/block/lot. */
export function buildBbl(
  borough: string | null,
  block: string | null,
  lot: string | null
): string {
  const b  = (borough || "0").toString().trim().padStart(1, "0");
  const bl = (block   || "0").toString().trim().padStart(5, "0");
  const l  = (lot     || "0").toString().trim().padStart(4, "0");
  return `${b}${bl}${l}`;
}

/** Normalise a raw parcel row: trim strings, coerce numbers. */
export function normalizeParcel(raw: Record<string, unknown>): RawParcel {
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const s = typeof v === "string" ? v.replace(/,/g, "").trim() : v;
    const n = Number(s);
    return isFinite(n) ? n : null;
  };
  const str = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  };
  const yr = (v: unknown): number | null => {
    const n = num(v);
    return n && n > 0 ? n : null;
  };
  return {
    borough:   str(raw["Borough"]   ?? raw["borough"]),
    block:     str(raw["Block"]     ?? raw["block"]     ?? raw["tax block"]),
    lot:       str(raw["Lot"]       ?? raw["lot"]       ?? raw["tax lot"]),
    address:   str(raw["Address"]   ?? raw["address"]),
    lotarea:   num(raw["LotArea"]   ?? raw["lotarea"]),
    lotfront:  num(raw["LotFront"]  ?? raw["lotfront"]),
    lotdepth:  num(raw["LotDepth"]  ?? raw["lotdepth"]),
    bldgclass: str(raw["BldgClass"] ?? raw["bldgclass"]),
    ownername: str(raw["OwnerName"] ?? raw["ownername"]),
    ownertype: str(raw["OwnerType"] ?? raw["ownertype"]),
    zonedist1: str(raw["ZoneDist1"] ?? raw["zonedist1"]),
    zonedist2: str(raw["ZoneDist2"] ?? raw["zonedist2"]),
    overlay1:  str(raw["Overlay1"]  ?? raw["overlay1"]),
    overlay2:  str(raw["Overlay2"]  ?? raw["overlay2"]),
    builtfar:  num(raw["BuiltFAR"]  ?? raw["builtfar"]),
    residfar:  num(raw["ResidFAR"]  ?? raw["residfar"]),
    commfar:   num(raw["CommFAR"]   ?? raw["commfar"]),
    facilfar:  num(raw["FacilFAR"]  ?? raw["facilfar"]),
    yearbuilt:  yr(raw["YearBuilt"]  ?? raw["yearbuilt"]),
    yearalter1: yr(raw["YearAlter1"] ?? raw["yearalter1"]),
    yearalter2: yr(raw["YearAlter2"] ?? raw["yearalter2"]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

export interface ParcelMetrics {
  max_residential_buildable_sf: number | null;
  existing_built_sf:            number | null;
  unused_buildable_sf:          number | null;
  underbuilt_ratio:             number | null;
  unused_far:                   number | null;
  aspect_ratio:                 number | null; // depth/front (>1 = deep)
  land_opportunity_flag:        boolean;
  small_building_flag:          boolean;
  multifamily_flag:             boolean;
}

export function calculateParcelMetrics(p: RawParcel): ParcelMetrics {
  const lotarea  = p.lotarea  ?? 0;
  const builtfar = p.builtfar ?? 0;
  const residfar = p.residfar ?? 0;

  const max_sf  = lotarea > 0 && residfar > 0 ? lotarea * residfar : null;
  const exist   = lotarea > 0 ? lotarea * builtfar : null;
  const unused  = max_sf != null && exist != null ? max_sf - exist : null;
  const ratio   = residfar > 0 ? builtfar / residfar : null;
  const farGap  = residfar > 0 ? residfar - builtfar : null;
  const aspect  = p.lotfront && p.lotfront > 0 && p.lotdepth ? p.lotdepth / p.lotfront : null;

  const cls = (p.bldgclass ?? "").toUpperCase();
  return {
    max_residential_buildable_sf: max_sf,
    existing_built_sf:            exist,
    unused_buildable_sf:          unused,
    underbuilt_ratio:             ratio,
    unused_far:                   farGap,
    aspect_ratio:                 aspect,
    land_opportunity_flag: cls.startsWith("V") || cls.startsWith("G"),
    small_building_flag:   cls.startsWith("A") || cls.startsWith("B"),
    multifamily_flag:      cls.startsWith("C") || cls.startsWith("D"),
  };
}
// Keep old name as alias.
export const calculateMetrics = calculateParcelMetrics;
// ─────────────────────────────────────────────────────────────────────────────
// Scoring context — accumulator for factors/missing flags
// ─────────────────────────────────────────────────────────────────────────────

interface ScoringContext {
  positive: string[];
  negative: string[];
  missing: string[];
}

function ctx(): ScoringContext {
  return { positive: [], negative: [], missing: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dimension scorers — each returns 0..weight and pushes factors
// ─────────────────────────────────────────────────────────────────────────────

export function scoreDevelopmentUpside(
  p: RawParcel, m: ParcelMetrics, c: ScoringContext
): number {
  let s = 0;
  if (m.underbuilt_ratio != null) {
    const pts = steppedLT(m.underbuilt_ratio, CONFIG.UNDERBUILT_TIERS);
    s += pts;
    if (pts >= 12)      c.positive.push(`Very low built FAR (${(m.underbuilt_ratio*100).toFixed(0)}% of allowed)`);
    else if (pts >= 4)  c.positive.push(`Modestly underbuilt`);
    else                c.negative.push(`Mostly built-out`);
  } else {
    c.missing.push("underbuilt_ratio (no residfar)");
  }

  if (m.unused_buildable_sf != null) {
    const pts = steppedGTE(m.unused_buildable_sf, CONFIG.UNUSED_SF_TIERS);
    s += pts;
    const ksf = Math.round(m.unused_buildable_sf / 1000);
    if (pts >= 12)     c.positive.push(`Massive unused buildable area (~${ksf}k SF)`);
    else if (pts >= 6) c.positive.push(`Substantial unused buildable area (~${ksf}k SF)`);
    else if (pts > 0)  c.positive.push(`Moderate unused buildable area (~${ksf}k SF)`);
    else               c.negative.push(`Trivial unused buildable area (~${ksf}k SF)`);
  }

  if (m.unused_far != null) {
    s += steppedGTE(m.unused_far, CONFIG.UNUSED_FAR_TIERS);
  }

  return Math.min(s, CONFIG.WEIGHTS.development_upside);
}

export function scoreFeasibility(
  p: RawParcel, m: ParcelMetrics, c: ScoringContext
): number {
  let s = 0;

  const lotarea = p.lotarea ?? 0;
  if (lotarea > 0) {
    const pts = steppedGTE(lotarea, CONFIG.LOT_AREA_TIERS);
    s += pts;
    if (pts >= 9)      c.positive.push(`Large lot (${Math.round(lotarea).toLocaleString()} SF)`);
    else if (pts >= 3) c.positive.push(`Adequate lot (${Math.round(lotarea).toLocaleString()} SF)`);
    else               c.negative.push(`Sub-scale lot (${Math.round(lotarea).toLocaleString()} SF)`);
  } else {
    c.missing.push("lotarea");
  }

  if (p.lotfront && p.lotfront > 0) {
    s += steppedGTE(p.lotfront, CONFIG.FRONTAGE_TIERS);
    if (p.lotfront < CONFIG.AWKWARD_FRONT) c.negative.push(`Narrow frontage (${p.lotfront} ft)`);
  } else {
    c.missing.push("lotfront");
  }

  // Shape: reasonable aspect = +4, awkward = 0 (cap penalty applied separately)
  if (m.aspect_ratio != null) {
    const a = m.aspect_ratio;
    if (a >= 0.4 && a <= 5) s += 4;
    else                     c.negative.push(`Awkward lot shape (depth/front=${a.toFixed(1)})`);
  }

  return Math.min(s, CONFIG.WEIGHTS.feasibility);
}

export function scoreActionability(
  p: RawParcel, m: ParcelMetrics, c: ScoringContext
): number {
  const cls = (p.bldgclass ?? "").toUpperCase();
  if (!cls) {
    c.missing.push("bldgclass");
    return 0;
  }
  const first = cls.charAt(0);
  const pts = CONFIG.BLDGCLASS_PTS[first] ?? 0;

  if (first === "V")      c.positive.push("Vacant land — clean ground-up site");
  else if (first === "G") c.positive.push("Garage/parking — easy demo");
  else if (first === "A") c.positive.push("1-family — straightforward teardown");
  else if (first === "B") c.positive.push("2-family — straightforward teardown");
  else if (first === "C") c.negative.push("Walkup multifamily — tenant complexity");
  else if (first === "D") c.negative.push("Elevator multifamily — high acquisition cost & complexity");
  else if (first === "K") c.positive.push("Commercial w/ residential — viable redevelopment");
  else if (first === "S") c.positive.push("Mixed-use residential — viable");

  return Math.min(pts, CONFIG.WEIGHTS.actionability);
}

export function scoreZoning(
  p: RawParcel, m: ParcelMetrics, c: ScoringContext
): number {
  const zone = (p.zonedist1 ?? "").toUpperCase().trim();
  if (!zone) {
    c.missing.push("zonedist1");
    return 0;
  }
  let pts = CONFIG.ZONING_PTS[zone] ?? 0;
  // Fallback for unmapped R-zones
  if (pts === 0) {
    if (zone.startsWith("R7")) pts = 7;
    else if (zone.startsWith("R6")) pts = 5;
    else if (zone.startsWith("R8")) pts = 9;
    else if (zone.startsWith("R5")) pts = 2;
  }

  // C2 commercial overlay — adds flexibility (mixed-use ground floor)
  const ov = (p.overlay1 ?? "").toUpperCase();
  if (ov.startsWith("C2") || ov.startsWith("C1")) {
    pts += CONFIG.C2_OVERLAY_BONUS;
    c.positive.push(`Commercial overlay (${ov}) — mixed-use flexibility`);
  }

  if (pts >= 9)      c.positive.push(`Strong zoning (${zone})`);
  else if (pts >= 6) c.positive.push(`Solid zoning (${zone})`);
  else if (pts >= 3) c.positive.push(`Moderate zoning (${zone})`);
  else               c.negative.push(`Weak zoning (${zone})`);

  return Math.min(pts, CONFIG.WEIGHTS.zoning);
}

/**
 * Acquisition-friction proxy from PLUTO fields (owner type, owner name, tenure).
 */
export function scoreAcquisitionLikelihood(
  p: RawParcel, m: ParcelMetrics, c: ScoringContext
): number {
  let s = 0;
  const ot = (p.ownertype ?? "").toUpperCase().trim();
  const name = (p.ownername ?? "").toUpperCase();

  if (ot && CONFIG.GOVT_OWNERTYPES.has(ot)) {
    c.negative.push(`Government/tax-exempt owner (type ${ot}) — not acquirable`);
    return 0;
  }
  if (ot === "P") {
    s += 7;
    c.positive.push("Private ownership confirmed");
  } else if (!ot) {
    // null ownertype — sniff for institutional patterns
    const looksGovt = CONFIG.GOVT_OWNERNAME_PATTERNS.some((re) => re.test(name));
    if (looksGovt) {
      c.negative.push(`Owner name suggests institutional/government (${p.ownername})`);
      return 0;
    }
    s += 4;
    c.missing.push("ownertype (assumed private)");
  } else {
    s += 3;
  }

  // Long tenure proxy — old building never altered = likely held by aging owner
  const yb = p.yearbuilt;
  const ya = p.yearalter1;
  const B = CONFIG.BOOSTS.LONG_TENURE;
  if (yb && yb < B.yearbuilt && (!ya || ya < B.alter)) {
    s += B.pts;
    c.positive.push("Long-tenure ownership profile (old, never renovated)");
  }

  // Mild LLC penalty — LLCs are often developers but also legitimate owners
  if (/\bLLC\b|\bL L C\b|\bINC\b|\bCORP\b/i.test(name)) {
    s -= 1;
    // not pushed as a factor — too noisy
  }

  return Math.min(Math.max(s, 0), CONFIG.WEIGHTS.acquisition_friction);
}

export interface EnrichmentBlob {
  // ACRIS
  last_sale_date?: string | null;       // ISO
  last_sale_price?: number | null;
  last_sale_to_llc?: boolean | null;
  recent_mortgage_amount?: number | null;
  recent_mortgage_date?: string | null;
  // DOB
  active_dob_jobs?: number | null;
  recent_permits_2y?: number | null;
  // Distress
  open_dob_violations?: number | null;
  open_hpd_violations?: number | null;
  open_charges_total?: number | null;
  in_tax_lien_sale?: boolean | null;
  acris_tax_lien_count?: number | null;
  acris_lien_count?: number | null;
  acris_multiple_liens?: boolean | null;
  acris_lis_pendens_count?: number | null;
  acris_foreclosure_count?: number | null;
  acris_distress_doc_count?: number | null;
  latest_acris_distress_date?: string | null;
  latest_acris_distress_type?: string | null;
  // Market / assemblage
  nearby_sales_median_psf?: number | null;
  same_owner_adjacent_count?: number | null;
  adjacent_underbuilt_count?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Penalties: hard caps for blockers + targeted boosts for compounding wins
// ─────────────────────────────────────────────────────────────────────────────

export function applyPenalties(
  p: RawParcel, m: ParcelMetrics,
  rawScore: number, c: ScoringContext
): number {
  let cap = 100;
  let s   = rawScore;

  const cls   = (p.bldgclass ?? "").toUpperCase();
  const first = cls.charAt(0);
  const ot    = (p.ownertype ?? "").toUpperCase();
  const isVacant = first === "V" || first === "G";

  // Government / tax-exempt ownership — effectively un-acquirable
  if (CONFIG.GOVT_OWNERTYPES.has(ot)) {
    cap = Math.min(cap, CONFIG.CAPS.OWNERTYPE_GOVT);
  }

  // Recently built — won't redevelop for decades unless vacant/garage
  if (p.yearbuilt && p.yearbuilt >= CONFIG.NEW_BUILD_YEAR && !isVacant) {
    cap = Math.min(cap, CONFIG.CAPS.NEW_BUILD);
    c.negative.push(`Recently built (${p.yearbuilt})`);
  }

  // Recent major renovation — likely already invested in
  if (p.yearalter1 && p.yearalter1 >= CONFIG.RECENT_ALTER_YEAR && !isVacant) {
    cap = Math.min(cap, CONFIG.CAPS.RECENT_RENOVATION);
    c.negative.push(`Recently renovated (alter ${p.yearalter1})`);
  }

  // Trivial unused buildable area
  if (m.unused_buildable_sf != null) {
    if (m.unused_buildable_sf < 2500)      cap = Math.min(cap, CONFIG.CAPS.UNUSED_SF_TRIVIAL);
    else if (m.unused_buildable_sf < 5000) cap = Math.min(cap, CONFIG.CAPS.UNUSED_SF_TINY);
  }

  // Already near max FAR
  if (m.underbuilt_ratio != null && m.underbuilt_ratio > CONFIG.NEAR_MAXED_RATIO) {
    cap = Math.min(cap, CONFIG.CAPS.NEAR_MAXED);
  }

  // D-class without compelling unused SF
  if (first === "D" && (m.unused_buildable_sf ?? 0) < 25000) {
    cap = Math.min(cap, CONFIG.CAPS.D_CLASS_LOW_UPSIDE);
  }

  // Awkward shape
  const front = p.lotfront ?? Infinity;
  const depth = p.lotdepth ?? Infinity;
  if (front < CONFIG.AWKWARD_FRONT || depth < CONFIG.AWKWARD_DEPTH) {
    cap = Math.min(cap, CONFIG.CAPS.AWKWARD_SHAPE);
  }


  s = Math.min(s, cap);

  // ── Compounding boosts (after caps so they can clear the bar) ──
  const zone = (p.zonedist1 ?? "").toUpperCase();
  const usf = m.unused_buildable_sf ?? 0;

  if (isVacant && (zone === "R7A" || zone === "R6A" || zone.startsWith("R8"))
      && usf >= CONFIG.BOOSTS.VACANT_PRIME.unused_sf) {
    s += CONFIG.BOOSTS.VACANT_PRIME.pts;
    c.positive.push("Boost: vacant + strong zoning + meaningful scale");
  }
  if ((first === "A" || first === "B")
      && (m.underbuilt_ratio ?? 1) < CONFIG.BOOSTS.SMALL_TEARDOWN.ratio
      && usf >= CONFIG.BOOSTS.SMALL_TEARDOWN.unused_sf
      && (p.yearbuilt ?? 9999) < 1940) {
    s += CONFIG.BOOSTS.SMALL_TEARDOWN.pts;
    c.positive.push("Boost: pre-war small home with strong upside");
  }
  if (isVacant && /^C[12]/i.test(p.overlay1 ?? "")) {
    s += CONFIG.BOOSTS.C2_OVERLAY_VACANT.pts;
  }
  if (usf >= CONFIG.BOOSTS.HUGE_UPSIDE.unused_sf) {
    s += CONFIG.BOOSTS.HUGE_UPSIDE.pts;
    c.positive.push("Boost: top-decile unused buildable area");
  }

  return clamp(Math.round(s), 0, 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict generation
// ─────────────────────────────────────────────────────────────────────────────

export function generateScoreReasons(
  p: RawParcel, m: ParcelMetrics, c: ScoringContext, raw: number
): string {
  const cls = (p.bldgclass ?? "").toUpperCase().charAt(0);
  const zone = (p.zonedist1 ?? "?");
  const usf = m.unused_buildable_sf ?? 0;
  const ksf = Math.round(usf / 1000);

  if (CONFIG.GOVT_OWNERTYPES.has((p.ownertype ?? "").toUpperCase())) {
    return "Government/tax-exempt parcel — not actionable for private acquisition.";
  }
  if (cls === "V" || cls === "G") {
    if (raw >= 70) return `Vacant ${zone} site with ~${ksf}k SF buildable — top-tier ground-up opportunity.`;
    if (usf < 5000) return `Vacant site but only ~${ksf}k SF buildable — sub-scale.`;
    return `Vacant ${zone} site (~${ksf}k SF buildable) — viable mid-tier opportunity.`;
  }
  if (cls === "A" || cls === "B") {
    if (raw >= 65) return `Small ${zone} home with ~${ksf}k SF unused buildable — strong teardown candidate.`;
    return `${zone} 1–2 family — teardown viable only if owner motivated.`;
  }
  if (cls === "D") return `Elevator multifamily on ${zone} — high friction; skip unless distressed.`;
  if (cls === "C") return `Walkup multifamily on ${zone} — tenant complexity; pursue only with assemblage angle.`;
  if (raw >= 65)  return `${zone} parcel with ~${ksf}k SF unused buildable — worth pursuing.`;
  if (raw >= 40)  return `Mid-tier ${zone} parcel — review against comps before committing.`;
  return `Limited upside on ${zone} — likely skip.`;
}

export interface ScoredParcel {
  raw_score: number;
  positive_factors: string[];
  negative_factors: string[];
  missing_or_uncertain_data: string[];
  short_developer_verdict: string;
  /** Back-compat: positive + negative merged into one array for legacy UI. */
  key_factors: string[];
}

export function scoreParcel(p: RawParcel, m: ParcelMetrics): ScoredParcel {
  const c = ctx();

  const subtotal =
    scoreDevelopmentUpside(p, m, c) +
    scoreFeasibility(p, m, c) +
    scoreActionability(p, m, c) +
    scoreZoning(p, m, c) +
    scoreAcquisitionLikelihood(p, m, c);

  const final = applyPenalties(p, m, subtotal, c);

  return {
    raw_score: final,
    positive_factors: c.positive,
    negative_factors: c.negative,
    missing_or_uncertain_data: c.missing,
    short_developer_verdict: generateScoreReasons(p, m, c, final),
    key_factors: [...c.positive, ...c.negative],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — percentile rank + final label
// ─────────────────────────────────────────────────────────────────────────────

export function computePercentileRanks(rawScores: number[]): number[] {
  const n = rawScores.length;
  if (n === 0) return [];
  if (n === 1) return [100];

  const indexed = rawScores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s);
  const result  = new Array<number>(n);

  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n - 1 && indexed[j + 1].s === indexed[i].s) j++;
    const pct = Math.round(((i + j) / 2 / (n - 1)) * 100);
    for (let k = i; k <= j; k++) result[indexed[k].i] = pct;
    i = j + 1;
  }
  return result;
}
// Legacy alias.
export const computePercentiles = computePercentileRanks;

export function assignOpportunityLabel(percentile: number): Parcel["verdict"] {
  if (percentile >= CONFIG.LABELS.STRONG)    return "Strong candidate";
  if (percentile >= CONFIG.LABELS.REVIEWING) return "Worth reviewing";
  if (percentile >= CONFIG.LABELS.WEAK)      return "Weak candidate";
  return "Likely skip";
}
// Legacy alias.
export const getVerdict = assignOpportunityLabel;
