"use client";

import { useEffect, useState } from "react";
import DatasetPanel from "@/components/DatasetPanel";
import FilterPanel from "@/components/FilterPanel";
import ParcelTable from "@/components/ParcelTable";
import type { FilterParams, ParcelRow } from "@/lib/types";

const ACTIVE_DATASET_KEY = "activeDatasetId";

const DEFAULT_PARAMS: FilterParams = {
  sortBy: "opportunity_score",
  sortDir: "desc",
  pageSize: 50,
};

export default function Dashboard() {
  const [activeDatasetId, setActiveDatasetId] = useState<string | null>(null);
  const [params, setParams] = useState<FilterParams>(DEFAULT_PARAMS);
  const [rows, setRows] = useState<ParcelRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_DATASET_KEY);
      if (saved) setActiveDatasetId(saved);
    } catch {
      /* storage unavailable */
    }
  }, []);

  useEffect(() => {
    if (!activeDatasetId) {
      setRows([]);
      setTotal(0);
      return;
    }
    try {
      localStorage.setItem(ACTIVE_DATASET_KEY, activeDatasetId);
    } catch {
      /* storage unavailable */
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      const qs = new URLSearchParams({ datasetId: activeDatasetId });
      for (const [k, v] of Object.entries({ ...params, datasetId: undefined })) {
        if (v !== undefined && v !== "") qs.set(k, String(v));
      }

      setLoading(true);
      setError(null);
      fetch(`/api/parcels?${qs.toString()}`)
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok) throw new Error(body.error ?? "Failed to load parcels");
          if (cancelled) return;
          setRows(body.rows as ParcelRow[]);
          setTotal(body.total as number);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load parcels");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeDatasetId, params]);

  function handleSort(sortBy: string) {
    setParams((prev) => ({
      ...prev,
      sortBy,
      sortDir: prev.sortBy === sortBy && prev.sortDir === "desc" ? "asc" : "desc",
      page: 1,
    }));
  }

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold">NYC Lot Sniper</h1>
        <p className="text-sm text-gray-400">Screen PLUTO parcels for underbuilt development sites.</p>
      </header>

      <DatasetPanel
        activeDatasetId={activeDatasetId}
        onActivate={(id) => setActiveDatasetId(id || null)}
      />

      {activeDatasetId && <FilterPanel params={params} onChange={setParams} />}

      {error && (
        <div className="rounded border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <section className="rounded-lg border border-gray-800 bg-gray-950">
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
          <h2 className="text-sm font-medium">Parcels</h2>
          <span className="text-xs text-gray-500">
            {loading ? "Loading…" : `${total.toLocaleString()} match`}
          </span>
        </div>
        {activeDatasetId ? (
          <ParcelTable rows={rows} loading={loading} params={params} onSort={handleSort} />
        ) : (
          <p className="px-4 py-10 text-center text-sm text-gray-500">
            Upload a PLUTO CSV to get started.
          </p>
        )}
      </section>
    </main>
  );
}
