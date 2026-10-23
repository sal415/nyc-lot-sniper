"use client";

import { useEffect, useState } from "react";
import type { ExploredItem, ParcelRow, WatchlistItem } from "@/lib/types";

interface Props {
  view: "watchlist" | "explored";
  refreshKey: number;
  onMarkExplored: (bbl: string, parcel: ParcelRow | null) => void;
  onRemoveWatchlist: (bbl: string) => void;
  onRestoreExplored: (bbl: string) => void;
}

const VERDICT_COLORS: Record<string, string> = {
  "Strong candidate": "text-emerald-400 bg-emerald-950/50 border-emerald-800",
  "Worth reviewing": "text-sky-400 bg-sky-950/50 border-sky-800",
  "Weak candidate": "text-amber-400 bg-amber-950/50 border-amber-800",
  "Likely skip": "text-gray-400 bg-gray-900 border-gray-700",
};

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

export default function WatchlistPanel({
  view,
  refreshKey,
  onMarkExplored,
  onRemoveWatchlist,
  onRestoreExplored,
}: Props) {
  const [items, setItems] = useState<Array<WatchlistItem | ExploredItem>>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(view === "watchlist" ? "/api/watchlist" : "/api/explored")
      .then((res) => res.json())
      .then((body: { items: Array<WatchlistItem | ExploredItem> }) => {
        if (!cancelled) setItems(body.items ?? []);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, refreshKey]);

  if (loading && items.length === 0) {
    return <p className="px-4 py-10 text-center text-sm text-gray-500">Loading…</p>;
  }

  if (items.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-sm text-gray-500">
        {view === "watchlist" ? "Nothing saved yet." : "No parcels marked explored."}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-gray-800 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-4 py-2 font-medium">Address</th>
            <th className="px-4 py-2 font-medium">BBL</th>
            <th className="px-4 py-2 text-right font-medium">Score</th>
            <th className="px-4 py-2 font-medium">Verdict</th>
            <th className="px-4 py-2 font-medium">{view === "watchlist" ? "Saved" : "Explored"}</th>
            <th className="px-4 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const parcel = item.parcel;
            const date = view === "watchlist"
              ? (item as WatchlistItem).added_at
              : (item as ExploredItem).explored_at;
            return (
              <tr key={item.bbl} className="border-b border-gray-900 hover:bg-gray-900/60">
                <td className="px-4 py-2">{parcel?.address ?? "—"}</td>
                <td className="px-4 py-2 font-mono text-xs text-gray-400">{item.bbl}</td>
                <td className="px-4 py-2 text-right tabular-nums">{parcel?.opportunity_score ?? "—"}</td>
                <td className="px-4 py-2">
                  {parcel ? (
                    <span className={`rounded border px-2 py-0.5 text-xs ${VERDICT_COLORS[parcel.verdict] ?? VERDICT_COLORS["Likely skip"]}`}>
                      {parcel.verdict}
                    </span>
                  ) : "—"}
                </td>
                <td className="px-4 py-2 text-xs text-gray-500">{fmtDate(date)}</td>
                <td className="px-4 py-2">
                  {view === "watchlist" ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => onMarkExplored(item.bbl, parcel)}
                        className="rounded border border-gray-700 px-2 py-1 text-xs hover:bg-gray-800"
                      >
                        Mark explored
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveWatchlist(item.bbl)}
                        className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950/40"
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onRestoreExplored(item.bbl)}
                      className="rounded border border-gray-700 px-2 py-1 text-xs hover:bg-gray-800"
                    >
                      Restore to queue
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
