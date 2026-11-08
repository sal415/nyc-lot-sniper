import { notFound } from "next/navigation";
import Link from "next/link";
import { getSupabase, isSupabaseConfigured, normalizeParcelRow } from "@/lib/supabase";
import { ParcelRow } from "@/lib/types";
import type { AIReport } from "@/lib/types";
import { generateGoogleMapsEmbedUrl, generateResearchLinks } from "@/lib/links";
import EnrichButton from "@/components/EnrichButton";
import WatchlistButton from "@/components/WatchlistButton";
import { EnrichmentResult } from "@/lib/scraper";

// Always re-render server-side — score factors and enrichment may have just
// been updated, and we don't want stale static HTML.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const VERDICT_COLORS: Record<string, string> = {
  "Strong candidate": "bg-emerald-900/60 text-emerald-300 border-emerald-700",
  "Worth reviewing":  "bg-blue-900/60 text-blue-300 border-blue-700",
  "Weak candidate":   "bg-yellow-900/60 text-yellow-300 border-yellow-700",
  "Likely skip":      "bg-gray-800 text-gray-500 border-gray-700",
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between border-b border-gray-800 py-2">
      <span className="text-gray-500 text-sm">{label}</span>
      <span className="text-gray-200 text-sm font-medium text-right max-w-[60%] truncate">{value ?? "—"}</span>
    </div>
  );
}

function formatDimension(value: number | null): string | null {
  return value == null ? null : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
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

export default async function ParcelDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ bbl: string }>;
  searchParams?: Promise<{ from?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const from = sp.from;
  const backHref =
    from === "watchlist" ? "/?tab=watchlist"
    : from === "explored" ? "/?tab=explored"
    : "/";

  if (!isSupabaseConfigured()) {
    return (
      <div className="min-h-screen bg-gray-950 p-8 text-red-400">
        Database not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
      </div>
    );
  }

  const { bbl } = await params;
  const supabase = getSupabase();

  // Fetch all rows for this BBL across datasets, then pick the best one
  // client-side: prefer rows that have an AI report or enrichment data over
  // those that don't. Doing the ranking in JS avoids Supabase ordering quirks
  // on nullable bigint/jsonb columns.
  const { data: rows, error } = await supabase
    .from("parcels")
    .select("*")
    .eq("bbl", bbl);
  if (error) {
    console.error("[parcel page] supabase error:", error);
  }

  const all = (rows ?? []) as Record<string, unknown>[];
  let synthesizedFromWatchlist = false;
  if (all.length === 0) {
    // No parcels row at all — fall back to the watchlist snapshot if present.
    const { data: wl } = await supabase
      .from("watchlist")
      .select("parcel_data")
      .eq("bbl", bbl)
      .maybeSingle();
    if (!wl?.parcel_data) notFound();
    all.push(wl.parcel_data as Record<string, unknown>);
    synthesizedFromWatchlist = true;
  }
  void synthesizedFromWatchlist;

  // Rank: rows with ai_report > rows with enrichment_data > others.
  const ranked = [...all].sort((a, b) => {
    const aScore = (a.ai_report ? 4 : 0) + (a.enrichment_data ? 2 : 0) + (a.scrape_summary ? 1 : 0);
    const bScore = (b.ai_report ? 4 : 0) + (b.enrichment_data ? 2 : 0) + (b.scrape_summary ? 1 : 0);
    return bScore - aScore;
  });
  const data = ranked[0];

  // Fallback: if no parcel row carries an ai_report, pull it off the
  // watchlist snapshot so the user still sees their saved report.
  let watchlistReport: unknown = null;
  if (!data.ai_report) {
    const { data: wl } = await supabase
      .from("watchlist")
      .select("parcel_data")
      .eq("bbl", bbl)
      .maybeSingle();
    const snap = wl?.parcel_data as Record<string, unknown> | undefined;
    if (snap?.ai_report) watchlistReport = snap.ai_report;
  }

  const { data: wlEntry } = await supabase
    .from("watchlist")
    .select("bbl")
    .eq("bbl", bbl)
    .maybeSingle();
  const inWatchlist = !!wlEntry;

  const row = normalizeParcelRow(data as Record<string, unknown>) as ParcelRow;
  const positives: string[] = JSON.parse(row.positive_factors || "[]");
  const negatives: string[] = JSON.parse(row.negative_factors || "[]");
  const missing:   string[] = JSON.parse(row.missing_or_uncertain_data || "[]");
  // Fall back to legacy score_reasons if the new fields are empty (for rows
  // uploaded before the v2 scoring shipped).
  const legacyReasons: string[] = JSON.parse(row.score_reasons || "[]");
  const hasV2Factors = positives.length + negatives.length > 0;
  const links = generateResearchLinks(row.borough, row.block, row.lot, row.address);
  const mapEmbedUrl = generateGoogleMapsEmbedUrl(row.borough, row.block, row.lot, row.address);
  const existingEnrichment: EnrichmentResult | null = row.scrape_summary ? JSON.parse(row.scrape_summary) : null;
  const enrichmentData: Record<string, unknown> | null = row.enrichment_data ? JSON.parse(row.enrichment_data) : null;
  const savedReport = parseAIReport(row.ai_report) ?? parseAIReport(watchlistReport);

  const verdictCls = VERDICT_COLORS[row.verdict] ?? "bg-gray-800 text-gray-500 border-gray-700";
  const scoreColor =
    row.opportunity_score >= 65 ? "text-emerald-400" :
    row.opportunity_score >= 45 ? "text-blue-400" :
    row.opportunity_score >= 25 ? "text-yellow-400" : "text-gray-500";

  const linkLabels: Record<string, string> = {
    zola: "ZoLa", acris: "ACRIS", dob: "DOB BIS",
    propertyInfo: "Property Info", googleMaps: "Google Maps",
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="bg-gray-950/95 border-b border-gray-800 px-6 py-4 sticky top-0 z-30 backdrop-blur">
        <div className="max-w-5xl mx-auto flex items-center gap-4">
          <Link href={backHref} className="text-indigo-400 hover:text-indigo-300 text-sm">← Back</Link>
          <span className="text-gray-700">|</span>
          <h1 className="text-lg font-bold text-gray-100 truncate">{row.address ?? row.bbl}</h1>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          {/* Top row: score + verdict + actions */}
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div className="flex items-center gap-5">
              <div>
                <div className={`text-6xl font-black tabular-nums ${scoreColor}`}>{row.opportunity_score}</div>
                <div className="text-xs text-gray-500 mt-0.5 text-center">/ 100</div>
              </div>
              <div>
                <span className={`inline-block border rounded-full px-4 py-1.5 text-sm font-semibold ${verdictCls}`}>{row.verdict}</span>
                <p className="mt-2 text-gray-500 text-sm">BBL: <span className="font-mono text-gray-300">{row.bbl}</span></p>
                <p className="text-gray-500 text-sm">Owner: <span className="text-gray-400">{row.ownername ?? "—"}</span>{row.ownertype ? <span className="ml-2 text-gray-600">({row.ownertype})</span> : null}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <WatchlistButton bbl={row.bbl} initialInWatchlist={inWatchlist} />
              <a href={`/api/parcels/${row.bbl}/packet`}
                className="inline-flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-indigo-500 font-medium">
                Export AI packet ↓
              </a>
            </div>
          </div>
          {/* Bottom row: developer verdict as standalone statement */}
          {row.short_developer_verdict && (
            <p className="mt-4 pt-4 border-t border-gray-800/60 text-base text-gray-300 italic leading-relaxed">
              {row.short_developer_verdict}
            </p>
          )}
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-gray-800">
            <div>
              <h2 className="font-semibold text-gray-200">Property map</h2>
              <p className="text-xs text-gray-500 mt-0.5">{row.address ?? `BBL ${row.bbl}`}</p>
            </div>
            <a
              href={links.googleMaps}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-indigo-400 hover:text-indigo-300"
            >
              Open Google Maps
            </a>
          </div>
          <div className="aspect-[16/7] bg-gray-950">
            <iframe
              title={`Map for ${row.address ?? row.bbl}`}
              src={mapEmbedUrl}
              className="h-full w-full border-0"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="font-semibold text-gray-200 mb-3">Location & identity</h2>
            <Field label="Address" value={row.address} />
            <Field label="Borough" value={row.borough} />
            <Field label="Block" value={row.block} />
            <Field label="Lot" value={row.lot} />
            <Field label="BBL" value={<span className="font-mono">{row.bbl}</span>} />
            <Field label="Owner" value={row.ownername} />
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="font-semibold text-gray-200 mb-3">Zoning & classification</h2>
            <Field label="Zone district 1" value={row.zonedist1} />
            <Field label="Zone district 2" value={row.zonedist2} />
            <Field label="Overlay 1" value={row.overlay1} />
            <Field label="Building class" value={row.bldgclass} />
            <Field label="Year built" value={row.yearbuilt} />
            <Field label="Year altered 1" value={row.yearalter1} />
            <Field label="Year altered 2" value={row.yearalter2} />
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="font-semibold text-gray-200 mb-3">FAR & area metrics</h2>
            <Field label="Lot area (sf)" value={row.lotarea?.toLocaleString()} />
            <Field label="Lot frontage" value={formatDimension(row.lotfront)} />
            <Field label="Lot depth" value={formatDimension(row.lotdepth)} />
            <Field label="Built FAR" value={row.builtfar?.toFixed(3)} />
            <Field label="Residential FAR" value={row.residfar?.toFixed(3)} />
            <Field label="Commercial FAR" value={row.commfar?.toFixed(3)} />
            <Field label="Facility FAR" value={row.facilfar?.toFixed(3)} />
            <Field label="Unused FAR" value={row.unused_far?.toFixed(3)} />
            <Field label="Underbuilt ratio" value={row.underbuilt_ratio?.toFixed(3)} />
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="font-semibold text-gray-200 mb-3">Development potential</h2>
            <Field label="Unused buildable SF" value={row.unused_buildable_sf != null ? <span className="text-emerald-400 font-bold text-base">{Math.round(row.unused_buildable_sf).toLocaleString()}</span> : null} />
            <Field label="Max buildable SF" value={row.max_residential_buildable_sf != null ? Math.round(row.max_residential_buildable_sf).toLocaleString() : null} />
            <Field label="Existing built SF" value={row.existing_built_sf != null ? Math.round(row.existing_built_sf).toLocaleString() : null} />
            <Field label="Vacant/land flag" value={row.land_opportunity_flag ? "Yes" : "No"} />
            <Field label="Small bldg flag" value={row.small_building_flag ? "Yes" : "No"} />
            <Field label="Multifamily flag" value={row.multifamily_flag ? "Yes" : "No"} />
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="font-semibold text-gray-200 mb-3">Score breakdown</h2>
          {hasV2Factors ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h3 className="text-xs uppercase tracking-wider text-emerald-400 mb-2">Positive factors</h3>
                {positives.length ? (
                  <ul className="space-y-1.5">
                    {positives.map((r, i) => (
                      <li key={i} className="text-sm text-emerald-300 flex gap-2">
                        <span className="text-emerald-500">+</span>{r}
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-gray-600 text-xs italic">none</p>}
              </div>
              <div>
                <h3 className="text-xs uppercase tracking-wider text-red-400 mb-2">Negative factors</h3>
                {negatives.length ? (
                  <ul className="space-y-1.5">
                    {negatives.map((r, i) => (
                      <li key={i} className="text-sm text-red-300 flex gap-2">
                        <span className="text-red-500">−</span>{r}
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-gray-600 text-xs italic">none</p>}
              </div>
            </div>
          ) : legacyReasons.length > 0 ? (
            <ul className="divide-y divide-gray-800">
              {legacyReasons.map((r, i) => (
                <li key={i} className="py-2 text-sm text-gray-300">{r}</li>
              ))}
            </ul>
          ) : <p className="text-gray-400 text-sm">No scoring details available.</p>}

          {missing.length > 0 && (
            <div className="mt-5 pt-4 border-t border-gray-800">
              <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">Missing or uncertain data</h3>
              <div className="flex flex-wrap gap-1.5">
                {missing.map((m, i) => (
                  <span key={i} className="text-[11px] text-gray-500 bg-gray-800/60 border border-gray-800 rounded px-2 py-0.5">{m}</span>
                ))}
              </div>
            </div>
          )}
        </div>


        {enrichmentData && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="font-semibold text-gray-200 mb-3">
              Enrichment data
              <span className="ml-2 text-xs font-normal text-gray-500">ACRIS · DOB · HPD</span>
              {row.enriched_at && (
                <span className="ml-2 text-xs font-normal text-gray-600">
                  · {new Date(row.enriched_at * 1000).toLocaleDateString()}
                </span>
              )}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
              {([
                ["Last sale date",         enrichmentData.last_sale_date],
                ["Last sale price",        enrichmentData.last_sale_price ? `$${Number(enrichmentData.last_sale_price).toLocaleString()}` : null],
                ["Sold to LLC",            enrichmentData.last_sale_to_llc != null ? (enrichmentData.last_sale_to_llc ? "Yes" : "No") : null],
                ["Recent mortgage date",   enrichmentData.recent_mortgage_date],
                ["Recent mortgage amt",    enrichmentData.recent_mortgage_amount ? `$${Number(enrichmentData.recent_mortgage_amount).toLocaleString()}` : null],
                ["Active DOB jobs",        enrichmentData.active_dob_jobs],
                ["Permits in last 2y",     enrichmentData.recent_permits_2y],
                ["Open DOB violations",    enrichmentData.open_dob_violations],
                ["Open HPD violations",    enrichmentData.open_hpd_violations],
                ["Open charges (count)",   enrichmentData.open_charges_total],
                ["On tax lien sale list",  enrichmentData.in_tax_lien_sale],
                ["ACRIS tax liens",        enrichmentData.acris_tax_lien_count],
                ["ACRIS liens/judgments",  enrichmentData.acris_lien_count],
                ["ACRIS lis pendens",      enrichmentData.acris_lis_pendens_count],
                ["ACRIS foreclosure docs", enrichmentData.acris_foreclosure_count],
                ["Latest ACRIS distress",  enrichmentData.latest_acris_distress_date
                  ? `${enrichmentData.latest_acris_distress_date} (${enrichmentData.latest_acris_distress_type ?? "filing"})`
                  : null],
              ] as Array<[string, unknown]>).map(([k, v]) => (
                <Field key={k} label={k} value={v == null || v === "" || v === false ? null : (typeof v === "boolean" ? "Yes" : String(v))} />
              ))}
            </div>
          </div>
        )}

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="font-semibold text-gray-200 mb-3">Research links</h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {Object.entries(links).map(([key, url]) => (
              <a key={key} href={url} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-between border border-gray-700 rounded-lg px-3 py-2 text-sm text-indigo-400 hover:bg-gray-800 hover:border-indigo-700 transition">
                {linkLabels[key] ?? key}<span>↗</span>
              </a>
            ))}
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="font-semibold text-gray-200 mb-4">
            Live enrichment
            <span className="ml-2 text-xs font-normal text-gray-400">ACRIS · DOB BIS · ZoLa · news</span>
          </h2>
          <EnrichButton bbl={row.bbl} initial={existingEnrichment} initialReport={savedReport} />
        </div>
      </main>
    </div>
  );
}
