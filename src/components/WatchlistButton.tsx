"use client";
import { useState } from "react";

interface Props {
  bbl: string;
  initialInWatchlist: boolean;
}

export default function WatchlistButton({ bbl, initialInWatchlist }: Props) {
  const [inWatchlist, setInWatchlist] = useState(initialInWatchlist);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setLoading(true);
    setError(null);
    try {
      if (inWatchlist) {
        const res = await fetch(`/api/watchlist/${bbl}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Failed to remove");
        setInWatchlist(false);
      } else {
        const res = await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bbl }),
        });
        if (!res.ok) throw new Error("Failed to save");
        setInWatchlist(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={toggle}
        disabled={loading}
        className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
          inWatchlist
            ? "bg-amber-900/50 hover:bg-red-900/50 text-amber-300 hover:text-red-300 border border-amber-800/60 hover:border-red-800/60"
            : "bg-amber-600 hover:bg-amber-500 text-white"
        }`}
      >
        {loading ? "…" : inWatchlist ? "★ Saved to watchlist" : "★ Save to watchlist"}
      </button>
      {error && <span className="text-red-400 text-xs">{error}</span>}
    </div>
  );
}
