import type { ParcelRow } from "@/lib/types";
import { generateAcrisBblSearchUrl } from "@/lib/links";

interface Props {
  rows: ParcelRow[];
  loading: boolean;
}

const VERDICT_COLORS: Record<string, string> = {
  "Strong candidate": "text-emerald-400 bg-emerald-950/50 border-emerald-800",
  "Worth reviewing": "text-sky-400 bg-sky-950/50 border-sky-800",
  "Weak candidate": "text-amber-400 bg-amber-950/50 border-amber-800",
  "Likely skip": "text-gray-400 bg-gray-900 border-gray-700",
};

function fmtNum(value: number | null): string {
  return value == null ? "—" : Math.round(value).toLocaleString();
}

function fmtFar(value: number | null): string {
  return value == null ? "—" : value.toFixed(2);
}

export default function ParcelTable({ rows, loading }: Props) {
  if (!loading && rows.length === 0) {
    return <p className="px-4 py-10 text-center text-sm text-gray-500">No parcels match these filters.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-gray-800 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-4 py-2 font-medium">Address</th>
            <th className="px-4 py-2 font-medium">BBL</th>
            <th className="px-4 py-2 font-medium">Zone</th>
            <th className="px-4 py-2 text-right font-medium">Lot SF</th>
            <th className="px-4 py-2 text-right font-medium">Built / Res FAR</th>
            <th className="px-4 py-2 text-right font-medium">Unused SF</th>
            <th className="px-4 py-2 text-right font-medium">Score</th>
            <th className="px-4 py-2 font-medium">Verdict</th>
            <th className="px-4 py-2 font-medium">Research</th>
          </tr>
        </thead>
        <tbody className={loading ? "opacity-50" : undefined}>
          {rows.map((row) => (
            <tr key={row.bbl} className="border-b border-gray-900 hover:bg-gray-900/60">
              <td className="px-4 py-2">{row.address ?? "—"}</td>
              <td className="px-4 py-2 font-mono text-xs text-gray-400">{row.bbl}</td>
              <td className="px-4 py-2">{row.zonedist1 ?? "—"}</td>
              <td className="px-4 py-2 text-right tabular-nums">{fmtNum(row.lotarea)}</td>
              <td className="px-4 py-2 text-right tabular-nums">
                {fmtFar(row.builtfar)} / {fmtFar(row.residfar)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">{fmtNum(row.unused_buildable_sf)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{row.opportunity_score}</td>
              <td className="px-4 py-2">
                <span className={`rounded border px-2 py-0.5 text-xs ${VERDICT_COLORS[row.verdict] ?? VERDICT_COLORS["Likely skip"]}`}>
                  {row.verdict}
                </span>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
