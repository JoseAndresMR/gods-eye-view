# Power plants

Source: Global Energy Monitor, Global Integrated Power Tracker, September 2026 release (file
`Global Integrated Power September 2026 V2.xlsx`, sheet "Power facilities", 183,405 unit rows),
downloaded by hand from globalenergymonitor.org on 2026-10-28.

Attribution (required by CC BY 4.0): "Global Energy Monitor, Global Integrated Power Tracker, September 2026
release." Copyright (c) Global Energy Monitor, distributed under the Creative Commons Attribution 4.0
International License (https://creativecommons.org/licenses/by/4.0/), as stated in the file's "About" sheet.
Changes made: units filtered, summed per plant and reduced to the fields below.

Excluded for licence reasons: unit records with a "TZ ID" in "Other IDs (unit/phase)" (18,730 operating
solar units). The "About" sheet says these were sourced from TransitionZero's Solar Asset Mapper, which is
CC BY-NC 4.0 (not redistributable commercially). No plant crossed the 104 MW threshold because of them only.

Filter (BSI-KritisV Annex 1 threshold, see kb decision 2026-10-27-critical-infrastructure):
1. `Status` is `operating`, units without TZ ID.
2. Units are summed per plant (`GEM location ID`, i.e. one coordinate), capacity in MW.
3. Keep plants with summed capacity >= 104 MW, plus every plant with an operating nuclear unit whatever its size.

Feature count: 12,709 (threshold met `>= 104 MW`: 12,537; `nuclear`: 172, of which 2 are under 104 MW).
By fuel: oil/gas 3,567; wind 2,463; utility-scale solar 2,212; hydropower 2,135; coal 1,956; nuclear 172;
bioenergy 144; geothermal 60.

Runtime output: `power-plants.geojsonl` (one Point feature per line; properties `gem_id`, `name`, `fuel`
(GEM "Type"; `nuclear` if any operating nuclear unit), `technology` (largest-capacity technology of that
fuel), `capacity_mw` (operating, summed), `country`, `units` (operating units counted), `threshold_met`).
Coordinates are GEM's (accuracy varies: exact or approximate).
