"use client";
import { useEffect, useState } from "react";
import type { AIReport } from "@/lib/types";
import type { EnrichmentResult } from "@/lib/scraper";

interface Props {
  bbl: string;
  initial: EnrichmentResult | null;
  initialReport?: AIReport | null;
}

export default function EnrichButton({ bbl, initial, initialReport = null }: Props) {
  const [enriching, setEnriching] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [data, setData] = useState<EnrichmentResult | null>(initial);
  const [report, setReport] = useState<AIReport | null>(initialReport);
  const [error, setError] = useState<string | null>(null);

  // If no report was passed in via props, fetch any persisted report once.
  useEffect(() => {
    if (initialReport) return;
    let cancelled = false;
    fetch(`/api/parcels/${bbl}/report`).then((r) => r.json()).then((j) => {
      const savedReport = parseAIReport(j?.report);
      if (!cancelled && savedReport) setReport(savedReport);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [bbl, initialReport]);

  async function run() {
    setEnriching(true);
    setError(null);
    try {
      const res = await fetch(`/api/parcels/${bbl}/enrich`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Enrichment failed");
      setData(json as EnrichmentResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setEnriching(false);
    }
  }

  async function runReport(force = false) {
    setReporting(true);
    setError(null);
    try {
      const url = force ? `/api/parcels/${bbl}/report?force=1` : `/api/parcels/${bbl}/report`;
      const res = await fetch(url, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Report failed");
      setReport(json as AIReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setReporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <button
        onClick={run}
        disabled={enriching}
        className="inline-flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-indigo-500 font-medium disabled:opacity-50"
      >
        {enriching ? "Scraping ACRIS, DOB, ZoLa, news..." : data ? "Re-enrich" : "Enrich parcel (ACRIS + DOB + ZoLa + news)"}
      </button>
      <button
        onClick={() => runReport(!!report)}
        disabled={reporting}
        className="ml-2 inline-flex items-center gap-2 bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-emerald-600 font-medium disabled:opacity-50"
      >
        {reporting ? "Generating report…" : report ? "Regenerate AI report" : "Generate AI report"}
      </button>
      {report && !reporting && (
        <span className="ml-2 text-xs text-emerald-400">Saved · {new Date(report.generatedAt).toLocaleString()}</span>
      )}
      {error && <p className="text-red-500 text-sm">{error}</p>}

      <div className="border border-emerald-900/70 bg-emerald-950/20 rounded-xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-[11px] font-semibold text-emerald-300 uppercase tracking-wider">AI Analysis</h3>
              {report?.model && (
                <span className="rounded-full border border-emerald-800 bg-emerald-950 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                  {report.model}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm font-semibold text-gray-100">
              {report?.recommendation ?? "No AI report generated yet"}
            </p>
          </div>
          {report && (
            <div className="text-right text-xs text-gray-500">
              <div>{report.confidence}/100 confidence</div>
              <div>{new Date(report.generatedAt).toLocaleString()}</div>
            </div>
          )}
        </div>
        {report ? (
          <>
            <p className="mb-4 text-sm leading-relaxed text-gray-300">{report.opportunityType}</p>
            <div className="grid grid-cols-1 gap-4 text-xs md:grid-cols-3">
              <ReportList title="Why" items={report.why} className="text-emerald-300" />
              <ReportList title="Risks" items={report.risks} className="text-red-300" />
              <ReportList title="Strategy" items={[report.acquisitionStrategy]} className="text-blue-300" />
            </div>
          </>
        ) : (
          <p className="text-sm leading-relaxed text-gray-500">
            Generate a report to create the acquisition recommendation, risk summary, and strategy notes for this parcel.
          </p>
        )}
      </div>

      {data && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-200">Enrichment summary</h2>
            <span className="text-xs text-gray-400">
              Scraped {data.scrapedAt ? new Date(data.scrapedAt).toLocaleString() : "—"}
            </span>
          </div>

          <pre className="bg-gray-800/60 border border-gray-700 rounded-xl px-5 py-4 text-sm text-gray-300 whitespace-pre-wrap font-sans leading-relaxed">
            {data.summary}
          </pre>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* ACRIS panel */}
            {data.acris && (
              <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-5">
                <h3 className="font-semibold text-gray-200 mb-3 flex items-center gap-2">
                  ACRIS documents
                  <a href={data.acris.sourceUrl} target="_blank" rel="noopener noreferrer"
                    className="text-blue-500 text-xs font-normal">↗ view</a>
                </h3>
                <dl className="space-y-1.5 text-sm text-gray-400">
                  <div className="flex justify-between border-b border-gray-700 py-1.5">
                    <span className="text-gray-500">Total documents</span>
                    <span className="font-medium">{data.acris.totalDocuments}</span>
                  </div>
                  {data.acris.lastSaleDate && (
                    <div className="flex justify-between border-b border-gray-700 py-1.5">
                      <span className="text-gray-500">Last deed date</span>
                      <span className="font-medium">{data.acris.lastSaleDate}</span>
                    </div>
                  )}
                  {data.acris.lastSaleAmount && (
                    <div className="flex justify-between border-b border-gray-700 py-1.5">
                      <span className="text-gray-500">Sale amount</span>
                      <span className="font-medium text-emerald-400">{data.acris.lastSaleAmount}</span>
                    </div>
                  )}
                  {data.acris.lastSaleGrantor && (
                    <div className="flex justify-between border-b border-gray-700 py-1.5">
                      <span className="text-gray-500">Grantor (seller)</span>
                      <span className="font-medium text-right max-w-[55%] truncate">{data.acris.lastSaleGrantor}</span>
                    </div>
                  )}
                  {data.acris.lastSaleGrantee && (
                    <div className="flex justify-between border-b border-gray-700 py-1.5">
                      <span className="text-gray-500">Grantee (buyer)</span>
                      <span className="font-medium text-right max-w-[55%] truncate">{data.acris.lastSaleGrantee}</span>
                    </div>
                  )}
                  {data.acris.lastMortgageDate && (
                    <div className="flex justify-between border-b border-gray-700 py-1.5">
                      <span className="text-gray-500">Last mortgage</span>
                      <span className="font-medium">{data.acris.lastMortgageDate}
                        {data.acris.lastMortgageAmount ? ` — ${data.acris.lastMortgageAmount}` : ""}</span>
                    </div>
                  )}
                  {data.acris.recentDocuments.length > 0 && (
                    <div className="pt-2">
                      <p className="text-gray-500 text-xs font-medium mb-1">Recent documents</p>
                      <ul className="space-y-0.5 text-xs text-gray-500">
                        {data.acris.recentDocuments.map((d, i) => (
                          <li key={i}>{d.date} — {d.type}{d.amount ? ` (${d.amount})` : ""}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </dl>
              </div>
            )}

            {/* DOB panel */}
            {data.dob && (
              <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-5">
                <h3 className="font-semibold text-gray-200 mb-3 flex items-center gap-2">
                  DOB BIS profile
                  <a href={data.dob.sourceUrl} target="_blank" rel="noopener noreferrer"
                    className="text-blue-500 text-xs font-normal">↗ view</a>
                </h3>
                <dl className="space-y-0 text-sm">
                  {[
                    ["Building class", data.dob.buildingClass],
                    ["Floors", data.dob.numberOfFloors],
                    ["Dwelling units", data.dob.numberOfUnits],
                    ["Open violations", data.dob.openViolations],
                    ["Active jobs", data.dob.activeJobs],
                    ["Last permit", data.dob.lastPermitDate],
                    ["Certificate of Occupancy", data.dob.certificateOfOccupancy],
                  ].map(([label, val]) =>
                    val != null ? (
                      <div key={label} className="flex justify-between border-b border-gray-700 py-1.5">
                        <span className="text-gray-500">{label}</span>
                        <span className={`font-medium ${label === "Open violations" && Number(val) > 0 ? "text-red-400" : "text-gray-300"}`}>
                          {val}
                        </span>
                      </div>
                    ) : null
                  )} 
                </dl>
                <DobDetailList
                  title="Recent jobs"
                  items={data.dob.recentJobs?.slice(0, 3).map((job) =>
                    `${job.latestActionDate ?? "Date ?"} - ${job.jobType ?? "Job"} ${job.status ?? ""}`
                  ) ?? []}
                />
                <DobDetailList
                  title="Recent permits"
                  items={data.dob.recentPermits?.slice(0, 3).map((permit) =>
                    `${permit.issuanceDate ?? "Date ?"} - ${permit.permitType ?? "Permit"} ${permit.status ?? ""}`
                  ) ?? []}
                />
                <DobDetailList
                  title="ECB/OATH violations"
                  items={data.dob.ecbViolations?.slice(0, 3).map((violation) =>
                    `${violation.issueDate ?? "Date ?"} - ${violation.status ?? "Status ?"} ${violation.number ?? ""}`
                  ) ?? []}
                  danger
                />
                <DobDetailList
                  title="HPD violations"
                  items={data.dob.hpdViolations?.slice(0, 3).map((violation) =>
                    `${violation.inspectionDate ?? "Date ?"} - ${violation.status ?? "Status ?"} ${violation.class ? `Class ${violation.class}` : ""}`
                  ) ?? []}
                />
              </div>
            )}

            {/* ZoLa panel */}
            {data.zola && (
              <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-5">
                <h3 className="font-semibold text-gray-200 mb-3 flex items-center gap-2">
                  ZoLa
                  <a href={data.zola.sourceUrl} target="_blank" rel="noopener noreferrer"
                    className="text-blue-500 text-xs font-normal">↗ view</a>
                </h3>
                {[
                  ["Zoning district", data.zola.zoningDistrict],
                  ["Overlays", data.zola.overlays],
                  ["Special district", data.zola.specialPurposeDistrict],
                  ["Landmark status", data.zola.landmarkStatus],
                  ["Flood zone", data.zola.floodZone],
                  ["Historic district", data.zola.historicDistrict],
                ].some(([, v]) => v != null) ? (
                  <dl className="space-y-0 text-sm">
                    {[
                      ["Zoning district", data.zola.zoningDistrict],
                      ["Overlays", data.zola.overlays],
                      ["Special district", data.zola.specialPurposeDistrict],
                      ["Landmark status", data.zola.landmarkStatus],
                      ["Flood zone", data.zola.floodZone],
                      ["Historic district", data.zola.historicDistrict],
                    ].map(([label, val]) =>
                      val != null ? (
                        <div key={label} className="flex justify-between border-b border-gray-700 py-1.5">
                          <span className="text-gray-500">{label}</span>
                          <span className="font-medium text-gray-300">{val}</span>
                        </div>
                      ) : null
                    )}
                  </dl>
                ) : (
                  <p className="text-gray-400 text-sm">
                    No additional data from the ZoLa API for this parcel.
                    Use the ZoLa link above to view the interactive map.
                  </p>
                )}
              </div>
            )}

            {data.nearby && (
              <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-5">
                <h3 className="font-semibold text-gray-200 mb-3">Nearby context</h3>
                <DetailNearbyList title="Transit" items={data.nearby.transit} />
                <DetailNearbyList title="Schools" items={data.nearby.schools} />
              </div>
            )}

            {data.market && (
              <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-5">
                <h3 className="font-semibold text-gray-200 mb-3">Market context</h3>
                {data.market.assessment && (
                  <dl className="space-y-0 text-sm mb-4">
                    <DetailField label="DOF market value" value={fmtMoney(data.market.assessment.marketValue)} />
                    <DetailField label="Assessed total" value={fmtMoney(data.market.assessment.assessedTotal)} />
                    <DetailField label="Tax class" value={data.market.assessment.taxClass ?? "unknown"} />
                    <DetailField label="Roll year" value={data.market.assessment.year ?? "unknown"} />
                  </dl>
                )}
                <PlainList title="Subject sales" items={data.market.subjectSales.slice(0, 3).map((sale) =>
                  `${sale.saleDate ?? "Date ?"} - ${fmtMoney(sale.salePrice)}${sale.pricePerLandSf ? ` (${fmtMoney(sale.pricePerLandSf)}/land sf)` : ""}`
                )} />
                <PlainList title="Nearby sales comps" items={data.market.nearbySales.slice(0, 4).map((sale) =>
                  `${sale.address ?? "Comp"} - ${fmtMoney(sale.salePrice)}${sale.distanceMiles != null ? `, ${sale.distanceMiles.toFixed(2)} mi` : ""}`
                )} />
              </div>
            )}

            {data.assemblage && (
              <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-5">
                <h3 className="font-semibold text-gray-200 mb-3">Assemblage context</h3>
                <dl className="space-y-0 text-sm mb-4">
                  <DetailField label="Same-owner lots" value={data.assemblage.sameOwnerSameBlock.length} />
                  <DetailField label="Neighbor lots" value={data.assemblage.immediateNeighbors.length} />
                  <DetailField label="Combined lot area" value={`${fmtNum(data.assemblage.potentialCombinedLotArea)} sf`} />
                  <DetailField label="Combined unused SF" value={`${fmtNum(data.assemblage.potentialCombinedUnusedSf)} sf`} />
                </dl>
                <PlainList title="Underbuilt same block" items={data.assemblage.sameBlockUnderbuilt.slice(0, 4).map((parcel) =>
                  `${parcel.address ?? parcel.bbl} - ${fmtNum(parcel.estimatedUnusedBuildableSf)} unused sf`
                )} />
              </div>
            )}

            {data.distress && (
              <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-5">
                <h3 className="font-semibold text-gray-200 mb-3">Distress signals</h3>
                <dl className="space-y-0 text-sm mb-4">
                  <DetailField label="DOF open charge balance" value={fmtMoney(data.distress.openChargeBalance)} />
                  <DetailField label="DOF charge items" value={data.distress.charges.length} />
                  <DetailField label="ACRIS distress filings" value={data.acris?.distressSignals?.length ?? 0} />
                  <DetailField label="Tax liens / lis pendens" value={`${data.acris?.taxLienCount ?? 0} / ${data.acris?.lisPendensCount ?? 0}`} />
                </dl>
                <PlainList title="Property charges" items={data.distress.charges.slice(0, 4).map((charge) =>
                  `${charge.dueDate ?? "Date ?"} - ${charge.code ?? "Charge"} ${fmtMoney(charge.balance)}`
                )} />
                <PlainList title="ACRIS legal filings" items={(data.acris?.distressSignals ?? []).slice(0, 4).map((signal) =>
                  `${signal.date ?? "Date ?"} - ${signal.label} (${signal.type})${signal.amount ? ` ${fmtMoney(signal.amount)}` : ""}`
                )} />
              </div>
            )}

            {data.regulatory && (
              <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-5">
                <h3 className="font-semibold text-gray-200 mb-3">Regulatory risk</h3>
                <dl className="space-y-0 text-sm mb-4">
                  <DetailField label="HPD registered" value={data.regulatory.isHpdRegistered ? "Yes" : "No"} />
                  <DetailField label="Registration end" value={data.regulatory.hpdRegistration?.registrationEndDate ?? "unknown"} />
                </dl>
                {data.regulatory.registrationRiskNote && (
                  <p className="text-sm text-gray-500 mb-3">{data.regulatory.registrationRiskNote}</p>
                )}
                <PlainList title="Registration contacts" items={data.regulatory.hpdRegistration?.contacts ?? []} />
              </div>
            )}

            {data.development && (
              <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-5">
                <h3 className="font-semibold text-gray-200 mb-3">Nearby development momentum</h3>
                <dl className="space-y-0 text-sm mb-4">
                  <DetailField label="DOB filings nearby" value={data.development.nearbyJobs.length} />
                  <DetailField label="Active/recent filings" value={data.development.activeNearbyJobs} />
                  <DetailField label="Proposed units" value={fmtNum(data.development.totalProposedUnits)} />
                </dl>
                <PlainList title="Recent filings" items={data.development.nearbyJobs.slice(0, 4).map((job) =>
                  `${job.latestActionDate ?? "Date ?"} - ${job.address ?? job.jobNumber ?? "Job"} (${job.distanceMiles?.toFixed(2) ?? "?"} mi)`
                )} />
              </div>
            )}

            {data.recentNews && (
              <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-5 md:col-span-3">
                <h3 className="font-semibold text-gray-200 mb-3">Recent property news</h3>
                {data.recentNews.articles.length > 0 ? (
                  <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {data.recentNews.articles.map((article) => (
                      <li key={article.url} className="border border-gray-700 rounded-lg p-3">
                        <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                          <span>{article.publishedDate ?? "Date unknown"}</span>
                          <span>{formatSignalType(article.signalType)}</span>
                          <span>{article.relevance} relevance</span>
                        </div>
                        <a href={article.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-blue-300 hover:text-blue-200">
                          {article.title}
                        </a>
                        <p className="mt-1 text-xs leading-relaxed text-gray-500">{article.snippet}</p>
                        {article.source && <p className="mt-2 text-[11px] text-gray-600">{article.source}</p>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-500">
                    {data.recentNews.sourceNotes[0] ?? "No property-specific news or public activity found."}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ReportList({ title, items, className }: { title: string; items: string[]; className: string }) {
  return (
    <div>
      <h4 className="mb-1 font-semibold uppercase tracking-wider text-gray-500">{title}</h4>
      <ul className="space-y-1">
        {items.map((item, index) => <li key={index} className={className}>{item}</li>)}
      </ul>
    </div>
  );
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

function DetailField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between border-b border-gray-700 py-1.5">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-300 text-right max-w-[55%]">{value}</span>
    </div>
  );
}

function PlainList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mb-4 last:mb-0">
      <h4 className="text-xs uppercase tracking-wider text-gray-500 font-semibold mb-2">{title}</h4>
      <ul className="space-y-1 text-xs text-gray-500">
        {items.map((item, index) => <li key={index}>{item}</li>)}
      </ul>
    </div>
  );
}

function fmtMoney(value: number | string | null | undefined): string {
  if (value == null || value === "") return "unknown";
  const numeric = typeof value === "string" ? Number(value.replace(/[$,]/g, "")) : value;
  return Number.isFinite(numeric) ? `$${Math.round(numeric).toLocaleString()}` : String(value);
}

function fmtNum(value: number | null): string {
  return value == null ? "unknown" : Math.round(value).toLocaleString();
}

function formatSignalType(value: string): string {
  return value.replace(/_/g, " ");
}

function DobDetailList({ title, items, danger = false }: { title: string; items: string[]; danger?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4">
      <h4 className="text-xs uppercase tracking-wider text-gray-500 font-semibold mb-2">{title}</h4>
      <ul className="space-y-1 text-xs">
        {items.map((item, index) => (
          <li key={index} className={danger ? "text-red-300" : "text-gray-500"}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function DetailNearbyList({
  title,
  items,
}: {
  title: string;
  items: NonNullable<EnrichmentResult["nearby"]>["transit"];
}) {
  return (
    <div className="mb-4 last:mb-0">
      <h4 className="text-xs uppercase tracking-wider text-gray-500 font-semibold mb-2">{title}</h4>
      {items.length > 0 ? (
        <ul className="space-y-2 text-sm">
          {items.slice(0, 3).map((item, index) => (
            <li key={`${item.name}-${index}`}>
              <span className="block text-gray-300 font-medium">{item.name}</span>
              <span className="text-gray-500">{item.distanceMiles.toFixed(2)} mi</span>
              {item.detail && <span className="block text-xs text-gray-600">{item.detail}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-600">None found nearby.</p>
      )}
    </div>
  );
}
