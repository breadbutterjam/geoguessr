#!/usr/bin/env python3
"""
Street View location pool generator.

For each map in maps.json it:
  1. resolves the map's boundary (OSM search or OSM id, a bbox, or your own GeoJSON file),
  2. downloads the road network inside it from OpenStreetMap (cached in roads/),
  3. samples random points along the roads (weighted by road length, so the mix is "natural"),
  4. snaps each point to an official outdoor Street View panorama via the metadata endpoint,
  5. filters (minimum capture year, inside boundary, no duplicates, minimum spacing),
  6. tags each location easy / medium / hard from its road type,
  7. writes site/pools/<map id>.json plus site/pools/index.json, ready for the game page.

Usage (run from the folder containing maps.json):
    python generate_pool.py --list
    python generate_pool.py --find "Mumbai"                     # list OSM boundary candidates
    python generate_pool.py --check-boundaries --map mumbai     # no Google calls
    python generate_pool.py --map mumbai --target 200           # small trial run
    python generate_pool.py --map mumbai
    python generate_pool.py --all
    python generate_pool.py --rebuild-index                     # refresh the game's map list

Needs:  pip install requests   and   GOOGLE_MAPS_API_KEY set (only for generation).
"""
import argparse
import bisect
import json
import math
import os
import random
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests

CONFIG_FILE = "maps.json"
BOUNDARY_DIR, ROADS_DIR = "boundaries", "roads"
# Pools are written inside the website folder so the game can load them.
POOL_DIR = os.path.join("site", "pools")

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_LOOKUP_URL = "https://nominatim.openstreetmap.org/lookup"
METADATA_URL = "https://maps.googleapis.com/maps/api/streetview/metadata"
HEADERS = {
    "User-Agent": "streetview-pool-generator/0.1 (personal hobby project)",
    "Accept": "*/*",
}
FATAL_STATUSES = ("REQUEST_DENIED", "OVER_QUERY_LIMIT", "INVALID_REQUEST")


# ---------------------------------------------------------------- geometry helpers

def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def point_in_ring(x, y, ring):
    """Ray casting. ring is a list of (x=lng, y=lat)."""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


class Boundary:
    """One or more polygons; each polygon is [outer_ring, hole_ring, ...] of (lng, lat)."""

    def __init__(self, polygons, source):
        self.polygons = polygons
        self.source = source
        self._bboxes = []
        for poly in polygons:
            xs = [p[0] for p in poly[0]]
            ys = [p[1] for p in poly[0]]
            self._bboxes.append((min(xs), min(ys), max(xs), max(ys)))
        self.west = min(b[0] for b in self._bboxes)
        self.south = min(b[1] for b in self._bboxes)
        self.east = max(b[2] for b in self._bboxes)
        self.north = max(b[3] for b in self._bboxes)

    def contains(self, lat, lng):
        for poly, (x0, y0, x1, y1) in zip(self.polygons, self._bboxes):
            if not (x0 <= lng <= x1 and y0 <= lat <= y1):
                continue
            if point_in_ring(lng, lat, poly[0]) and not any(
                    point_in_ring(lng, lat, hole) for hole in poly[1:]):
                return True
        return False

    def diagonal_m(self):
        return haversine_m(self.south, self.west, self.north, self.east)

    def area_km2(self):
        lat0 = math.radians((self.south + self.north) / 2)
        kx, ky = 111.320 * math.cos(lat0), 110.574

        def ring_area(ring):
            s = 0.0
            for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
                s += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky)
            return abs(s) / 2

        return sum(ring_area(p[0]) - sum(ring_area(h) for h in p[1:]) for p in self.polygons)


def geojson_to_polygons(obj):
    t = obj.get("type")
    if t == "FeatureCollection":
        return [p for f in obj["features"] for p in geojson_to_polygons(f)]
    if t == "Feature":
        return geojson_to_polygons(obj["geometry"])
    if t == "Polygon":
        raw = [obj["coordinates"]]
    elif t == "MultiPolygon":
        raw = obj["coordinates"]
    else:
        return []
    return [[[(c[0], c[1]) for c in ring] for ring in poly] for poly in raw]


# ---------------------------------------------------------------- config

def load_config(path=CONFIG_FILE):
    if not os.path.exists(path):
        sys.exit(f"{path} not found. Run this from the folder that contains it.")
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    defaults = cfg.get("defaults", {})
    maps = []
    for m in cfg["maps"]:
        merged = {**defaults, **m}
        diff = {**defaults.get("difficulty", {}), **m.get("difficulty", {})}
        merged["difficulty"] = diff
        maps.append(merged)
    return maps


# ---------------------------------------------------------------- boundary + roads

def nominatim_search(query, limit=10):
    time.sleep(1.1)  # Nominatim usage policy: at most 1 request per second
    r = requests.get(NOMINATIM_URL, headers=HEADERS, timeout=60, params={
        "q": query, "format": "jsonv2", "polygon_geojson": 1,
        "polygon_threshold": 0.0005, "limit": limit})
    r.raise_for_status()
    return r.json()


def nominatim_lookup(osm_id):
    """osm_id like R1234567 (relation), W123 (way) or N123 (node)."""
    time.sleep(1.1)
    r = requests.get(NOMINATIM_LOOKUP_URL, headers=HEADERS, timeout=60, params={
        "osm_ids": osm_id, "format": "jsonv2", "polygon_geojson": 1,
        "polygon_threshold": 0.0005})
    r.raise_for_status()
    return r.json()


def is_polygon_hit(hit):
    return (hit.get("geojson") or {}).get("type") in ("Polygon", "MultiPolygon")


def osm_id_of(hit):
    return f"{str(hit.get('osm_type', '?'))[:1].upper()}{hit.get('osm_id', '')}"


def pick_polygon(hits):
    """Prefer administrative boundaries, then any polygon."""
    polys = [h for h in hits if is_polygon_hit(h)]
    polys.sort(key=lambda h: 0 if h.get("category") == "boundary" else 1)
    return (polys[0]["geojson"], polys[0].get("display_name", "")) if polys else (None, "")


def find_boundaries(query):
    hits = nominatim_search(query)
    if not hits:
        print("No results at all. Try a different spelling.")
        return
    print(f"{'OSM id':12s} {'kind':24s} {'shape':13s} name")
    for h in hits:
        kind = f"{h.get('category', '')}/{h.get('type', '')}"
        shape = (h.get("geojson") or {}).get("type", "?")
        print(f"{osm_id_of(h):12s} {kind:24s} {shape:13s} {h.get('display_name', '')[:70]}")
    print('\nPick a row whose shape is Polygon or MultiPolygon and put its id in maps.json as\n'
          '  "boundary": { "osm_id": "R1234567" }')


def resolve_boundary(m, refresh=False):
    b = m["boundary"]
    if "bbox" in b:
        s, w, n, e = b["bbox"]
        polys = [[[(w, s), (e, s), (e, n), (w, n), (w, s)]]]
        return Boundary(polys, "bbox from maps.json")

    if "geojson" in b:
        if not os.path.exists(b["geojson"]):
            sys.exit(f"[{m['id']}] GeoJSON file not found: {b['geojson']}")
        with open(b["geojson"], encoding="utf-8") as f:
            polys = geojson_to_polygons(json.load(f))
        if not polys:
            sys.exit(f"[{m['id']}] {b['geojson']} has no Polygon/MultiPolygon.")
        return Boundary(polys, f"file {b['geojson']}")

    if "nominatim" in b or "osm_id" in b or "osm_ids" in b:
        os.makedirs(BOUNDARY_DIR, exist_ok=True)
        cache = os.path.join(BOUNDARY_DIR, f"{m['id']}.geojson")
        ids = b.get("osm_ids", b.get("osm_id"))
        if isinstance(ids, str):
            ids = [i.strip() for i in ids.split(",") if i.strip()]
        key = ",".join(ids) if ids else b["nominatim"]
        if os.path.exists(cache) and not refresh:
            with open(cache, encoding="utf-8") as f:
                cached = json.load(f)
            if cached["properties"].get("key") == key:  # stale if the config changed
                return Boundary(geojson_to_polygons(cached["geometry"]),
                                f"OSM (cached): {cached['properties'].get('name', '')}")
        if ids:
            hits = nominatim_lookup(",".join(ids))
            polys_found = [h for h in hits if is_polygon_hit(h)]
            missing = [i for i in ids if i not in {osm_id_of(h) for h in polys_found}]
            if missing:
                sys.exit(f"[{m['id']}] no polygon returned for OSM id(s): {', '.join(missing)}")
            all_polys = [p for h in polys_found for p in geojson_to_polygons(h["geojson"])]
            geom = {"type": "MultiPolygon",
                    "coordinates": [[[list(c) for c in ring] for ring in poly]
                                    for poly in all_polys]}
            name = " + ".join(h.get("display_name", "").split(",")[0] for h in polys_found)
            what = f"OSM id(s) {key}"
        else:
            geom, name = pick_polygon(nominatim_search(b["nominatim"]))
            what = f"search '{b['nominatim']}'"
        if geom is None:
            sys.exit(
                f"[{m['id']}] OpenStreetMap returned no polygon boundary for {what} "
                "(many Mumbai localities are single points there).\n"
                f'  Options: run  python generate_pool.py --find "{b.get("nominatim", m["name"])}"  '
                'to list candidates and pick one with "osm_id",\n'
                '  or give this map a "bbox": [south, west, north, east], or a '
                '"geojson": "file.geojson" (draw one on geojson.io).')
        with open(cache, "w", encoding="utf-8") as f:
            json.dump({"type": "Feature", "properties": {"name": name, "key": key},
                       "geometry": geom}, f)
        return Boundary(geojson_to_polygons(geom), f"OSM: {name}")

    sys.exit(f"[{m['id']}] boundary needs one of: osm_id, osm_ids, nominatim, bbox, geojson.")


def load_roads(m, boundary, refresh=False):
    os.makedirs(ROADS_DIR, exist_ok=True)
    cache = os.path.join(ROADS_DIR, f"{m['id']}.json")
    if os.path.exists(cache) and not refresh:
        with open(cache) as f:
            roads = json.load(f)
        print(f"  Loaded {len(roads)} roads from {cache}")
        return roads

    types = "|".join(m["highway_types"])
    query = (f'[out:json][timeout:300];way["highway"~"^({types})$"]'
             f"({boundary.south},{boundary.west},{boundary.north},{boundary.east});"
             "out geom qt;")
    print("  Downloading roads from OpenStreetMap (large areas can take a few minutes)...")
    elements = None
    for url in OVERPASS_URLS:
        try:
            r = requests.post(url, data={"data": query}, headers=HEADERS, timeout=420)
            r.raise_for_status()
            elements = r.json()["elements"]
            break
        except Exception as exc:
            print(f"  {url} failed: {exc}")
    if elements is None:
        sys.exit("All Overpass servers failed. Wait a few minutes and try again.")
    roads = [[el["tags"].get("highway", "?"), [[p["lat"], p["lon"]] for p in el["geometry"]]]
             for el in elements if el.get("geometry") and len(el["geometry"]) >= 2]
    with open(cache, "w") as f:
        json.dump(roads, f)
    print(f"  Downloaded and cached {len(roads)} roads")
    return roads


class RoadSampler:
    """Random points along roads, weighted by road length."""

    def __init__(self, roads):
        self.ways, self.cum, total = [], [], 0.0
        for highway, pts in roads:
            seg_cum, acc = [], 0.0
            for a, b in zip(pts, pts[1:]):
                acc += haversine_m(a[0], a[1], b[0], b[1])
                seg_cum.append(acc)
            if acc <= 0:
                continue
            total += acc
            self.ways.append((highway, pts, seg_cum))
            self.cum.append(total)
        self.total = total

    def sample(self, rng):
        i = min(bisect.bisect_left(self.cum, rng.random() * self.total), len(self.ways) - 1)
        highway, pts, seg_cum = self.ways[i]
        d = rng.random() * seg_cum[-1]
        j = min(bisect.bisect_left(seg_cum, d), len(seg_cum) - 1)
        start = seg_cum[j - 1] if j else 0.0
        t = (d - start) / (seg_cum[j] - start) if seg_cum[j] > start else 0.0
        a, b = pts[j], pts[j + 1]
        return a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, highway


# ---------------------------------------------------------------- Street View

def check_pano(task):
    point, key, radius = task
    lat, lng, highway = point
    params = {"location": f"{lat},{lng}", "radius": radius, "source": "outdoor", "key": key}
    data = None
    for attempt in range(3):
        try:
            data = requests.get(METADATA_URL, params=params, headers=HEADERS, timeout=20).json()
            break
        except Exception:
            time.sleep(1 + attempt)
    if data is None:
        return {"status": "ERROR", "highway": highway}
    out = {"status": data.get("status", "ERROR"), "highway": highway}
    if out["status"] == "OK":
        out.update(pano_id=data.get("pano_id"), date=data.get("date", ""),
                   lat=data["location"]["lat"], lng=data["location"]["lng"])
    elif out["status"] in FATAL_STATUSES:
        out["error"] = data.get("error_message", "")
    return out


class SpacingIndex:
    """Rejects locations closer than min_sep_m to one already accepted."""

    def __init__(self, min_sep_m):
        self.min_sep_m = min_sep_m
        self.cell = max(min_sep_m, 1) / 111000.0
        self.cells = {}

    def _key(self, lat, lng):
        return math.floor(lat / self.cell), math.floor(lng / self.cell)

    def too_close(self, lat, lng):
        ky, kx = self._key(lat, lng)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for plat, plng in self.cells.get((ky + dy, kx + dx), ()):
                    if haversine_m(lat, lng, plat, plng) < self.min_sep_m:
                        return True
        return False

    def add(self, lat, lng):
        self.cells.setdefault(self._key(lat, lng), []).append((lat, lng))


def difficulty_for(highway, mapping):
    return mapping.get(highway, "medium")


# ---------------------------------------------------------------- generation

def generate(m, key, args):
    rng = random.Random(args.seed)
    print(f"\n=== {m['name']} ({m['id']}) ===")
    boundary = resolve_boundary(m, args.refresh)
    print(f"  Boundary: {boundary.source}")
    roads = load_roads(m, boundary, args.refresh)
    sampler = RoadSampler(roads)
    if not sampler.ways:
        sys.exit(f"[{m['id']}] no roads found inside the boundary.")

    target = args.target or m["target_size"]
    max_attempts = target * 25
    batch_size = 200
    spacing = SpacingIndex(m["min_separation_m"])
    seen_panos, accepted, rejected = set(), [], Counter()
    attempts = 0

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        while len(accepted) < target and attempts < max_attempts:
            batch = []
            while len(batch) < batch_size:
                lat, lng, hw = sampler.sample(rng)
                attempts += 1
                if boundary.contains(lat, lng):
                    batch.append((lat, lng, hw))
                else:
                    rejected["sampled_outside_boundary"] += 1
                if attempts >= max_attempts:
                    break
            results = list(ex.map(check_pano, [(p, key, m["snap_radius_m"]) for p in batch]))

            fatal = next((r for r in results if r["status"] in FATAL_STATUSES), None)
            if fatal:
                sys.exit(f"Google rejected the request: {fatal['status']} {fatal.get('error', '')}")
            if results and all(r["status"] == "ERROR" for r in results):
                sys.exit("Every request failed (network problem?). Check your connection.")

            for r in results:
                if len(accepted) >= target:
                    break
                if r["status"] != "OK":
                    rejected["no_coverage"] += 1
                    continue
                year = int(r["date"][:4]) if r.get("date", "")[:4].isdigit() else 0
                if year < m["min_year"]:
                    rejected["too_old"] += 1
                elif not boundary.contains(r["lat"], r["lng"]):
                    rejected["snapped_outside_boundary"] += 1
                elif r["pano_id"] in seen_panos:
                    rejected["duplicate"] += 1
                elif spacing.too_close(r["lat"], r["lng"]):
                    rejected["too_close"] += 1
                else:
                    seen_panos.add(r["pano_id"])
                    spacing.add(r["lat"], r["lng"])
                    accepted.append({
                        "pano_id": r["pano_id"],
                        "lat": round(r["lat"], 6),
                        "lng": round(r["lng"], 6),
                        "date": r["date"],
                        "road": r["highway"],
                        "difficulty": difficulty_for(r["highway"], m["difficulty"]),
                    })
            print(f"  {len(accepted)}/{target} accepted ({attempts} points tried)")

    if len(accepted) < target:
        print(f"  WARNING: stopped at {len(accepted)}/{target}. The area may be small or "
              "sparsely covered. Try a larger snap_radius_m or older min_year for this map.")

    scale = m.get("score_scale_m") or round(boundary.diagonal_m() / 10)
    pool = {
        "id": m["id"],
        "name": m["name"],
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bbox": [round(boundary.south, 5), round(boundary.west, 5),
                 round(boundary.north, 5), round(boundary.east, 5)],
        "score_scale_m": scale,
        "settings": {"snap_radius_m": m["snap_radius_m"], "min_year": m["min_year"],
                     "min_separation_m": m["min_separation_m"]},
        "counts": dict(Counter(loc["difficulty"] for loc in accepted)),
        "locations": accepted,
    }
    os.makedirs(POOL_DIR, exist_ok=True)
    out_path = os.path.join(POOL_DIR, f"{m['id']}.json")
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(pool, f, indent=1)
    os.replace(tmp, out_path)

    print(f"  Wrote {out_path}: {len(accepted)} locations, by difficulty {pool['counts']}")
    print(f"  Capture years: {dict(sorted(Counter(l['date'][:4] for l in accepted).items()))}")
    print(f"  Rejected: {dict(rejected)}")
    print(f"  Suggested score scale: {scale} m")
    return pool


def write_index(maps):
    """Writes site/pools/index.json: the list of playable maps the game shows in its menu."""
    os.makedirs(POOL_DIR, exist_ok=True)
    order = {m["id"]: i for i, m in enumerate(maps)}
    entries = []
    for fn in sorted(os.listdir(POOL_DIR)):
        if not fn.endswith(".json") or fn == "index.json":
            continue
        try:
            with open(os.path.join(POOL_DIR, fn), encoding="utf-8") as f:
                d = json.load(f)
            counts = Counter(loc["difficulty"] for loc in d["locations"])
            entries.append({"id": d["id"], "name": d["name"], "file": fn,
                            "count": len(d["locations"]), "counts": dict(counts),
                            "bbox": d.get("bbox"), "score_scale_m": d.get("score_scale_m")})
        except (ValueError, KeyError) as exc:
            print(f"Skipping {fn}: not a valid pool file ({exc})")
    entries.sort(key=lambda e: (order.get(e["id"], 999), e["name"].lower()))
    path = os.path.join(POOL_DIR, "index.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                   "maps": entries}, f, indent=1)
    print(f"Updated {path} with {len(entries)} map(s): "
          f"{', '.join(e['id'] for e in entries) or 'none yet'}")


def check_boundaries(maps, refresh):
    for m in maps:
        b = resolve_boundary(m, refresh)
        print(f"{m['id']:14s} {b.area_km2():8.1f} km2   "
              f"bbox S{b.south:.3f} W{b.west:.3f} N{b.north:.3f} E{b.east:.3f}   [{b.source}]")
    print("\nBoundaries from OSM are saved in boundaries/*.geojson; open one at geojson.io "
          "to confirm it covers the area you meant.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--map", action="append", default=[], help="map id (repeatable)")
    ap.add_argument("--all", action="store_true", help="every enabled map")
    ap.add_argument("--list", action="store_true", help="list maps and exit")
    ap.add_argument("--find", metavar="PLACE", help="search OpenStreetMap for boundary candidates")
    ap.add_argument("--rebuild-index", action="store_true",
                    help="rebuild site/pools/index.json from the pool files and exit")
    ap.add_argument("--check-boundaries", action="store_true", help="resolve boundaries only")
    ap.add_argument("--target", type=int, help="override target pool size")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--refresh", action="store_true", help="re-download boundaries and roads")
    args = ap.parse_args()

    if args.find:
        find_boundaries(args.find)
        return
    maps = load_config()
    by_id = {m["id"]: m for m in maps}
    if args.list:
        for m in maps:
            flag = "" if m.get("enabled", True) else "  (disabled)"
            print(f"{m['id']:14s} {m['name']}{flag}")
        return

    if args.rebuild_index:
        write_index(maps)
        return

    if args.map:
        unknown = [i for i in args.map if i not in by_id]
        if unknown:
            sys.exit(f"Unknown map id(s): {', '.join(unknown)}. Try --list.")
        selected = [by_id[i] for i in args.map]
    elif args.all:
        selected = [m for m in maps if m.get("enabled", True)]
    else:
        sys.exit("Choose maps with --map <id> (repeatable) or --all. See --list.")

    if args.check_boundaries:
        check_boundaries(selected, args.refresh)
        return

    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key:
        sys.exit("Set GOOGLE_MAPS_API_KEY first.")
    for m in selected:
        generate(m, key, args)
    write_index(maps)


if __name__ == "__main__":
    main()
