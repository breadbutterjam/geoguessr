#!/usr/bin/env python3
"""
Mumbai Street View coverage test.

1. Pulls road segments for a bounding box from OpenStreetMap (Overpass API), cached to roads.json.
2. Samples N random road points.
3. Asks the Street View *metadata* endpoint whether an official outdoor panorama exists nearby.
4. Prints a coverage summary and writes results.csv.

The metadata endpoint is listed as unlimited/free, but a billing-enabled key is still required.

Usage:
    pip install requests
    export GOOGLE_MAPS_API_KEY=your_key      # Street View Static API must be enabled
    python coverage_test.py --n 500
    python coverage_test.py --n 1000 --radius 50 --seed 7
"""
import argparse
import csv
import json
import os
import random
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

import requests

# Rough Greater Mumbai box: south, west, north, east.
# This edges into Thane / Navi Mumbai across the creek; fine for a first test.
BBOX = (18.89, 72.77, 19.30, 72.99)
HIGHWAY_TYPES = "primary|secondary|tertiary|residential|unclassified|living_street"
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
# Overpass rejects the default python-requests identity (HTTP 406), so identify ourselves.
HEADERS = {
    "User-Agent": "mumbai-streetview-coverage-test/0.1 (personal hobby project)",
    "Accept": "*/*",
}
METADATA_URL = "https://maps.googleapis.com/maps/api/streetview/metadata"
ROADS_CACHE = "roads.json"


def fetch_roads(bbox):
    if os.path.exists(ROADS_CACHE):
        with open(ROADS_CACHE) as f:
            roads = json.load(f)
        print(f"Loaded {len(roads)} road segments from {ROADS_CACHE}")
        return roads

    s, w, n, e = bbox
    query = f"""
    [out:json][timeout:180];
    way["highway"~"^({HIGHWAY_TYPES})$"]({s},{w},{n},{e});
    out center;
    """
    print("Fetching roads from Overpass (can take a minute)...")
    elements = None
    for url in OVERPASS_URLS:
        try:
            r = requests.post(url, data={"data": query}, headers=HEADERS, timeout=240)
            r.raise_for_status()
            elements = r.json()["elements"]
            break
        except Exception as exc:
            print(f"  {url} failed: {exc}")
    if elements is None:
        sys.exit("All Overpass servers failed. Wait a few minutes and try again.")
    roads = [
        {"lat": el["center"]["lat"], "lng": el["center"]["lon"],
         "highway": el["tags"].get("highway", "?")}
        for el in elements if "center" in el
    ]
    with open(ROADS_CACHE, "w") as f:
        json.dump(roads, f)
    print(f"Fetched and cached {len(roads)} road segments")
    return roads


def check_point(args):
    point, key, radius = args
    params = {
        "location": f"{point['lat']},{point['lng']}",
        "radius": radius,
        "source": "outdoor",
        "key": key,
    }
    for attempt in range(3):
        try:
            data = requests.get(METADATA_URL, params=params, timeout=20).json()
            break
        except Exception:
            time.sleep(1 + attempt)
    else:
        return {**point, "status": "ERROR"}

    status = data.get("status", "ERROR")
    out = {**point, "status": status}
    if status == "OK":
        out.update(pano_id=data.get("pano_id"), date=data.get("date", ""),
                   pano_lat=data["location"]["lat"], pano_lng=data["location"]["lng"])
    elif status in ("REQUEST_DENIED", "OVER_QUERY_LIMIT", "INVALID_REQUEST"):
        out["error"] = data.get("error_message", "")
    return out


def pct(a, b):
    return f"{100 * a / b:5.1f}%" if b else "  n/a"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=500, help="number of sample points")
    ap.add_argument("--radius", type=int, default=50, help="snap radius in metres")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key:
        sys.exit("Set GOOGLE_MAPS_API_KEY first.")

    roads = fetch_roads(BBOX)
    random.seed(args.seed)
    sample = random.sample(roads, min(args.n, len(roads)))

    print(f"Checking {len(sample)} points (radius {args.radius} m)...")
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        results = list(ex.map(check_point, [(p, key, args.radius) for p in sample]))

    # Fail loudly on key/config problems rather than reporting fake 0% coverage.
    errors = [r for r in results if r["status"] in ("REQUEST_DENIED", "OVER_QUERY_LIMIT", "INVALID_REQUEST", "ERROR")]
    if errors:
        print(f"\n{len(errors)} requests failed. First error: {errors[0].get('status')} {errors[0].get('error', '')}")
        if len(errors) == len(results):
            sys.exit("All requests failed; check your key, billing, and that Street View Static API is enabled.")

    valid = [r for r in results if r["status"] in ("OK", "ZERO_RESULTS")]
    ok = [r for r in valid if r["status"] == "OK"]
    unique_panos = len({r["pano_id"] for r in ok})

    print("\n=== Overall ===")
    print(f"Coverage: {len(ok)}/{len(valid)} ({pct(len(ok), len(valid))}), unique panoramas: {unique_panos}")

    print("\n=== By road type ===")
    by_type = defaultdict(lambda: [0, 0])
    for r in valid:
        by_type[r["highway"]][1] += 1
        by_type[r["highway"]][0] += r["status"] == "OK"
    for t, (a, b) in sorted(by_type.items(), key=lambda x: -x[1][1]):
        print(f"{t:14s} {a:4d}/{b:<4d} {pct(a, b)}")

    print("\n=== Capture year (of covered points) ===")
    years = Counter(r["date"][:4] for r in ok if r.get("date"))
    for y, c in sorted(years.items()):
        print(f"{y or '????'}  {c:4d} {pct(c, len(ok))}")

    print("\n=== Coarse grid (~5 km cells; lat,lng of south-west corner) ===")
    grid = defaultdict(lambda: [0, 0])
    for r in valid:
        cell = (round(r["lat"] // 0.05 * 0.05, 2), round(r["lng"] // 0.05 * 0.05, 2))
        grid[cell][1] += 1
        grid[cell][0] += r["status"] == "OK"
    for cell, (a, b) in sorted(grid.items(), reverse=True):
        if b >= 5:
            print(f"{cell[0]:.2f},{cell[1]:.2f}  {a:3d}/{b:<3d} {pct(a, b)}")

    fields = ["lat", "lng", "highway", "status", "pano_id", "date", "pano_lat", "pano_lng"]
    with open("results.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(results)
    print("\nWrote results.csv")


if __name__ == "__main__":
    main()
