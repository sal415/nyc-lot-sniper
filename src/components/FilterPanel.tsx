"use client";

import type { FilterParams } from "@/lib/types";

const BOROUGHS = [
  { code: "", label: "All boroughs" },
  { code: "MN", label: "Manhattan" },
  { code: "BX", label: "Bronx" },
  { code: "BK", label: "Brooklyn" },
  { code: "QN", label: "Queens" },
  { code: "SI", label: "Staten Island" },
];

interface Props {
  params: FilterParams;
  onChange: (next: FilterParams) => void;
}

const labelCls = "block text-xs font-medium text-gray-400 mb-1";
const inputCls =
  "w-full rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm focus:border-sky-600 focus:outline-none";

export default function FilterPanel({ params, onChange }: Props) {
  return (
    <section className="grid gap-4 rounded-lg border border-gray-800 bg-gray-950 p-4 sm:grid-cols-3">
      <div>
        <label className={labelCls} htmlFor="filter-borough">Borough</label>
        <select
          id="filter-borough"
          className={inputCls}
          value={params.borough ?? ""}
          onChange={(e) => onChange({ ...params, borough: e.target.value || undefined, page: 1 })}
        >
          {BOROUGHS.map((b) => (
            <option key={b.code} value={b.code}>{b.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className={labelCls} htmlFor="filter-min-score">Minimum score</label>
        <input
          id="filter-min-score"
          type="number"
          min={0}
          max={100}
          className={inputCls}
          value={params.minScore ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            onChange({ ...params, minScore: v === "" ? undefined : Number(v), page: 1 });
          }}
        />
      </div>

      <div>
        <label className={labelCls} htmlFor="filter-search">Search</label>
        <input
          id="filter-search"
          type="search"
          placeholder="Address, BBL or owner"
          className={inputCls}
          value={params.search ?? ""}
          onChange={(e) => onChange({ ...params, search: e.target.value || undefined, page: 1 })}
        />
      </div>
    </section>
  );
}
