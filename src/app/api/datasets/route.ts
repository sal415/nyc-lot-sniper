import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

// GET /api/datasets — list all datasets
export async function GET() {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("datasets")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;

    const datasets = await Promise.all(
      (data ?? []).map(async (dataset) => {
        const [{ count, error: countError }, { data: latest, error: latestError }] = await Promise.all([
          supabase
            .from("parcels")
            .select("id", { count: "exact", head: true })
            .eq("dataset_id", dataset.id)
            .not("enriched_at", "is", null),
          supabase
            .from("parcels")
            .select("enriched_at")
            .eq("dataset_id", dataset.id)
            .not("enriched_at", "is", null)
            .order("enriched_at", { ascending: false })
            .limit(1),
        ]);
        if (countError) throw countError;
        if (latestError) throw latestError;

        return {
          ...dataset,
          enriched_count: count ?? 0,
          last_enriched_at: latest?.[0]?.enriched_at ?? null,
        };
      })
    );

    return NextResponse.json({ datasets });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to fetch datasets" }, { status: 500 });
  }
}

// POST /api/datasets — create a new dataset record, return its id
export async function POST(req: NextRequest) {
  const { name } = await req.json() as { name?: string };
  if (!name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

  try {
    const { data, error } = await getSupabase()
      .from("datasets")
      .insert({ name: name.trim() })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ dataset: data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to create dataset" }, { status: 500 });
  }
}
