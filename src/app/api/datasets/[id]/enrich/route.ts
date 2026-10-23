import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { bulkEnrich } from "@/lib/enrichment";
import {
  scoreParcel,
  calculateParcelMetrics,
  computePercentileRanks,
  assignOpportunityLabel,
  EnrichmentBlob,
} from "@/lib/scoring";
import { RawParcel } from "@/lib/types";

export const maxDuration = 300;

type ProgressStep =
  | "load"
  | "acris"
  | "permits"
  | "dobViolations"
  | "hpdViolations"
  | "merge"
  | "score"
  | "save"
  | "done";

interface EnrichProgress {
  type: "progress";
  step: ProgressStep;
  percent: number;
  message: string;
  detail?: string;
}

interface EnrichResult {
  ok: true;
  enriched: number;
  total: number;
  distribution: Record<string, number>;
}

// POST /api/datasets/[id]/enrich
// Pulls ACRIS/DOB/HPD for every parcel in the dataset, re-scores with the new
// signals, and updates the rows. The UI can opt into NDJSON progress by sending
// x-progress-stream: 1.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (req.headers.get("x-progress-stream") === "1") {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (payload: unknown) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        };

        try {
          const result = await runDatasetEnrichment(id, sendProgress(send));
          send({ type: "done", result });
        } catch (err) {
          console.error("Dataset enrichment failed:", err);
          send({
            type: "error",
            error: err instanceof Error ? err.message : "Enrichment failed",
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }

  try {
    return NextResponse.json(await runDatasetEnrichment(id));
  } catch (err) {
    console.error("Dataset enrichment failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Enrichment failed" },
      { status: 500 }
    );
  }
}

function sendProgress(send: (payload: unknown) => void) {
  return (event: EnrichProgress) => send(event);
}

async function runDatasetEnrichment(
  id: string,
  onProgress?: (event: EnrichProgress) => void
): Promise<EnrichResult> {
  const supabase = getSupabase();

  onProgress?.({
    type: "progress",
    step: "load",
    percent: 5,
    message: "Loading parcels from the selected dataset.",
  });

  const all: Array<Record<string, unknown>> = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("parcels")
      .select("*")
      .eq("dataset_id", id)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...(data as Record<string, unknown>[]));
    onProgress?.({
      type: "progress",
      step: "load",
      percent: 8,
      message: `Loaded ${all.length.toLocaleString()} parcel${all.length === 1 ? "" : "s"} from Supabase.`,
    });
    if (data.length < PAGE) break;
    from += PAGE;
  }
  if (!all.length) throw new Error("Dataset empty or not found");

  const completedSources = new Set<ProgressStep>();
  const bbls = all.map((r) => String(r.bbl));
  onProgress?.({
    type: "progress",
    step: "merge",
    percent: 10,
    message: `Starting live enrichment for ${bbls.length.toLocaleString()} parcel${bbls.length === 1 ? "" : "s"}.`,
    detail: "ACRIS, DOB permits, DOB violations, and HPD violations run in parallel.",
  });

  const enrichments = await bulkEnrich(bbls, (event) => {
    const stepMap = {
      acris: "acris",
      permits: "permits",
      dobViolations: "dobViolations",
      hpdViolations: "hpdViolations",
    } as const;
    const step = stepMap[event.source];
    if (event.status === "done" || event.status === "failed") completedSources.add(step);
    const percent = event.status === "started" ? 12 : 12 + completedSources.size * 15;
    onProgress?.({
      type: "progress",
      step,
      percent: Math.min(percent, 72),
      message: event.message,
      detail: event.parcelsWithData != null
        ? `${event.parcelsWithData.toLocaleString()} parcel${event.parcelsWithData === 1 ? "" : "s"} matched this source.`
        : undefined,
    });
  });

  onProgress?.({
    type: "progress",
    step: "score",
    percent: 80,
    message: "Merging enrichment signals and recalculating acquisition scores.",
  });

  const rawScores: number[] = [];
  const scored = all.map((row) => {
    const p: RawParcel = {
      borough: row.borough as string | null,
      block: row.block as string | null,
      lot: row.lot as string | null,
      address: row.address as string | null,
      lotarea: row.lotarea as number | null,
      lotfront: row.lotfront as number | null,
      lotdepth: row.lotdepth as number | null,
      bldgclass: row.bldgclass as string | null,
      ownername: row.ownername as string | null,
      ownertype: row.ownertype as string | null,
      zonedist1: row.zonedist1 as string | null,
      zonedist2: row.zonedist2 as string | null,
      overlay1: row.overlay1 as string | null,
      overlay2: row.overlay2 as string | null,
      builtfar: row.builtfar as number | null,
      residfar: row.residfar as number | null,
      commfar: row.commfar as number | null,
      facilfar: row.facilfar as number | null,
      yearbuilt: row.yearbuilt as number | null,
      yearalter1: row.yearalter1 as number | null,
      yearalter2: row.yearalter2 as number | null,
    };
    const m = calculateParcelMetrics(p);
    const e: EnrichmentBlob | null = enrichments.get(String(row.bbl)) ?? null;
    const s = scoreParcel(p, m, e);
    rawScores.push(s.raw_score);
    return { row, scored: s, enrichment: e };
  });

  const percentiles = computePercentileRanks(rawScores);
  const now = Math.floor(Date.now() / 1000);
  const updates = scored.map(({ row, scored: s, enrichment }, i) => ({
    id: row.id as string,
    patch: {
      raw_score: s.raw_score,
      opportunity_score: percentiles[i],
      percentile_rank: percentiles[i],
      score_reasons: s.key_factors,
      positive_factors: s.positive_factors,
      negative_factors: s.negative_factors,
      missing_or_uncertain_data: s.missing_or_uncertain_data,
      short_developer_verdict: s.short_developer_verdict,
      verdict: assignOpportunityLabel(percentiles[i]),
      enrichment_data: enrichment,
      enriched_at: now,
    },
  }));

  onProgress?.({
    type: "progress",
    step: "save",
    percent: 88,
    message: `Saving updated scores and enrichment data for ${updates.length.toLocaleString()} parcel${updates.length === 1 ? "" : "s"}.`,
  });

  const CONCURRENCY = 10;
  for (let i = 0; i < updates.length; i += CONCURRENCY) {
    const slice = updates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map((u) => supabase.from("parcels").update(u.patch).eq("id", u.id))
    );
    for (const r of results) {
      if (r.error) throw r.error;
    }
    onProgress?.({
      type: "progress",
      step: "save",
      percent: Math.min(96, 88 + Math.round(((i + slice.length) / updates.length) * 8)),
      message: `Saved ${Math.min(i + slice.length, updates.length).toLocaleString()} of ${updates.length.toLocaleString()} parcel updates.`,
    });
  }

  const dist: Record<string, number> = {};
  for (const u of updates) dist[u.patch.verdict] = (dist[u.patch.verdict] ?? 0) + 1;

  onProgress?.({
    type: "progress",
    step: "done",
    percent: 100,
    message: "Dataset enrichment complete.",
    detail: `${enrichments.size.toLocaleString()} of ${all.length.toLocaleString()} parcels received at least one live signal.`,
  });

  return {
    ok: true,
    enriched: enrichments.size,
    total: all.length,
    distribution: dist,
  };
}
