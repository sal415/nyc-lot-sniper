"use client";

import { useState } from "react";

interface Props {
  bbl: string;
  initialSummary: string | null;
}

export default function EnrichButton({ bbl, initialSummary }: Props) {
  const [summary, setSummary] = useState<string | null>(initialSummary);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runLiveCheck() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/parcels/${bbl}/enrich`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Live check failed");
      setSummary(body.summary ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Live check failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-lg border border-gray-800 bg-gray-950 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Live records</h2>
        <button
          type="button"
          onClick={runLiveCheck}
          disabled={loading}
          className="rounded border border-gray-700 px-3 py-1 text-sm hover:bg-gray-900 disabled:opacity-50"
        >
          {loading ? "Checking…" : "Run live check"}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {summary ? (
        <pre className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-gray-300">{summary}</pre>
      ) : (
        <p className="mt-4 text-sm text-gray-500">No live records pulled yet.</p>
      )}
    </section>
  );
}
