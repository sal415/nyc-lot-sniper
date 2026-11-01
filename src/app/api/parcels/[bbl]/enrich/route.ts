import { NextRequest, NextResponse } from "next/server";
import { getSupabase, normalizeParcelRow } from "@/lib/supabase";
import { ParcelRow } from "@/lib/types";
import { enrichParcel } from "@/lib/scraper";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ bbl: string }> }
) {
  const { bbl } = await params;

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("parcels")
      .select("*")
      .eq("bbl", bbl)
      .order("dataset_id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    let row: ParcelRow;
    let fromWatchlist = false;

    if (data) {
      row = normalizeParcelRow(data as Record<string, unknown>) as ParcelRow;
    } else {
      // Parcel only exists as a watchlist snapshot (e.g. added via "analyze lot")
      const { data: wl } = await supabase
        .from("watchlist")
        .select("parcel_data")
        .eq("bbl", bbl)
        .maybeSingle();
      if (!wl?.parcel_data) return NextResponse.json({ error: "Parcel not found" }, { status: 404 });
      row = normalizeParcelRow(wl.parcel_data as Record<string, unknown>) as ParcelRow;
      fromWatchlist = true;
    }

    const result = await enrichParcel(row.borough, row.block, row.lot, row.address, row.ownername);

    if (fromWatchlist) {
      // Write enrichment back into the watchlist snapshot
      const { data: wl } = await supabase
        .from("watchlist")
        .select("parcel_data")
        .eq("bbl", bbl)
        .maybeSingle();
      if (wl?.parcel_data) {
        await supabase
          .from("watchlist")
          .update({ parcel_data: { ...(wl.parcel_data as Record<string, unknown>), scrape_summary: JSON.stringify(result), scraped_at: result.scrapedAt } })
          .eq("bbl", bbl);
      }
    } else {
      // Update all copies of this BBL across all datasets
      await supabase
        .from("parcels")
        .update({ scrape_summary: result, scraped_at: result.scrapedAt })
        .eq("bbl", bbl);
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Enrichment failed" }, { status: 500 });
  }
}
