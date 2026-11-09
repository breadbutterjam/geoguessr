# Area Viewer: data notes

All boundaries come from DataMeet community maps (https://github.com/datameet), simplified and
pre-processed by `build_area_data.py` into `data/mumbai/*.geojson`.

| Layer | Source | Licence | Vintage |
|---|---|---|---|
| Parliament seats | Merged from the assembly seats (cross-checked against DataMeet's 2019 parliament file) | CC BY-SA / CC BY | 2008 delimitation |
| Assembly seats | DataMeet India_AC (Election Commission data) | CC BY-SA | 2008 delimitation |
| BMC wards (24) | DataMeet BMC_Wards | CC BY | Not stated |
| Prabhags (227) | DataMeet bmc_electoral_wards_2017, 2011 Census population | CC BY | 2017 election |
| Localities (89) | DataMeet pincodeboundary/Mumbai (India Post PIN areas) | **Licence not stated in repo** | 2014 |

Please check each licence on the DataMeet repos before sharing this publicly; the page credits
already attribute DataMeet.

## Caveats
- **Prabhags are the 2017 map.** About a quarter were redrawn before the Jan 2026 election; not updated here.
- **"Localities" are PIN code areas**, not official localities. Some are named for institutions (BARC, FCI); some PINs have no area in the source.
- Parliament seats are built by merging assembly seats, so edges follow assembly edges.
- DataMeet notes some positional shift in the assembly data.
- The Election Commission spells Bandra as "Vandre"; search accepts both.
- Parliament seat 30 is labelled "Mumbai South" in the source; renamed Mumbai South Central.
- Corporator names are not included.
- The "Where it sits" percentages are computed by area overlap (UTM 43N).

## Rebuilding
1. Download the DataMeet files into a folder (see the constants at the top of `build_area_data.py`).
2. `pip install shapely pyproj pyshp`
3. `python build_area_data.py --out data/mumbai` (use `--help` for the input flags).
