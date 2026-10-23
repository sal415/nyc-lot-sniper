"use client";
import { useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import {
  normalizeParcel,
  calculateParcelMetrics,
  scoreParcel,
  computePercentileRanks,
  assignOpportunityLabel,
  buildBbl,
} from "@/lib/scoring";
import type { Dataset } from "@/lib/types";

interface Props {
  activeDatasetId: string | null;
  onActivate: (datasetId: string) => void;
}

type UploadStatus =
  | { phase: "idle" }
  | { phase: "parsing" }
  | { phase: "scoring"; total: number }
  | { phase: "uploading"; batch: number; totalBatches: number }
  | { phase: "done"; name: string; rows: number }
  | { phase: "error"; message: string };

type EnrichProgress = {
  percent: number;
  message: string;
  detail?: string;
  step?: string;
};

type EnrichStreamEvent =
  | { type: "progress"; percent: number; message: string; detail?: string; step?: string }
  | { type: "done"; result: { enriched: number; total: number; distribution: Record<string, number> } }
  | { type: "error"; error: string };

const BATCH_SIZE = 1000;
const CONCURRENT_BATCHES = 4;

async function readEnrichStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (progress: EnrichProgress) => void
): Promise<Extract<EnrichStreamEvent, { type: "done" }>["result"]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: Extract<EnrichStreamEvent, { type: "done" }>["result"] | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as EnrichStreamEvent;
      if (event.type === "progress") {
        onProgress({
          percent: event.percent,
          message: event.message,
          detail: event.detail,
          step: event.step,
        });
      } else if (event.type === "done") {
        result = event.result;
      } else {
        throw new Error(event.error);
      }
    }
  }

  if (!result) throw new Error("Enrichment finished without a result.");
  return result;
}

function formatEnrichStep(step: string | undefined): string {
  switch (step) {
    case "load": return "Loading parcels";
    case "acris": return "ACRIS sales and mortgages";
    case "permits": return "DOB jobs and permits";
    case "dobViolations": return "DOB violations";
    case "hpdViolations": return "HPD violations";
    case "merge": return "Merging source data";
    case "score": return "Recalculating scores";
    case "save": return "Saving parcel updates";
    case "done": return "Complete";
    default: return "Starting";
  }
}

export default function DatasetPanel({ activeDatasetId, onActivate }: Props) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<UploadStatus>({ phase: "idle" });
  const [datasetName, setDatasetName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [enrichingId, setEnrichingId] = useState<string | null>(null);
  const [enrichProgress, setEnrichProgress] = useState<EnrichProgress | null>(null);
  const [enrichResult, setEnrichResult] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleEnrich(id: string) {
    setEnrichingId(id);
    setEnrichProgress({
      percent: 1,
      message: "Starting dataset enrichment.",
      detail: "Opening a live progress stream from the enrichment worker.",
    });
    setEnrichResult(null);
    try {
      const res = await fetch(`/api/datasets/${id}/enrich`, {
        method: "POST",
        headers: { "x-progress-stream": "1" },
      });
      if (!res.ok) throw new Error("Enrichment failed");
      if (!res.body) throw new Error("Progress stream unavailable.");

      const data = await readEnrichStream(res.body, setEnrichProgress);
      const dist = data.distribution;
      const summary = Object.entries(dist).map(([k, v]) => `${k}: ${v}`).join(" · ");
      setEnrichProgress({
        percent: 100,
        message: "Dataset enrichment complete.",
        detail: `Updated ${data.total.toLocaleString()} parcel${data.total === 1 ? "" : "s"}.`,
      });
      setEnrichResult(`Enriched ${data.enriched}/${data.total} parcels. ${summary}`);
      onActivate(id);
      await fetchDatasets();
    } catch (e) {
      setEnrichResult(e instanceof Error ? e.message : "Enrichment failed");
      setEnrichProgress(null);
    } finally {
      setEnrichingId(null);
    }
  }

  useEffect(() => {
    fetchDatasets();
  }, []);

  async function fetchDatasets() {
    setLoading(true);
    const res = await fetch("/api/datasets");
    const data = await res.json();
    setDatasets(data.datasets ?? []);
    setLoading(false);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file && !datasetName) {
      setDatasetName(file.name.replace(/\.csv$/i, "").replace(/_/g, " "));
    }
  }

  async function handleUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const name = datasetName.trim() || file.name;

    setStatus({ phase: "parsing" });

    // Parse CSV in browser
    const parsed = await new Promise<Papa.ParseResult<Record<string, unknown>>>((resolve) => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: resolve,
      });
    });

    // Normalize all column names to lowercase so normalizeParcel works
    // regardless of whether the CSV uses "LotArea", "LOTAREA", "lotarea", etc.
    const rawRows = parsed.data.map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase().trim(), v]))
    );
    setStatus({ phase: "scoring", total: rawRows.length });

    // PLUTO borough abbreviation → numeric code used in BBL
    const BOROUGH_CODE: Record<string, string> = { MN: "1", BX: "2", BK: "3", QN: "4", SI: "5" };

    // Score all rows (pure browser computation)
    const normalized = rawRows.map((r) => normalizeParcel(r));
    const metrics    = normalized.map((r) => calculateParcelMetrics(r));
    const scored     = normalized.map((r, i) => scoreParcel(r, metrics[i], null));
    const rawScores  = scored.map((s) => s.raw_score);
    const percentiles = computePercentileRanks(rawScores);

    const rows = normalized.map((r, i) => {
      const m = metrics[i];
      const s = scored[i];
      const pct = percentiles[i];
      // Prefer the direct BBL column from the CSV; fall back to constructing it
      // with proper borough code conversion (PLUTO stores "QN" not "4")
      const raw = rawRows[i];
      const csvBbl = String(raw["BBL"] ?? raw["bbl"] ?? "").replace(/[^0-9]/g, "");
      const boroughCode = BOROUGH_CODE[(r.borough ?? "").toUpperCase()] ?? r.borough ?? "0";
      const bbl = csvBbl.length === 10 ? csvBbl : buildBbl(boroughCode, r.block, r.lot);
      return {
        bbl,
        borough: r.borough,
        block: r.block,
        lot: r.lot,
        address: r.address,
        lotarea: r.lotarea,
        lotfront: r.lotfront,
        lotdepth: r.lotdepth,
        bldgclass: r.bldgclass,
        ownername: r.ownername,
        ownertype: r.ownertype,
        zonedist1: r.zonedist1,
        zonedist2: r.zonedist2,
        overlay1: r.overlay1,
        overlay2: r.overlay2,
        builtfar: r.builtfar,
        residfar: r.residfar,
        commfar: r.commfar,
        facilfar: r.facilfar,
        yearbuilt: r.yearbuilt,
        yearalter1: r.yearalter1,
        yearalter2: r.yearalter2,
        max_residential_buildable_sf: m.max_residential_buildable_sf,
        existing_built_sf: m.existing_built_sf,
        unused_buildable_sf: m.unused_buildable_sf,
        underbuilt_ratio: m.underbuilt_ratio,
        unused_far: m.unused_far,
        land_opportunity_flag: m.land_opportunity_flag,
        small_building_flag: m.small_building_flag,
        multifamily_flag: m.multifamily_flag,
        raw_score: s.raw_score,
        opportunity_score: pct,
        percentile_rank: pct,
        score_reasons: s.key_factors,
        positive_factors: s.positive_factors,
        negative_factors: s.negative_factors,
        missing_or_uncertain_data: s.missing_or_uncertain_data,
        short_developer_verdict: s.short_developer_verdict,
        verdict: assignOpportunityLabel(pct),
      };
    });

    // Deduplicate by BBL — keep last occurrence (most complete row)
    const seen = new Map<string, typeof rows[0]>();
    for (const r of rows) seen.set(r.bbl, r);
    const uniqueRows = Array.from(seen.values());

    // Create the dataset record
    const createRes = await fetch("/api/datasets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!createRes.ok) {
      setStatus({ phase: "error", message: "Failed to create dataset record." });
      return;
    }
    const { dataset } = await createRes.json();

    // Upload in batches with limited concurrency
    const batches: (typeof uniqueRows)[] = [];
    for (let i = 0; i < uniqueRows.length; i += BATCH_SIZE) {
      batches.push(uniqueRows.slice(i, i + BATCH_SIZE));
    }

    for (let i = 0; i < batches.length; i += CONCURRENT_BATCHES) {
      const chunk = batches.slice(i, i + CONCURRENT_BATCHES);
      setStatus({ phase: "uploading", batch: i + 1, totalBatches: batches.length });

      const results = await Promise.all(
        chunk.map((batch) =>
          fetch(`/api/datasets/${dataset.id}/rows`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows: batch }),
          })
        )
      );

      for (const r of results) {
        if (!r.ok) {
          setStatus({ phase: "error", message: "A batch upload failed. Dataset may be incomplete." });
          return;
        }
      }
    }

    // Finalize row count
    await fetch(`/api/datasets/${dataset.id}/rows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ finalRowCount: uniqueRows.length }),
    });

    setStatus({ phase: "done", name, rows: uniqueRows.length });
    setDatasetName("");
    if (fileRef.current) fileRef.current.value = "";
    onActivate(dataset.id);
    await fetchDatasets();
  }

  async function handleDelete(id: string) {
    await fetch(`/api/datasets/${id}`, { method: "DELETE" });
    setConfirmDelete(null);
    if (activeDatasetId === id) onActivate("");
    await fetchDatasets();
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Upload form */}
      <div className="border border-gray-800 bg-gray-900/50 rounded-xl p-5 space-y-4">
        <h3 className="font-semibold text-gray-200 text-sm uppercase tracking-wider">Upload PLUTO CSV</h3>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Dataset name</label>
            <input
              type="text"
              value={datasetName}
              onChange={(e) => setDatasetName(e.target.value)}
              placeholder="e.g. NYC PLUTO 24v2"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">CSV file</label>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              className="block w-full text-sm text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-indigo-600 file:text-white hover:file:bg-indigo-500 file:cursor-pointer"
            />
            <p className="mt-1 text-[11px] text-gray-600">
              Standard PLUTO CSV with Borough, Block, Lot, LotArea, BuiltFAR, ResidFAR, etc. Scoring runs in your browser.
            </p>
          </div>
          <button
            onClick={handleUpload}
            disabled={status.phase !== "idle" && status.phase !== "done" && status.phase !== "error"}
            className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Upload & Score
          </button>
        </div>

        {/* Progress */}
        {status.phase !== "idle" && (
          <div className={`rounded-lg px-4 py-3 text-sm ${
            status.phase === "error" ? "bg-red-950/40 border border-red-900/60 text-red-300" :
            status.phase === "done"  ? "bg-emerald-950/40 border border-emerald-900/60 text-emerald-300" :
            "bg-gray-800/60 border border-gray-700 text-gray-300"
          }`}>
            {status.phase === "parsing"   && "Reading CSV…"}
            {status.phase === "scoring"   && `Scoring ${status.total.toLocaleString()} rows…`}
            {status.phase === "uploading" && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span>Uploading batch {status.batch} / {status.totalBatches}</span>
                  <span>{Math.round((status.batch / status.totalBatches) * 100)}%</span>
                </div>
                <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all"
                    style={{ width: `${(status.batch / status.totalBatches) * 100}%` }}
                  />
                </div>
              </div>
            )}
            {status.phase === "done"  && `✓ "${status.name}" imported — ${status.rows.toLocaleString()} rows. Now loading in queue.`}
            {status.phase === "error" && `✕ ${status.message}`}
          </div>
        )}
      </div>

      {/* Dataset list */}
      <div>
        <h3 className="font-semibold text-gray-200 text-sm uppercase tracking-wider mb-3">Datasets</h3>
        {enrichingId && enrichProgress && (
          <div className="mb-3 rounded-xl border border-emerald-900/60 bg-emerald-950/20 px-4 py-3">
            <div className="flex items-start gap-3">
              <div className="mt-1 h-4 w-4 flex-none animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-emerald-200">
                    {formatEnrichStep(enrichProgress.step)}
                  </p>
                  <span className="text-sm font-bold tabular-nums text-emerald-300">{enrichProgress.percent}%</span>
                </div>
                <p className="mt-1 text-xs text-gray-400">{enrichProgress.message}</p>
                <p className="mt-1 text-xs text-gray-500">
                  {enrichProgress.detail ?? "The worker is querying live city datasets."}
                </p>
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-emerald-900/40">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                    style={{ width: `${Math.max(2, Math.min(100, enrichProgress.percent))}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
        {enrichResult && (
          <div className="mb-3 px-4 py-2 text-xs rounded-lg bg-emerald-950/40 border border-emerald-900/60 text-emerald-300">
            {enrichResult}
          </div>
        )}

        {loading ? (
          <div className="text-sm text-gray-600 py-8 text-center">Loading…</div>
        ) : datasets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-600 text-sm gap-2">
            <span className="text-4xl">◎</span>
            <p>No datasets yet. Upload a PLUTO CSV to get started.</p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-800/60 border border-gray-800 rounded-xl overflow-hidden">
            {datasets.map((ds) => {
              const isActive = ds.id === activeDatasetId;
              const enrichedCount = ds.enriched_count ?? 0;
              const isEnriched = enrichedCount > 0;
              return (
                <li
                  key={ds.id}
                  className={`px-5 py-4 flex items-center justify-between gap-4 transition-colors ${
                    isActive ? "bg-indigo-950/30" : "bg-gray-900/30 hover:bg-gray-900/60"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-gray-100 text-sm truncate">{ds.name}</p>
                      {isActive && (
                        <span className="flex-none text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-600 text-white font-semibold">
                          Active
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5">
                      {ds.row_count.toLocaleString()} parcels · uploaded {new Date(ds.created_at).toLocaleDateString()}
                    </p>
                    {isEnriched && (
                      <p className="text-xs text-emerald-500 mt-0.5">
                        {enrichedCount.toLocaleString()} enriched
                        {ds.last_enriched_at ? ` · last enriched ${new Date(ds.last_enriched_at * 1000).toLocaleDateString()}` : ""}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-none">
                    {!isActive && (
                      <button
                        onClick={() => onActivate(ds.id)}
                        className="text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors"
                      >
                        Load
                      </button>
                    )}
                    <button
                      onClick={() => handleEnrich(ds.id)}
                      disabled={enrichingId === ds.id}
                      title="Pull ACRIS / DOB / HPD data and re-score"
                      className="text-xs px-3 py-1.5 border border-emerald-800 text-emerald-300 hover:bg-emerald-950/40 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {enrichingId === ds.id ? "Enriching…" : isEnriched ? "Re-enrich" : "Enrich"}
                    </button>
                    {confirmDelete === ds.id ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-gray-500">Delete?</span>
                        <button
                          onClick={() => handleDelete(ds.id)}
                          className="text-xs px-2.5 py-1 bg-red-700 hover:bg-red-600 text-white rounded-lg transition-colors"
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="text-xs px-2.5 py-1 border border-gray-700 text-gray-400 hover:text-gray-200 rounded-lg transition-colors"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(ds.id)}
                        className="text-xs px-2.5 py-1 border border-gray-700 text-gray-500 hover:text-red-400 hover:border-red-900 rounded-lg transition-colors"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
