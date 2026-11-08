import type { AIPacket, ParcelRow } from "./types";
import { generateResearchLinks } from "./links";

export function buildAiPacket(row: ParcelRow): AIPacket {
  const liveEnrichment = row.scrape_summary ? JSON.parse(row.scrape_summary) : null;
  const bulkEnrichment = row.enrichment_data ? JSON.parse(row.enrichment_data) : null;
  return {
    address: row.address,
    bbl: row.bbl,
    borough: row.borough,
    block: row.block,
    lot: row.lot,
    zoning: row.zonedist1,
    building_class: row.bldgclass,
    owner: row.ownername,
    lot_area: row.lotarea,
    lot_frontage: row.lotfront,
    lot_depth: row.lotdepth,
    built_far: row.builtfar,
    residential_far: row.residfar,
    commercial_far: row.commfar,
    facility_far: row.facilfar,
    year_built: row.yearbuilt,
    year_altered_1: row.yearalter1,
    year_altered_2: row.yearalter2,
    overlay1: row.overlay1,
    overlay2: row.overlay2,
    max_buildable_sf: row.max_residential_buildable_sf,
    existing_built_sf: row.existing_built_sf,
    unused_buildable_sf: row.unused_buildable_sf,
    underbuilt_ratio: row.underbuilt_ratio,
    opportunity_score: row.opportunity_score,
    score_reasons: JSON.parse(row.score_reasons || "[]"),
    verdict: row.verdict,
    research_links: generateResearchLinks(row.borough, row.block, row.lot, row.address),
    enrichment: liveEnrichment,
    bulk_enrichment: bulkEnrichment,
  };
}
