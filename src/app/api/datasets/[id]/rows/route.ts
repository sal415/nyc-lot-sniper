import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

interface UploadRow {
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
  verdict: string;
}

// POST /api/datasets/[id]/rows — bulk insert a batch of scored rows
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { rows, finalRowCount } = await req.json() as {
    rows?: UploadRow[];
    finalRowCount?: number;
  };

  if (!rows?.length && finalRowCount == null) {
    return NextResponse.json({ error: "rows required" }, { status: 400 });
  }

  try {
    const supabase = getSupabase();

    if (rows?.length) {
      const records = rows.map((r) => ({ ...r, dataset_id: id }));
      const { error } = await supabase.from("parcels").upsert(records, { onConflict: "dataset_id,bbl", ignoreDuplicates: true });
      if (error) throw error;
    }

    if (finalRowCount != null) {
      await supabase.from("datasets").update({ row_count: finalRowCount }).eq("id", id);
    }

    return NextResponse.json({ ok: true, inserted: rows?.length ?? 0 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Batch insert failed" }, { status: 500 });
  }
}
