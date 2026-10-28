# LNG terminals

Source: Global Energy Monitor, Global Gas Infrastructure Tracker, LNG Terminals, October 2026 release
(file `GEM-GGIT-LNG-Terminals-2026-10.xlsx`, sheet "LNG Terminals", 1,268 unit rows; file creation date
October 19, 2026), downloaded by hand from globalenergymonitor.org on 2026-10-28.

Attribution (required by CC BY 4.0): "Global Energy Monitor, Global Gas Infrastructure Tracker, October 2026
release." Copyright (c) Global Energy Monitor, distributed under the Creative Commons Attribution 4.0
International License (https://creativecommons.org/licenses/by/4.0/), as stated in the file's "About" sheet.
Changes made: filtered to operating units, grouped per terminal and reduced to the fields below.

Filter: `Status` is `operating` (404 units), import and export terminals alike. Construction, proposed,
shelved, idled, mothballed, retired and cancelled units are left out. Units are grouped per `ProjectID`.

Feature count: 256 terminals (import 198, export 55, both 3).

Runtime output: `lng-terminals.geojsonl` (one Point feature per line; properties `gem_id`, `name`,
`facility_type` (`import`, `export` or `export/import`), `fuel`, `capacity_mtpa` (operating units summed;
12 operating units have no capacity in the source and count as 0), `country`, `units`).
