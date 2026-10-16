"use client";

import { useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import {
  buildBbl,
  calculateParcelMetrics,
  assignOpportunityLabel,
  computePercentileRanks,
  normalizeParcel,
  scoreParcel,
} from "@/lib/scoring";
import type { Dataset } from "@/lib/types";

interface Props {
  activeDatasetId: string | null;
  onActivate: (id: string) => void;
  onDeleted: () => void;
}

const BATCH_SIZE = 500;

export default function DatasetPanel({ activeDatasetId, onActivate, onDeleted }: Props) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadDatasets() {
    const res = await fetch("/api/datasets");
    if (!res.ok) return;
    const body = await res.json();
    setDatasets(body.datasets ?? []);
  }

  useEffect(() => {
    loadDatasets();
  }, []);

  const active = datasets.find((d) => d.id === activeDatasetId) ?? null;

  async function handleUpload(file: File) {
    setBusy(true);
    setStatus(`Reading ${file.name}…`);
    try {
      const text = await file.text();
      const parsed = Papa.parse<Record<string, unknown>>(text, {
        header: true,
        skipEmptyLines: true,
      });

      const scored = parsed.data.map((raw) => {
        const p = normalizeParcel(raw);
        const m = calculateParcelMetrics(p);
        return { p, m, bbl: buildBbl(p.borough, p.block, p.lot), s: scoreParcel(p, m) };
      });
      const percentiles = computePercentileRanks(scored.map((x) => x.s.raw_score));

      const byBbl = new Map<string, Record<string, unknown>>();
      scored.forEach(({ p, m, bbl, s }, i) => {
        if (byBbl.has(bbl)) return;
        byBbl.set(bbl, {
          bbl,
          ...p,
          max_residential_buildable_sf: m.max_residential_buildable_sf,
          existing_built_sf: m.existing_built_sf,
          unused_buildable_sf: m.unused_buildable_sf,
          underbuilt_ratio: m.underbuilt_ratio,
          unused_far: m.unused_far,
          land_opportunity_flag: m.land_opportunity_flag,
          small_building_flag: m.small_building_flag,
          multifamily_flag: m.multifamily_flag,
          raw_score: s.raw_score,
          opportunity_score: percentiles[i],
          percentile_rank: percentiles[i],
          score_reasons: s.key_factors,
          positive_factors: s.positive_factors,
          negative_factors: s.negative_factors,
          missing_or_uncertain_data: s.missing_or_uncertain_data,
          short_developer_verdict: s.short_developer_verdict,
          verdict: assignOpportunityLabel(percentiles[i]),
        });
      });

      const records = [...byBbl.values()];
      setStatus(`Creating dataset for ${records.length.toLocaleString()} parcels…`);

      const created = await fetch("/api/datasets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name.replace(/\.csv$/i, "") }),
      });
      if (!created.ok) throw new Error("Could not create dataset");
      const { dataset } = (await created.json()) as { dataset: Dataset };

      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const res = await fetch(`/api/datasets/${dataset.id}/rows`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: records.slice(i, i + BATCH_SIZE) }),
        });
        if (!res.ok) throw new Error("Batch upload failed");
        setStatus(`Uploaded ${Math.min(i + BATCH_SIZE, records.length).toLocaleString()} of ${records.length.toLocaleString()}…`);
      }

      await fetch(`/api/datasets/${dataset.id}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ finalRowCount: records.length }),
      });

      setStatus(`Imported ${records.length.toLocaleString()} parcels.`);
      await loadDatasets();
      onActivate(dataset.id);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleEnrich() {
    if (!active) return;
    setBusy(true);
    setStatus("Pulling ACRIS signals…");
    try {
      const res = await fetch(`/api/datasets/${active.id}/enrich`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Enrichment failed");
      setStatus(`ACRIS signals found for ${body.enriched.toLocaleString()} of ${body.total.toLocaleString()} parcels.`);
      await loadDatasets();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Enrichment failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!active) return;
    if (!window.confirm(`Delete "${active.name}" and all of its parcels?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/datasets/${active.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      setStatus(null);
      onDeleted();
      await loadDatasets();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-gray-800 bg-gray-950 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium" htmlFor="dataset-select">Dataset</label>
        <select
          id="dataset-select"
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-sm"
          value={activeDatasetId ?? ""}
          onChange={(e) => e.target.value && onActivate(e.target.value)}
        >
          <option value="" disabled>
            {datasets.length ? "Select a dataset" : "No datasets yet"}
          </option>
          {datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.row_count.toLocaleString()})
            </option>
          ))}
        </select>

        {active && (
          <>
            <button
              type="button"
              onClick={handleEnrich}
              disabled={busy}
              className="rounded border border-gray-700 px-3 py-1 text-sm hover:bg-gray-900 disabled:opacity-50"
            >
              Enrich with ACRIS
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy}
              className="rounded border border-red-900 px-3 py-1 text-sm text-red-300 hover:bg-red-950/40 disabled:opacity-50"
            >
              Delete
            </button>
            <span className="text-xs text-gray-500">
              {(active.enriched_count ?? 0).toLocaleString()} enriched
            </span>
          </>
        )}

        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          className="text-sm text-gray-400 file:mr-3 file:rounded file:border-0 file:bg-gray-800 file:px-3 file:py-1.5 file:text-gray-200"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleUpload(file);
          }}
        />
      </div>
      {status && <p className="mt-3 text-xs text-gray-400">{status}</p>}
    </section>
  );
}
