# Airports

Source: OurAirports, `airports.csv` (https://davidmegginson.github.io/ourairports-data/airports.csv),
downloaded 2026-10-28 (86,293 rows).

Filter (critical-infrastructure proxy, see the intelligence-layer decision note
`2026-10-27-critical-infrastructure`): `type=large_airport` (tier `major`) plus
`type=medium_airport` with `scheduled_service=yes` (tier `regional`). Closed, small, heliport and seaplane
entries are dropped.

Feature count: 3290 (major 1175, regional 2115)

Runtime output: `airports.geojsonl` (one Point feature per line; properties `id`, `ident`, `name`, `tier`,
`country`, `municipality`, optional `icao`, `iata`).

License: public domain (OurAirports releases its data to the public domain; no attribution required, but
credit to OurAirports is appreciated). Data quality is community-maintained.
