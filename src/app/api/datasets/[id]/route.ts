import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

// DELETE /api/datasets/[id] — delete dataset and all its parcels (cascade)
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { error } = await getSupabase().from("datasets").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to delete dataset" }, { status: 500 });
  }
}
