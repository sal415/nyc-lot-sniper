import { createClient } from "@supabase/supabase-js";

export function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Normalize a parcel row from Supabase: score_reasons comes back as parsed array, frontend expects JSON string. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeParcelRow(row: Record<string, unknown>): any {
  const arrToString = (v: unknown) =>
    Array.isArray(v) ? JSON.stringify(v) : (v ?? "[]");
  return {
    ...row,
    score_reasons:             arrToString(row.score_reasons),
    positive_factors:          arrToString(row.positive_factors),
    negative_factors:          arrToString(row.negative_factors),
    missing_or_uncertain_data: arrToString(row.missing_or_uncertain_data),
    scrape_summary: row.scrape_summary != null && typeof row.scrape_summary === "object"
      ? JSON.stringify(row.scrape_summary)
      : (row.scrape_summary ?? null),
    enrichment_data: row.enrichment_data != null && typeof row.enrichment_data === "object"
      ? JSON.stringify(row.enrichment_data)
      : (row.enrichment_data ?? null),
    ai_report: row.ai_report != null && typeof row.ai_report === "object"
      ? JSON.stringify(row.ai_report)
      : (row.ai_report ?? null),
    land_opportunity_flag: Number(row.land_opportunity_flag ?? 0),
    small_building_flag: Number(row.small_building_flag ?? 0),
    multifamily_flag: Number(row.multifamily_flag ?? 0),
  };
}

/** Prepare a parcel snapshot for storage in watchlist/explored JSONB. */
export function parcelToSnapshot(parcel: Record<string, unknown>): Record<string, unknown> {
  return {
    ...parcel,
    score_reasons: typeof parcel.score_reasons === "string"
      ? JSON.parse(parcel.score_reasons || "[]")
      : (parcel.score_reasons ?? []),
  };
}

/** Restore a parcel from a JSONB snapshot into a ParcelRow-compatible object. */
export function snapshotToParcel(snapshot: unknown): Record<string, unknown> | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  return normalizeParcelRow(snapshot as Record<string, unknown>);
}
