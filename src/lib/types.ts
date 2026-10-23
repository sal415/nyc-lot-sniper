export interface RawParcel {
  borough: string | null;
  block: string | null;
  lot: string | null;
  address: string | null;
  lotarea: number | null;
  lotfront: number | null;
  lotdepth: number | null;
  bldgclass: string | null;
  ownername: string | null;
  ownertype: string | null;
  zonedist1: string | null;
  zonedist2: string | null;
  overlay1: string | null;
  overlay2: string | null;
  builtfar: number | null;
  residfar: number | null;
  commfar: number | null;
  facilfar: number | null;
  yearbuilt: number | null;
  yearalter1: number | null;
  yearalter2: number | null;
}

export interface Parcel extends RawParcel {
  bbl: string;
  max_residential_buildable_sf: number | null;
  existing_built_sf: number | null;
  unused_buildable_sf: number | null;
  underbuilt_ratio: number | null;
  unused_far: number | null;
  land_opportunity_flag: boolean;
  small_building_flag: boolean;
  multifamily_flag: boolean;
  raw_score: number;
  opportunity_score: number;
  percentile_rank: number;
  score_reasons: string[];
  positive_factors: string[];
  negative_factors: string[];
  missing_or_uncertain_data: string[];
  short_developer_verdict: string;
  verdict: "Strong candidate" | "Worth reviewing" | "Weak candidate" | "Likely skip";
}

export interface ParcelRow {
  bbl: string;
  borough: string | null;
  block: string | null;
  lot: string | null;
  address: string | null;
  lotarea: number | null;
  lotfront: number | null;
  lotdepth: number | null;
  bldgclass: string | null;
  ownername: string | null;
  ownertype: string | null;
  zonedist1: string | null;
  zonedist2: string | null;
  overlay1: string | null;
  overlay2: string | null;
  builtfar: number | null;
  residfar: number | null;
  commfar: number | null;
  facilfar: number | null;
  yearbuilt: number | null;
  yearalter1: number | null;
  yearalter2: number | null;
  max_residential_buildable_sf: number | null;
  existing_built_sf: number | null;
  unused_buildable_sf: number | null;
  underbuilt_ratio: number | null;
  unused_far: number | null;
  land_opportunity_flag: number;
  small_building_flag: number;
  multifamily_flag: number;
  raw_score: number;
  opportunity_score: number;
  percentile_rank: number;
  score_reasons: string;
  positive_factors: string;
  negative_factors: string;
  missing_or_uncertain_data: string;
  short_developer_verdict: string | null;
  verdict: string;
  enrichment_data: string | null;
  enriched_at: number | null;
}

export interface ResearchLinks {
  zola: string;
  acris: string;
  dob: string;
  googleMaps: string;
}

export interface FilterParams {
  borough?: string;
  zonedist1?: string;
  bldgclass?: string;
  minLotArea?: number;
  maxBuiltFar?: number;
  minResidFar?: number;
  minScore?: number;
  search?: string;
  hideExplored?: boolean;
  datasetId?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface Dataset {
  id: string;
  name: string;
  row_count: number;
  created_at: string;
  enriched_count?: number;
  last_enriched_at?: number | null;
}

export interface WatchlistItem {
  bbl: string;
  note: string;
  added_at: number;
  parcel: ParcelRow | null;
}

export interface ExploredItem {
  bbl: string;
  note: string;
  explored_at: number;
  parcel: ParcelRow | null;
}

