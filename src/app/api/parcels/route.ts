import { NextRequest, NextResponse } from "next/server";
import { filterParcels } from "@/lib/filters";
import { FilterParams } from "@/lib/types";
import { isSupabaseConfigured } from "@/lib/db";

export async function GET(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Database not configured." }, { status: 503 });
  }

  const s = req.nextUrl.searchParams;
  const params: FilterParams = {
    borough:      s.get("borough")    ?? undefined,
    zonedist1:    s.get("zonedist1")  ?? undefined,
    bldgclass:    s.get("bldgclass")  ?? undefined,
    minLotArea:   s.get("minLotArea")  ? Number(s.get("minLotArea"))  : undefined,
    maxBuiltFar:  s.get("maxBuiltFar") ? Number(s.get("maxBuiltFar")) : undefined,
    minResidFar:  s.get("minResidFar") ? Number(s.get("minResidFar")) : undefined,
    minScore:     s.get("minScore")    ? Number(s.get("minScore"))    : undefined,
    search:       s.get("search")     ?? undefined,
    hideExplored: s.get("hideExplored") !== "false",
    datasetId:    s.get("datasetId")  ?? undefined,
    sortBy:       s.get("sortBy")     ?? "opportunity_score",
    sortDir:      (s.get("sortDir") as "asc" | "desc") ?? "desc",
    page:         s.get("page")     ? Number(s.get("page"))     : 1,
    pageSize:     s.get("pageSize") ? Number(s.get("pageSize")) : 50,
  };

  try {
    const { rows, total } = await filterParcels(params);
    return NextResponse.json({ rows, total, page: params.page, pageSize: params.pageSize });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
