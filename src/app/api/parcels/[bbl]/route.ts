import { NextRequest, NextResponse } from "next/server";
import { getSupabase, normalizeParcelRow } from "@/lib/supabase";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ bbl: string }> }
) {
  const { bbl } = await params;
  const datasetId = req.nextUrl.searchParams.get("datasetId") ?? undefined;

  try {
    const supabase = getSupabase();
    let q = supabase.from("parcels").select("*").eq("bbl", bbl);
    if (datasetId) q = q.eq("dataset_id", datasetId);
    // Take the most recently imported version if multiple datasets contain the BBL
    q = q.order("dataset_id", { ascending: false }).limit(1);

    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Parcel not found" }, { status: 404 });

    return NextResponse.json(normalizeParcelRow(data as Record<string, unknown>));
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
