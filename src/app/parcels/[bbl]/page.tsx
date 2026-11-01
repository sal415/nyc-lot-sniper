import { notFound } from "next/navigation";
import { getSupabase, isSupabaseConfigured, normalizeParcelRow } from "@/lib/supabase";
import type { ParcelRow } from "@/lib/types";
import { generateResearchLinks } from "@/lib/links";
import BackButton from "@/components/BackButton";
import EnrichButton from "@/components/EnrichButton";
import WatchlistButton from "@/components/WatchlistButton";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const VERDICT_COLORS: Record<string, string> = {
  "Strong candidate": "text-emerald-400 bg-emerald-950/50 border-emerald-800",
  "Worth reviewing": "text-sky-400 bg-sky-950/50 border-sky-800",
  "Weak candidate": "text-amber-400 bg-amber-950/50 border-amber-800",
  "Likely skip": "text-gray-400 bg-gray-900 border-gray-700",
};

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function summaryText(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { summary?: string };
    return parsed.summary ?? null;
  } catch {
    return null;
  }
}

function fmtNum(value: number | null | undefined): string {
  return value == null ? "—" : Math.round(value).toLocaleString();
}

function fmtFar(value: number | null | undefined): string {
  return value == null ? "—" : value.toFixed(2);
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-1 text-sm text-gray-200">{value}</dd>
    </div>
  );
}

export default async function ParcelDetailPage({
  params,
}: {
  params: Promise<{ bbl: string }>;
}) {
  const { bbl } = await params;
  if (!isSupabaseConfigured()) notFound();

  const supabase = getSupabase();
  const { data } = await supabase
    .from("parcels")
    .select("*")
    .eq("bbl", bbl)
    .order("dataset_id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) notFound();

  const row = normalizeParcelRow(data as Record<string, unknown>) as ParcelRow;
  const { data: saved } = await supabase.from("watchlist").select("bbl").eq("bbl", bbl).maybeSingle();

  const links = generateResearchLinks(row.borough, row.block, row.lot, row.address);
  const positives = parseStringArray(row.positive_factors);
  const negatives = parseStringArray(row.negative_factors);
  const missing = parseStringArray(row.missing_or_uncertain_data);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 space-y-6 px-4 py-8">
      <BackButton fallbackHref="/" />

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{row.address ?? "Unknown address"}</h1>
          <p className="font-mono text-xs text-gray-500">BBL {row.bbl}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`rounded border px-2 py-1 text-xs ${VERDICT_COLORS[row.verdict] ?? VERDICT_COLORS["Likely skip"]}`}>
            {row.verdict}
          </span>
          <span className="text-2xl font-semibold tabular-nums">{row.opportunity_score}</span>
        </div>
      </header>

      <WatchlistButton bbl={row.bbl} initialInWatchlist={Boolean(saved)} />

      <section className="grid gap-6 rounded-lg border border-gray-800 bg-gray-950 p-5 sm:grid-cols-3">
        <dl className="grid grid-cols-2 gap-4 sm:col-span-2">
          <Field label="Zone" value={row.zonedist1 ?? "—"} />
          <Field label="Building class" value={row.bldgclass ?? "—"} />
          <Field label="Lot area (SF)" value={fmtNum(row.lotarea)} />
          <Field label="Frontage × depth" value={`${fmtNum(row.lotfront)} × ${fmtNum(row.lotdepth)} ft`} />
          <Field label="Built FAR" value={fmtFar(row.builtfar)} />
          <Field label="Residential FAR" value={fmtFar(row.residfar)} />
          <Field label="Unused buildable SF" value={fmtNum(row.unused_buildable_sf)} />
          <Field label="Owner" value={row.ownername ?? "—"} />
        </dl>
        <div className="space-y-2 text-sm">
          <p className="text-xs uppercase tracking-wide text-gray-500">Research</p>
          <a className="block text-sky-400 hover:underline" href={links.zola} target="_blank" rel="noreferrer">ZoLa</a>
          <a className="block text-sky-400 hover:underline" href={links.acris} target="_blank" rel="noreferrer">ACRIS</a>
          <a className="block text-sky-400 hover:underline" href={links.dob} target="_blank" rel="noreferrer">DOB BIS</a>
          <a className="block text-sky-400 hover:underline" href={links.googleMaps} target="_blank" rel="noreferrer">Google Maps</a>
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-gray-800 bg-gray-950 p-5">
          <h2 className="text-sm font-medium text-emerald-400">Positive factors</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-300">
            {positives.length ? positives.map((f) => <li key={f}>{f}</li>) : <li className="text-gray-500">None recorded</li>}
          </ul>
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-950 p-5">
          <h2 className="text-sm font-medium text-red-400">Negative factors</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-300">
            {negatives.length ? negatives.map((f) => <li key={f}>{f}</li>) : <li className="text-gray-500">None recorded</li>}
          </ul>
          {missing.length > 0 && (
            <p className="mt-4 text-xs text-gray-500">Missing data: {missing.join(", ")}</p>
          )}
        </div>
      </section>

      <p className="text-sm text-gray-300">{row.short_developer_verdict}</p>

      <EnrichButton bbl={row.bbl} initialSummary={summaryText(row.scrape_summary)} />
    </main>
  );
}
