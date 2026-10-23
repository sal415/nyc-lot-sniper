import { NextRequest, NextResponse } from "next/server";
import { getSupabase, snapshotToParcel, parcelToSnapshot } from "@/lib/supabase";
import { ExploredItem } from "@/lib/types";

export async function GET() {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("explored")
      .select("*")
      .order("explored_at", { ascending: false });
    if (error) throw error;

    const items: ExploredItem[] = (data ?? []).map((r) => ({
      bbl: r.bbl,
      note: "",
      explored_at: new Date(r.explored_at).getTime(),
      parcel: snapshotToParcel(r.parcel_data) as ExploredItem["parcel"],
    }));

    return NextResponse.json({ items });
  } catch {
    return NextResponse.json({ items: [] });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { bbl?: string; parcel?: Record<string, unknown> };
  if (!body.bbl) return NextResponse.json({ error: "bbl required" }, { status: 400 });

  try {
    const supabase = getSupabase();
    await Promise.all([
      supabase.from("explored").upsert({
        bbl: body.bbl,
        explored_at: new Date().toISOString(),
        parcel_data: body.parcel ? parcelToSnapshot(body.parcel) : null,
      }, { onConflict: "bbl", ignoreDuplicates: true }),
      supabase.from("watchlist").delete().eq("bbl", body.bbl),
    ]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
