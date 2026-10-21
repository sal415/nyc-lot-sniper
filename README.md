# NYC Lot Sniper

Next.js dashboard for screening NYC PLUTO parcels for underbuilt development sites.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SOCRATA_APP_TOKEN=...   # optional, raises NYC Open Data rate limits
```

3. Run [scripts/setup-supabase.sql](scripts/setup-supabase.sql) in the Supabase SQL editor.

4. Start the app:

```bash
npm run dev
```

Open http://localhost:3000.

## Usage

- Upload a PLUTO CSV from the Dataset panel. Rows are scored in the browser and stored in Supabase.
- Filter by borough, minimum score, or search text. The table is sorted by opportunity score.
- Use **Enrich with live signals** to pull ACRIS sales, mortgages, and liens, plus DOB permits and violations and HPD violations, for every parcel in the active dataset.
- Each row links to its ACRIS BBL search.

## Scripts

```bash
npm run lint
npm run build
npm run start
```
