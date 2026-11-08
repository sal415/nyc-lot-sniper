import { NextRequest, NextResponse } from "next/server";
import { getSupabase, normalizeParcelRow } from "@/lib/supabase";
import { ParcelRow } from "@/lib/types";
import { enrichParcel } from "@/lib/scraper";
import { buildAiPacket } from "@/lib/packet";
import { generateParcelReport } from "@/lib/ai";
import type { AIReport } from "@/lib/types";

// GET — return cached AI report if one exists for this parcel.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ bbl: string }> }
) {
  const { bbl } = await params;
  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("parcels")
      .select("*")
      .eq("bbl", bbl)
      .limit(1)
      .maybeSingle();

    if (data?.ai_report) {
      return NextResponse.json({ report: parseAIReport(data.ai_report), generatedAt: data.ai_report_generated_at });
    }

    // Fall back to watchlist snapshot for parcels not in the dataset.
    const { data: wl } = await supabase
      .from("watchlist")
      .select("parcel_data")
      .eq("bbl", bbl)
      .maybeSingle();
    const snap = wl?.parcel_data as Record<string, unknown> | undefined;
    if (snap?.ai_report) {
      return NextResponse.json({ report: parseAIReport(snap.ai_report), generatedAt: snap.ai_report_generated_at ?? null });
    }

    return NextResponse.json({ report: null });
  } catch {
    return NextResponse.json({ report: null });
  }
}

// POST — generate (or regenerate with ?force=1) and persist on the parcel row.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ bbl: string }> }
) {
  const { bbl } = await params;
  const force = new URL(req.url).searchParams.get("force") === "1";

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
    let parcelCanPersistReport = false;

    if (data) {
      parcelCanPersistReport = hasReportColumns(data as Record<string, unknown>);
      row = normalizeParcelRow(data as Record<string, unknown>) as ParcelRow;
    } else {
      const { data: wl } = await supabase
        .from("watchlist")
        .select("parcel_data")
        .eq("bbl", bbl)
        .maybeSingle();
      if (!wl?.parcel_data) return NextResponse.json({ error: "Parcel not found" }, { status: 404 });
      row = normalizeParcelRow(wl.parcel_data as Record<string, unknown>) as ParcelRow;
      fromWatchlist = true;
    }

    if (!fromWatchlist && !parcelCanPersistReport) {
      return NextResponse.json(
        {
          error: "AI report columns are missing from the parcels table. Run scripts/setup-supabase.sql, or add parcels.ai_report jsonb and parcels.ai_report_generated_at bigint in Supabase.",
        },
        { status: 500 }
      );
    }

    // Reuse cached report unless ?force=1 explicitly requested.
    if (!force && row.ai_report) {
      return NextResponse.json(JSON.parse(row.ai_report));
    }

    const existing = row.scrape_summary ? JSON.parse(row.scrape_summary) : null;
    if (!existing?.nearby || !existing?.market || !existing?.assemblage || !existing?.distress || !existing?.regulatory || !existing?.development || !existing?.recentNews || !existing?.acris?.distressSignals) {
      const result = await enrichParcel(row.borough, row.block, row.lot, row.address, row.ownername);
      if (!fromWatchlist) {
        await supabase
          .from("parcels")
          .update({ scrape_summary: result, scraped_at: result.scrapedAt })
          .eq("bbl", bbl);
      }
      row = { ...row, scrape_summary: JSON.stringify(result), scraped_at: result.scrapedAt };
    }

    const report = await generateParcelReport(buildAiPacket(row));
    const now = Math.floor(Date.now() / 1000);

    if (!fromWatchlist) {
      // Persist the report on every row that shares this bbl (across datasets).
      const { error: saveError } = await supabase
        .from("parcels")
        .update({ ai_report: report, ai_report_generated_at: now })
        .eq("bbl", bbl);
      if (saveError) {
        throw new Error(`AI report generated but could not be saved to parcel ${bbl}: ${saveError.message}`);
      }
    }

    // Mirror onto the watchlist snapshot (always — covers both watchlist-only
    // parcels and dataset parcels where the watchlist row needs the report too).
    const { data: wl } = await supabase
      .from("watchlist")
      .select("parcel_data")
      .eq("bbl", bbl)
      .maybeSingle();
    if (wl?.parcel_data) {
      const updated = {
        ...(wl.parcel_data as Record<string, unknown>),
        scrape_summary: row.scrape_summary,
        ai_report: report,
        ai_report_generated_at: now,
      };
      const { error: watchlistSaveError } = await supabase
        .from("watchlist")
        .update({ parcel_data: updated })
        .eq("bbl", bbl);
      if (fromWatchlist && watchlistSaveError) {
        throw new Error(`AI report generated but could not be saved to watchlist parcel ${bbl}: ${watchlistSaveError.message}`);
      }
    }

    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "AI report failed" },
      { status: 502 }
    );
  }
}

function hasReportColumns(row: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(row, "ai_report") &&
    Object.prototype.hasOwnProperty.call(row, "ai_report_generated_at");
}

function parseAIReport(value: unknown): AIReport | null {
  if (!value) return null;
  const parsed = typeof value === "string" ? safeJsonParse(value) : value;
  if (!parsed || typeof parsed !== "object") return null;
  const report = parsed as Partial<AIReport>;
  return typeof report.recommendation === "string" &&
    typeof report.confidence === "number" &&
    Array.isArray(report.why) &&
    Array.isArray(report.risks) &&
    typeof report.acquisitionStrategy === "string"
    ? report as AIReport
    : null;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
