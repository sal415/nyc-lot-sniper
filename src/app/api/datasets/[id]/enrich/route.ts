import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { bulkEnrich } from "@/lib/enrichment";

export const maxDuration = 300;

// POST /api/datasets/[id]/enrich
// Pulls ACRIS signals for every parcel in the dataset and stores them on each row.
// Scores are recalculated once the other sources are wired in.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const supabase = getSupabase();

    const parcels: Array<{ id: string; bbl: string }> = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("parcels")
        .select("id, bbl")
        .eq("dataset_id", id)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data?.length) break;
      parcels.push(...(data as Array<{ id: string; bbl: string }>));
      if (data.length < PAGE) break;
      from += PAGE;
    }
    if (!parcels.length) {
      return NextResponse.json({ error: "Dataset empty or not found" }, { status: 404 });
    }

    const enrichments = await bulkEnrich(parcels.map((p) => p.bbl));
    const now = Math.floor(Date.now() / 1000);

    const CONCURRENCY = 10;
    for (let i = 0; i < parcels.length; i += CONCURRENCY) {
      const slice = parcels.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        slice.map((p) =>
          supabase
            .from("parcels")
            .update({
              enrichment_data: enrichments.get(p.bbl) ?? {},
              enriched_at: now,
            })
            .eq("id", p.id)
        )
      );
      for (const r of results) if (r.error) throw r.error;
    }

    return NextResponse.json({ ok: true, enriched: enrichments.size, total: parcels.length });
  } catch (err) {
    console.error("Dataset enrichment failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Enrichment failed" },
      { status: 500 }
    );
  }
}
