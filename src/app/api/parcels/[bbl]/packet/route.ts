import { NextRequest, NextResponse } from "next/server";
import { getSupabase, normalizeParcelRow } from "@/lib/supabase";
import { ParcelRow } from "@/lib/types";
import { buildAiPacket } from "@/lib/packet";

export async function GET(
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
    if (!data) return NextResponse.json({ error: "Parcel not found" }, { status: 404 });

    const row = normalizeParcelRow(data as Record<string, unknown>) as ParcelRow;
    const packet = buildAiPacket(row);

    return NextResponse.json(packet, {
      headers: { "Content-Disposition": `attachment; filename="parcel-${bbl}.json"` },
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
