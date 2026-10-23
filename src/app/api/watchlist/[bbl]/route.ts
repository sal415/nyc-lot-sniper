import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ bbl: string }> }
) {
  const { bbl } = await params;
  try {
    const supabase = getSupabase();
    const { data: item, error: readError } = await supabase
      .from("watchlist")
      .select("bbl, parcel_data")
      .eq("bbl", bbl)
      .maybeSingle();
    if (readError) throw readError;

    if (item) {
      const { error: archiveError } = await supabase.from("explored").upsert({
        bbl: item.bbl,
        explored_at: new Date().toISOString(),
        parcel_data: item.parcel_data,
      }, { onConflict: "bbl", ignoreDuplicates: true });
      if (archiveError) throw archiveError;
    }

    const { error: deleteError } = await supabase.from("watchlist").delete().eq("bbl", bbl);
    if (deleteError) throw deleteError;

    return NextResponse.json({ ok: true, movedToExplored: Boolean(item) });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ bbl: string }> }
) {
  const { bbl } = await params;
  const { note = "" } = await req.json() as { note?: string };
  try {
    await getSupabase().from("watchlist").update({ note }).eq("bbl", bbl);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
