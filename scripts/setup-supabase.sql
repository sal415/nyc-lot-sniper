-- Run this in the Supabase SQL Editor to set up the schema.

create table if not exists datasets (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  row_count   integer default 0,
  created_at  timestamptz default now()
);

create table if not exists parcels (
  id                            uuid primary key default gen_random_uuid(),
  dataset_id                    uuid not null references datasets(id) on delete cascade,
  bbl                           text not null,
  borough                       text,
  block                         text,
  lot                           text,
  address                       text,
  lotarea                       real,
  lotfront                      real,
  lotdepth                      real,
  bldgclass                     text,
  ownername                     text,
  ownertype                     text,
  zonedist1                     text,
  zonedist2                     text,
  overlay1                      text,
  overlay2                      text,
  builtfar                      real,
  residfar                      real,
  commfar                       real,
  facilfar                      real,
  yearbuilt                     integer,
  yearalter1                    integer,
  yearalter2                    integer,
  max_residential_buildable_sf  real,
  existing_built_sf             real,
  unused_buildable_sf           real,
  underbuilt_ratio              real,
  unused_far                    real,
  land_opportunity_flag         boolean default false,
  small_building_flag           boolean default false,
  multifamily_flag              boolean default false,
  raw_score                     real default 0,
  opportunity_score             real default 0,
  percentile_rank               real default 0,
  score_reasons                 jsonb default '[]',
  positive_factors              jsonb default '[]',
  negative_factors              jsonb default '[]',
  missing_or_uncertain_data     jsonb default '[]',
  short_developer_verdict       text,
  verdict                       text default 'Likely skip',
  unique(dataset_id, bbl)
);

alter table parcels add column if not exists enrichment_data jsonb;
alter table parcels add column if not exists enriched_at bigint;

create index if not exists idx_parcels_dataset_score
  on parcels(dataset_id, opportunity_score desc);
create index if not exists idx_parcels_dataset_bbl
  on parcels(dataset_id, bbl);
create index if not exists idx_parcels_borough
  on parcels(dataset_id, borough);

create table if not exists watchlist (
  bbl          text primary key,
  note         text default '',
  added_at     timestamptz default now(),
  parcel_data  jsonb
);

create table if not exists explored (
  bbl          text primary key,
  explored_at  timestamptz default now(),
  parcel_data  jsonb
);
