# Ports

Source: NGA World Port Index (Pub. 150), `UpdatedPub150.csv` from https://msi.nga.mil/Publications/WPI,
downloaded 2026-10-28 (3,807 rows).

Filter (proxy for the 3.27 Mt/yr handled threshold; no open tonnage data exists): `Harbor Size` is `Large`
or `Medium`.

Feature count: 550 (large 174, medium 376; 21 flag an LNG terminal facility)

Runtime output: `ports.geojsonl` (one Point feature per line; properties `wpi`, `name`, `size`, `country`,
`harbor_type`, `lng_terminal`, optional `unlocode`).

License: US government work, public domain (NGA).
