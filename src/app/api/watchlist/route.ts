import { NextRequest, NextResponse } from "next/server";
import { getSupabase, snapshotToParcel, parcelToSnapshot } from "@/lib/supabase";
import { WatchlistItem } from "@/lib/types";

export async function GET() {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("watchlist")
      .select("*")
      .order("added_at", { ascending: false });
    if (error) throw error;

    const items: WatchlistItem[] = (data ?? []).map((r) => ({
      bbl: r.bbl,
      note: r.note ?? "",
      added_at: new Date(r.added_at).getTime(),
      parcel: snapshotToParcel(r.parcel_data) as WatchlistItem["parcel"],
    }));

    return NextResponse.json({ items });
  } catch {
    return NextResponse.json({ items: [] });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { bbl?: string; note?: string; parcel?: Record<string, unknown> };
  if (!body.bbl) return NextResponse.json({ error: "bbl required" }, { status: 400 });

  try {
    const supabase = getSupabase();

    // Always pull the freshest parcel state from the DB so the snapshot
    // captures persisted fields like ai_report, enrichment_data, and any
    // factor updates that happened after the client first loaded the row.
    const { data: fresh } = await supabase
      .from("parcels")
      .select("*")
      .eq("bbl", body.bbl)
      .order("dataset_id", { ascending: false })
      .limit(1)
      .maybeSingle();

    const snapshotSource = fresh ?? body.parcel ?? null;

    await supabase.from("watchlist").upsert({
      bbl: body.bbl,
      note: body.note ?? "",
      added_at: new Date().toISOString(),
      parcel_data: snapshotSource ? parcelToSnapshot(snapshotSource as Record<string, unknown>) : null,
    }, { onConflict: "bbl", ignoreDuplicates: true });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
