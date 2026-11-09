#!/usr/bin/env python3
"""
Build the Mumbai data files for the Area Viewer.

Reads open boundary datasets (DataMeet community maps + India Post pincode areas),
cleans names, simplifies geometry for the web, colours neighbours differently, works out how
the five layers nest inside each other, and writes one GeoJSON file per category.

You do NOT need to run this to use the viewer: the generated files are already in
area-viewer/data/mumbai/. It is kept so the data can be rebuilt or audited.

Inputs (git clones of public DataMeet repos), pass with the flags below:
  --municipal  datameet/municipal_spatial_data   (BMC wards + 2017 prabhags)
  --maps       datameet/maps                     (assembly + parliament seats)
  --pincodes   datameet/pincodeboundary          (India Post areas, used for localities)

Needs: pip install shapely pyproj pyshp
"""
import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict

import numpy as np
import shapefile  # pyshp
import shapely
from shapely.algorithms.polylabel import polylabel
from shapely.geometry import MultiPolygon, Polygon, mapping, shape
from shapely.ops import unary_union
from shapely.strtree import STRtree
from shapely.validation import make_valid
from pyproj import Transformer

# ------------------------------------------------------------------ settings you may tweak
SIMPLIFY_DEG = 0.00004        # ~4 m; trade file size against edge detail
GRID_DEG = 0.00001            # coordinates snapped to ~1 m
MIN_PART_M2 = 400             # drop specks smaller than this (square metres)
ADJACENCY_BUFFER_DEG = 0.0002 # ~22 m: neighbours closer than this count as touching (data has small gaps)
PALETTE_SIZE = 8              # must match the number of --c0..--cN tokens in style.css
REL_WITHIN_MIN = 0.50         # "within": at least this share of the area lies inside the other feature
REL_CONTAINS_MIN = 0.50       # "contains": at least this share of the other feature lies inside this one
REL_OVERLAP_MIN = 0.10        # "overlaps": partial overlap worth listing
REL_MAX_OVERLAPS = 6
REL_MAX_CONTAINS = 60

_UTM = Transformer.from_crs(4326, 32643, always_xy=True)  # UTM zone 43N, metres


def to_utm(g):
    """lon/lat geometry -> metres, so areas and overlaps are real."""
    return shapely.transform(g, lambda a: np.column_stack(_UTM.transform(a[:, 0], a[:, 1])))


CATEGORIES = ["parliament", "assembly", "wards", "prabhags", "localities"]
CATEGORY_TITLES = {
    "parliament": "Parliament seat", "assembly": "Assembly seat", "wards": "BMC ward",
    "prabhags": "Prabhag", "localities": "Locality",
}


# ------------------------------------------------------------------ helpers
def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def clean_geom(g):
    if not g.is_valid:
        g = make_valid(g)
    polys = [p for p in (g.geoms if hasattr(g, "geoms") else [g]) if isinstance(p, Polygon) or isinstance(p, MultiPolygon)]
    flat = []
    for p in polys:
        flat.extend(p.geoms if isinstance(p, MultiPolygon) else [p])
    return MultiPolygon(flat) if flat else Polygon()


def web_geom(g):
    """Simplify + snap to a grid, drop specks. Returns a MultiPolygon in lon/lat."""
    g = g.simplify(SIMPLIFY_DEG, preserve_topology=True)
    g = shapely.set_precision(g, GRID_DEG)
    g = clean_geom(g)
    keep = [p for p in g.geoms if to_utm(p).area >= MIN_PART_M2]
    return MultiPolygon(keep) if keep else g


def label_point(g):
    """Point guaranteed to be inside the shape, far from edges (largest part only)."""
    part = max(g.geoms, key=lambda p: p.area) if hasattr(g, "geoms") else g
    p = polylabel(part, tolerance=0.0001)
    return [round(p.y, 5), round(p.x, 5)]


def dsatur_colours(geoms, k):
    """Colour polygons so touching ones differ (DSATUR heuristic)."""
    n = len(geoms)
    buffered = [g.buffer(ADJACENCY_BUFFER_DEG) for g in geoms]
    tree = STRtree(buffered)
    adj = [set() for _ in range(n)]
    for i, b in enumerate(buffered):
        for j in tree.query(b, predicate="intersects"):
            if int(j) != i:
                adj[i].add(int(j))
    colour = [-1] * n
    for _ in range(n):
        # pick uncoloured vertex with most distinct neighbour colours, ties -> most neighbours
        best, best_key = None, None
        for i in range(n):
            if colour[i] != -1:
                continue
            sat = len({colour[j] for j in adj[i] if colour[j] != -1})
            key = (sat, len(adj[i]))
            if best_key is None or key > best_key:
                best, best_key = i, key
        used = {colour[j] for j in adj[best] if colour[j] != -1}
        c = next((c for c in range(k) if c not in used), None)
        if c is None:  # very rare: more than k needed; pick least-used among neighbours
            c = min(range(k), key=lambda c: sum(1 for j in adj[best] if colour[j] == c))
        colour[best] = c
    clashes = sum(1 for i in range(n) for j in adj[i] if j > i and colour[i] == colour[j])
    return colour, clashes


# ------------------------------------------------------------------ loaders
def ward_full(letter_part):
    """'F - North' / 'F/N' / 'H/W' -> 'F/North' style names used by BMC."""
    expand = {"S": "South", "N": "North", "E": "East", "W": "West", "C": "Central"}
    t = letter_part.strip().replace(" - ", "/").replace("-", "/").replace(" ", "")
    if "/" in t:
        a, b = t.split("/", 1)
        t = f"{a}/{expand.get(b.upper(), b.title())}"
    return t


def load_wards(path):
    d = json.load(open(os.path.join(path, "Mumbai", "BMC_Wards.geojson"), encoding="utf-8"))
    out = []
    for f in d["features"]:
        full = ward_full(f["properties"]["name"])
        out.append({
            "id": slug(full), "name": f"{full} Ward" if "/" in full else f"{full} Ward",
            "short": f["properties"]["name"], "geom": clean_geom(shape(f["geometry"])),
            "key": full, "details": [],
        })
    return out


def load_prabhags(path):
    d = json.load(open(os.path.join(path, "Mumbai", "bmc_electoral_wards_2017"), encoding="utf-8"))
    out = []
    for f in sorted(d["features"], key=lambda f: f["properties"]["PRABHAG_NO"]):
        p = f["properties"]
        n = p["PRABHAG_NO"]
        ward = ward_full(p["WARD"])
        out.append({
            "id": f"p-{n}", "name": f"Prabhag {n}", "short": str(n), "num": n,
            "geom": clean_geom(shape(f["geometry"])),
            "details": [
                ["BMC ward", f"{ward} Ward"],
                ["Population", f"{p['POPULATION']:,}"],
                ["SC population", f"{p['SC_POP']:,}"],
                ["ST population", f"{p['ST_POP']:,}"],
            ],
            "ward_key": ward,
        })
    return out


PC_NAMES = {26: "Mumbai North", 27: "Mumbai North West", 28: "Mumbai North East",
            29: "Mumbai North Central", 30: "Mumbai South Central", 31: "Mumbai South"}


def load_parliament_reference(path):
    """DataMeet's 2019 parliamentary file, used for seat numbers/category and as a cross-check.
    It labels both seat 30 and seat 31 'Mumbai South'; seat 30 is Mumbai South Central."""
    d = json.load(open(os.path.join(path, "parliamentary-constituencies", "india_pc_2019_simplified.geojson"), encoding="utf-8"))
    out = {}
    for f in d["features"]:
        p = f["properties"]
        if p["st_name"] == "Maharashtra" and p["pc_no"] in PC_NAMES:
            out[p["pc_no"]] = {"category": p["pc_category"], "geom": clean_geom(shape(f["geometry"]))}
    return out


def build_parliament(assembly, reference):
    """Every Lok Sabha seat in Mumbai is made of whole assembly seats, so merge them.
    This keeps the two layers exactly nested and gives a finer coastline than the 2019 file."""
    out = []
    for pc_no, name in sorted(PC_NAMES.items()):
        parts = [a["geom"] for a in assembly if a["pc_no"] == pc_no]
        merged = unary_union([g.buffer(0.0001) for g in parts]).buffer(-0.0001)  # close hairline gaps
        ref = reference[pc_no]
        a, b = to_utm(clean_geom(merged)), to_utm(ref["geom"])
        iou = a.intersection(b).area / a.union(b).area
        print(f"  parliament check: {name:22s} merged-from-assembly vs DataMeet 2019 file, overlap (IoU) {iou:.2f}")
        out.append({
            "id": slug(name), "name": name, "short": name.replace("Mumbai ", ""), "pc_no": pc_no,
            "geom": clean_geom(merged),
            "details": [["Lok Sabha seat no.", str(pc_no)], ["Category", ref["category"]]],
        })
    return out


ALIASES = {"Vandre East": "Bandra East", "Vandre West": "Bandra West"}


def load_assembly(path):
    r = shapefile.Reader(os.path.join(path, "assembly-constituencies", "India_AC"))
    out = []
    for sr in r.iterShapeRecords():
        d = sr.record.as_dict()
        if d["ST_NAME"].strip().upper() != "MAHARASHTRA" or "MUMBAI" not in d["DIST_NAME"].upper():
            continue
        if d["AC_NO"] == 0:      # unnamed polygons = harbour / creek water, not seats
            continue
        raw = d["AC_NAME"].strip()
        m = re.match(r"^(.*?)\s*\((SC|ST)\)$", raw)
        name, reserved = (m.group(1), m.group(2)) if m else (raw, "")
        district = "Mumbai Suburban" if "SUBURBAN" in d["DIST_NAME"].upper() else "Mumbai City"
        details = [["Assembly seat no.", str(d["AC_NO"])], ["District", district],
                   ["Parliament seat", PC_NAMES.get(d["PC_NO"], "?")]]
        if reserved:
            details.append(["Reserved for", "Scheduled Castes" if reserved == "SC" else "Scheduled Tribes"])
        if name in ALIASES:
            details.insert(0, ["Also written as", ALIASES[name]])
        out.append({
            "id": f"ac-{d['AC_NO']}", "name": name, "short": name, "ac_no": d["AC_NO"],
            "pc_no": d["PC_NO"], "alias": ALIASES.get(name, ""),
            "geom": clean_geom(shape(sr.shape.__geo_interface__)), "details": details,
            "district": district,
        })
    return sorted(out, key=lambda x: x["ac_no"])


# Post-office names that need a hand fix; everything else goes through clean_po_name().
LOCALITY_OVERRIDES = {
    400016: "Mahim", 400029: "Santacruz P&T Colony", 400069: "Andheri East", 400058: "Andheri R.S.",
    400037: "Antop Hill", 400059: "J.B. Nagar", 400096: "SEEPZ", 400065: "A M Colony",
    400093: "Chakala MIDC", 400098: "Vidyanagari", 400099: "Sahar", 400074: "FCI",
    400085: "BARC", 400087: "NITIE", 400076: "IIT Powai", 400027: "VJB Udyan", 400088: "T F Deonar",
    400001: "Mumbai GPO", 400091: "Borivali", 400035: "Raj Bhavan", 400050: "Bandra West",
    400051: "Bandra East", 400052: "Khar", 400054: "Santacruz West", 400055: "Santacruz East",
    400056: "Vile Parle West", 400057: "Vile Parle East",
    # run-together or misspelt in the source
    400006: "Malabar Hill", 400053: "Azad Nagar", 400104: "Motilal Nagar", 400094: "Anushakti Nagar",
    400032: "Mantralaya",
}
SUFFIX = re.compile(r"\s+(post\s*office|p\.?\s*o\.?|s\.?\s*o\.?|h\.?\s*o\.?|dely\s*po|delivery(\s*s\.?\s*o\.?)?|mdg)\.?$", re.I)


def clean_po_name(raw):
    s = re.sub(r"\s+", " ", raw.strip())
    for _ in range(2):
        s = SUFFIX.sub("", s).strip()
    return " ".join(w.capitalize() if not w.isupper() or len(w) > 3 else w for w in s.title().split())


def load_localities(path):
    d = json.load(open(os.path.join(path, "Mumbai", "boundary.geojson"), encoding="utf-8"))
    out = []
    for f in d["features"]:
        p = f["properties"]
        pin = int(p["pin_code"])
        name = LOCALITY_OVERRIDES.get(pin) or clean_po_name(p["area_name"])
        out.append({
            "id": f"pin-{pin}", "name": name, "short": name, "pin": pin,
            "geom": clean_geom(shape(f["geometry"])),
            "details": [["PIN code", str(pin)], ["India Post area name", re.sub(r"\s+", " ", p["area_name"].strip())]],
        })
    names = Counter(o["name"] for o in out)
    for o in out:  # make duplicate display names unique by adding the PIN
        if names[o["name"]] > 1:
            o["name"] = f"{o['name']} ({o['pin']})"
    return sorted(out, key=lambda x: x["pin"])


# ------------------------------------------------------------------ relations between layers
def build_relations(layers):
    proj = {c: [to_utm(f["geom"]) for f in layers[c]] for c in CATEGORIES}
    trees = {c: STRtree(proj[c]) for c in CATEGORIES}
    for c in CATEGORIES:
        for i, f in enumerate(layers[c]):
            f["km2"] = round(proj[c][i].area / 1e6, 2)
            f["rel"] = {}
    for a in CATEGORIES:
        for b in CATEGORIES:
            if a == b:
                continue
            for i, fa in enumerate(layers[a]):
                ga = proj[a][i]
                within, contains, overlaps = [], [], []
                for j in trees[b].query(ga, predicate="intersects"):
                    gb = proj[b][int(j)]
                    inter = ga.intersection(gb).area
                    if inter <= 0:
                        continue
                    share_a, share_b = inter / ga.area, inter / gb.area
                    fb = layers[b][int(j)]
                    if share_a >= REL_WITHIN_MIN:
                        within.append((share_a, fb))
                    elif share_b >= REL_CONTAINS_MIN:
                        contains.append(fb)
                    elif share_a >= REL_OVERLAP_MIN:
                        overlaps.append((share_a, fb))
                rel = {}
                if within:
                    rel["w"] = [[f["name"], round(s * 100)] for s, f in sorted(within, key=lambda x: -x[0])]
                if contains:
                    ordered = sorted(contains, key=lambda f: f.get("num") or f.get("ac_no") or f.get("pin") or 0)
                    rel["c"] = [f["name"] for f in ordered[:REL_MAX_CONTAINS]]
                    if len(ordered) > REL_MAX_CONTAINS:
                        rel["cn"] = len(ordered)
                if overlaps:
                    rel["o"] = [[f["name"], round(s * 100)] for s, f in sorted(overlaps, key=lambda x: -x[0])[:REL_MAX_OVERLAPS]]
                if rel:
                    fa["rel"][b] = rel


# ------------------------------------------------------------------ main
def write_layer(out_dir, cat, feats):
    geoms = [web_geom(f["geom"]) for f in feats]
    colours, clashes = dsatur_colours(geoms, PALETTE_SIZE)
    features = []
    for f, g, col in zip(feats, geoms, colours):
        features.append({
            "type": "Feature",
            "properties": {"id": f["id"], "name": f["name"], "short": f["short"], "color": col,
                           "km2": f["km2"], "lbl": label_point(g), "details": f["details"], "rel": f["rel"],
                           **({"alias": f["alias"]} if f.get("alias") else {})},
            "geometry": mapping(g),
        })
    path = os.path.join(out_dir, f"{cat}.geojson")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh, separators=(",", ":"), ensure_ascii=False)
    print(f"  {cat:11s} {len(features):4d} features  {os.path.getsize(path)/1024:7.1f} KB  colour clashes: {clashes}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--municipal", required=True)
    ap.add_argument("--maps", required=True)
    ap.add_argument("--pincodes", required=True)
    ap.add_argument("--out", required=True, help="e.g. area-viewer/data/mumbai")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    assembly = load_assembly(a.maps)
    layers = {
        "parliament": build_parliament(assembly, load_parliament_reference(a.maps)),
        "assembly": assembly,
        "wards": load_wards(a.municipal),
        "prabhags": load_prabhags(a.municipal),
        "localities": load_localities(a.pincodes),
    }
    expected = {"parliament": 6, "assembly": 36, "wards": 24, "prabhags": 227}
    for c, n in expected.items():
        if len(layers[c]) != n:
            sys.exit(f"{c}: expected {n} features, found {len(layers[c])}")

    # Wards also list their prabhags/assembly numbers via the relation pass below.
    build_relations(layers)
    print("Writing:")
    for c in CATEGORIES:
        write_layer(a.out, c, layers[c])


if __name__ == "__main__":
    main()
