import type { FilterParams, ParcelRow } from "@/lib/types";
import { generateAcrisBblSearchUrl } from "@/lib/links";

interface Props {
  rows: ParcelRow[];
  loading: boolean;
  params: FilterParams;
  onSort: (sortBy: string) => void;
  watchlistBbls: Set<string>;
  onToggleWatchlist: (row: ParcelRow) => void;
  onMarkExplored: (bbl: string, parcel: ParcelRow) => void;
}

const VERDICT_COLORS: Record<string, string> = {
  "Strong candidate": "text-emerald-400 bg-emerald-950/50 border-emerald-800",
  "Worth reviewing": "text-sky-400 bg-sky-950/50 border-sky-800",
  "Weak candidate": "text-amber-400 bg-amber-950/50 border-amber-800",
  "Likely skip": "text-gray-400 bg-gray-900 border-gray-700",
};

const COLUMNS: Array<{ key: string; label: string; align?: "right" }> = [
  { key: "address", label: "Address" },
  { key: "lotarea", label: "Lot SF", align: "right" },
  { key: "residfar", label: "Res FAR", align: "right" },
  { key: "unused_buildable_sf", label: "Unused SF", align: "right" },
  { key: "opportunity_score", label: "Score", align: "right" },
];

function fmtNum(value: number | null): string {
  return value == null ? "—" : Math.round(value).toLocaleString();
}

function fmtFar(value: number | null): string {
  return value == null ? "—" : value.toFixed(2);
}

function SortHeader({
  label,
  column,
  params,
  onSort,
  align,
}: {
  label: string;
  column: string;
  params: FilterParams;
  onSort: (sortBy: string) => void;
  align?: "right";
}) {
  const active = params.sortBy === column;
  const arrow = active ? (params.sortDir === "asc" ? "▲" : "▼") : "";
  return (
    <th className={`px-4 py-2 font-medium ${align === "right" ? "text-right" : ""}`}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`uppercase tracking-wide hover:text-gray-200 ${active ? "text-gray-200" : ""}`}
      >
        {label} <span className="text-[10px]">{arrow}</span>
      </button>
    </th>
  );
}

export default function ParcelTable({
  rows,
  loading,
  params,
  onSort,
  watchlistBbls,
  onToggleWatchlist,
  onMarkExplored,
}: Props) {
  if (!loading && rows.length === 0) {
    return <p className="px-4 py-10 text-center text-sm text-gray-500">No parcels match these filters.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-gray-800 text-xs text-gray-500">
          <tr>
            {COLUMNS.map((col) => (
              <SortHeader
                key={col.key}
                label={col.label}
                column={col.key}
                params={params}
                onSort={onSort}
                align={col.align}
              />
            ))}
            <th className="px-4 py-2 font-medium uppercase tracking-wide">Verdict</th>
            <th className="px-4 py-2 font-medium uppercase tracking-wide">Note</th>
            <th className="px-4 py-2 font-medium uppercase tracking-wide">Research</th>
            <th className="px-4 py-2 font-medium uppercase tracking-wide">Actions</th>
          </tr>
        </thead>
        <tbody className={loading ? "opacity-50" : undefined}>
          {rows.map((row) => {
            const saved = watchlistBbls.has(row.bbl);
            return (
              <tr key={row.bbl} className="border-b border-gray-900 hover:bg-gray-900/60">
                <td className="px-4 py-2">
                  <div>{row.address ?? "—"}</div>
                  <div className="font-mono text-xs text-gray-500">
                    {row.zonedist1 ?? "—"} · {row.bbl}
                  </div>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{fmtNum(row.lotarea)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmtFar(row.residfar)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmtNum(row.unused_buildable_sf)}</td>
                <td className="px-4 py-2 text-right tabular-nums font-medium">{row.opportunity_score}</td>
                <td className="px-4 py-2">
                  <span className={`rounded border px-2 py-0.5 text-xs ${VERDICT_COLORS[row.verdict] ?? VERDICT_COLORS["Likely skip"]}`}>
                    {row.verdict}
                  </span>
                </td>
                <td className="max-w-xs px-4 py-2 text-xs text-gray-400" title={row.short_developer_verdict ?? undefined}>
                  <span className="line-clamp-2">{row.short_developer_verdict ?? "—"}</span>
                </td>
                <td className="px-4 py-2">
                  <a
                    href={generateAcrisBblSearchUrl(row.borough, row.block, row.lot)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-sky-400 hover:underline"
                  >
                    ACRIS
                  </a>
                </td>
                <td className="px-4 py-2">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => onToggleWatchlist(row)}
                      className={`rounded border px-2 py-1 text-xs ${saved ? "border-amber-800 text-amber-300" : "border-gray-700 hover:bg-gray-800"}`}
                    >
                      {saved ? "★ Saved" : "☆ Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onMarkExplored(row.bbl, row)}
                      className="rounded border border-gray-700 px-2 py-1 text-xs hover:bg-gray-800"
                    >
                      Explored
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
