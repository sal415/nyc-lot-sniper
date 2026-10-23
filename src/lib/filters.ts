import { FilterParams, ParcelRow } from "./types";
import { getSupabase, normalizeParcelRow } from "./supabase";

export interface QueryResult {
  rows: ParcelRow[];
  total: number;
}

const ALLOWED_SORTS = new Set([
  "opportunity_score", "unused_buildable_sf", "lotarea",
  "lotfront", "lotdepth", "residfar", "builtfar", "address", "borough",
]);

export async function filterParcels(params: FilterParams): Promise<QueryResult> {
  const supabase = getSupabase();

  // Collect excluded BBLs from watchlist + explored
  const [wl, ex] = await Promise.all([
    supabase.from("watchlist").select("bbl"),
    supabase.from("explored").select("bbl"),
  ]);
  const excludedBbls = [
    ...(wl.data?.map((r) => r.bbl) ?? []),
    ...(ex.data?.map((r) => r.bbl) ?? []),
  ];

  const sortBy  = ALLOWED_SORTS.has(params.sortBy ?? "") ? params.sortBy! : "opportunity_score";
  const sortAsc = params.sortDir === "asc";
  const pageSize = Math.min(params.pageSize ?? 50, 200);
  const page     = Math.max(1, params.page ?? 1);
  const from     = (page - 1) * pageSize;
  const to       = from + pageSize - 1;

  let q = supabase
    .from("parcels")
    .select("*", { count: "exact" })
    .not("residfar", "is", null);

  if (params.datasetId) q = q.eq("dataset_id", params.datasetId);
  if (excludedBbls.length > 0) q = q.not("bbl", "in", `(${excludedBbls.join(",")})`);
  if (params.borough)         q = q.eq("borough", params.borough);
  if (params.zonedist1)       q = q.eq("zonedist1", params.zonedist1);
  if (params.bldgclass)       q = q.ilike("bldgclass", `${params.bldgclass}%`);
  if (params.minLotArea != null)  q = q.gte("lotarea", params.minLotArea);
  if (params.maxBuiltFar != null) q = q.lte("builtfar", params.maxBuiltFar);
  if (params.minResidFar != null) q = q.gte("residfar", params.minResidFar);
  if (params.minScore != null)    q = q.gte("opportunity_score", params.minScore);
  if (params.search) {
    const like = `%${params.search}%`;
    q = q.or(`address.ilike.${like},bbl.ilike.${like},ownername.ilike.${like}`);
  }

  q = q.order(sortBy, { ascending: sortAsc }).range(from, to);

  const { data, count, error } = await q;
  if (error) throw error;

  const rows = (data ?? []).map((r) => normalizeParcelRow(r as Record<string, unknown>)) as ParcelRow[];
  return { rows, total: count ?? 0 };
}
