"use client";

import { useCallback, useEffect, useState } from "react";
import DatasetPanel from "@/components/DatasetPanel";
import FilterPanel from "@/components/FilterPanel";
import ParcelTable from "@/components/ParcelTable";
import WatchlistPanel from "@/components/WatchlistPanel";
import type { FilterParams, ParcelRow } from "@/lib/types";

const ACTIVE_DATASET_KEY = "activeDatasetId";

type Tab = "queue" | "watchlist" | "explored";

const DEFAULT_PARAMS: FilterParams = {
  sortBy: "opportunity_score",
  sortDir: "desc",
  pageSize: 50,
  hideExplored: true,
};

export default function Dashboard() {
  const [activeDatasetId, setActiveDatasetId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("queue");
  const [params, setParams] = useState<FilterParams>(DEFAULT_PARAMS);
  const [rows, setRows] = useState<ParcelRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watchlistBbls, setWatchlistBbls] = useState<Set<string>>(new Set());
  const [exploredCount, setExploredCount] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_DATASET_KEY);
      if (saved) setActiveDatasetId(saved);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const loadSavedState = useCallback(async () => {
    const [wl, ex] = await Promise.all([
      fetch("/api/watchlist").then((r) => r.json()),
      fetch("/api/explored").then((r) => r.json()),
    ]);
    setWatchlistBbls(new Set((wl.items ?? []).map((i: { bbl: string }) => i.bbl)));
    setExploredCount((ex.items ?? []).length);
  }, []);

  useEffect(() => {
    loadSavedState();
  }, [loadSavedState, refreshKey]);

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
  }, [activeDatasetId, params, refreshKey]);

  function handleSort(sortBy: string) {
    setParams((prev) => ({
      ...prev,
      sortBy,
      sortDir: prev.sortBy === sortBy && prev.sortDir === "desc" ? "asc" : "desc",
      page: 1,
    }));
  }

  async function handleToggleWatchlist(row: ParcelRow) {
    if (watchlistBbls.has(row.bbl)) {
      await fetch(`/api/watchlist/${row.bbl}`, { method: "DELETE" });
    } else {
      await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbl: row.bbl, parcel: row }),
      });
    }
    setRefreshKey((k) => k + 1);
  }

  async function handleMarkExplored(bbl: string, parcel: ParcelRow | null) {
    await fetch("/api/explored", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bbl, parcel }),
    });
    setRefreshKey((k) => k + 1);
  }

  async function handleRemoveWatchlist(bbl: string) {
    await fetch(`/api/watchlist/${bbl}`, { method: "DELETE" });
    setRefreshKey((k) => k + 1);
  }

  async function handleRestoreExplored(bbl: string) {
    await fetch(`/api/explored/${bbl}`, { method: "DELETE" });
    setRefreshKey((k) => k + 1);
  }

  const tabBtn = (id: Tab, label: string) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={`rounded-md px-3 py-1.5 text-sm ${tab === id ? "bg-gray-800 text-gray-100" : "text-gray-400 hover:text-gray-200"}`}
    >
      {label}
    </button>
  );

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

      <nav className="flex gap-1 border-b border-gray-800 pb-2">
        {tabBtn("queue", "Queue")}
        {tabBtn("watchlist", `Watchlist (${watchlistBbls.size})`)}
        {tabBtn("explored", `Explored (${exploredCount})`)}
      </nav>

      {tab === "queue" && (
        <>
          {activeDatasetId && <FilterPanel params={params} onChange={setParams} />}

          {error && (
            <div className="rounded border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}

          <section className="rounded-lg border border-gray-800 bg-gray-950">
            <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
              <h2 className="text-sm font-medium">Queue</h2>
              <span className="text-xs text-gray-500">
                {loading ? "Loading…" : `${total.toLocaleString()} match`}
              </span>
            </div>
            {activeDatasetId ? (
              <ParcelTable
                rows={rows}
                loading={loading}
                params={params}
                onSort={handleSort}
                watchlistBbls={watchlistBbls}
                onToggleWatchlist={handleToggleWatchlist}
                onMarkExplored={(bbl, row) => handleMarkExplored(bbl, row)}
              />
            ) : (
              <p className="px-4 py-10 text-center text-sm text-gray-500">
                Upload a PLUTO CSV to get started.
              </p>
            )}
          </section>
        </>
      )}

      {tab !== "queue" && (
        <section className="rounded-lg border border-gray-800 bg-gray-950">
          <WatchlistPanel
            view={tab}
            refreshKey={refreshKey}
            onMarkExplored={handleMarkExplored}
            onRemoveWatchlist={handleRemoveWatchlist}
            onRestoreExplored={handleRestoreExplored}
          />
        </section>
      )}
    </main>
  );
}
