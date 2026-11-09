/* ==========================================================================
   Area Viewer: app logic
   Sections
     1. Setup and state
     2. Small helpers
     3. Data loading
     4. Map, layers and labels
     5. Selecting areas
     6. Side panel: note, list, detail
     7. Top bar controls and shareable links
     8. Start
   ========================================================================== */

(function () {
  "use strict";


  /* ---------- 1. Setup and state ------------------------------------------ */

  const CFG = window.AREA_VIEWER_CONFIG;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  const $ = (id) => document.getElementById(id);
  const dom = {
    title: $("app-title"), citySlot: $("city-slot"), cats: $("categories"),
    overlay: $("overlay"), placeNames: $("place-names"), focusMode: $("focus-mode"),
    app: $("app"), settingsBtn: $("settings-btn"), settingsPane: $("settings-pane"), panelToggle: $("panel-toggle"),
    map: $("map"), banner: $("banner"),
    panel: $("panel"), note: $("note"), detail: $("detail"), mine: $("mine"),
    mineBtn: $("mine-btn"), mineCount: $("mine-count"),
    search: $("search"), count: $("count"), list: $("list"), credits: $("credits"),
  };

  const state = { city: null, cat: null, selectedId: null, overlay: "", query: "", focus: false, mine: false };

  let city;                 // the active city block from config
  let cats = [];            // its categories, in config order
  const catById = {};
  const data = {};          // catId -> { features, byId, byName }
  const views = {};         // catId -> { group, layers: Map(id -> layer), markers: Map(id -> marker), labels }

  let map, baseTiles, nameTiles, overlayLayer, selectedLayer, mineLayer;
  let mineKeys = [];        // "category/id" of every area in the custom map
  let mineName = "My map";
  let areaRenderer, outlineRenderer;
  let look = {};            // colours read from the CSS tokens


  /* ---------- 2. Small helpers --------------------------------------------- */

  /** Build a DOM node. All text goes in as text, never as HTML. */
  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) node.append(kid);
    return node;
  }

  /** Replace an element's children. Skips null/false (replaceChildren would print "null"). */
  function fill(element, ...kids) {
    element.replaceChildren(...kids.flat(Infinity).filter((kid) => kid != null && kid !== false));
  }

  function formatKm2(km2) {
    return km2.toFixed(km2 < 10 ? 2 : 1) + " km²";
  }

  /** Read the colour tokens from style.css so the map follows the theme. */
  function readLook() {
    const css = getComputedStyle(document.documentElement);
    const get = (name) => css.getPropertyValue(name).trim();
    look = {
      palette: Array.from({ length: CFG.paletteSize }, (_, i) => get("--c" + i)),
      alpha: parseFloat(get("--fill-alpha")) || 0.6,
      edge: get("--edge"),
      select: get("--select"),
      outline: get("--outline"),
    };
  }

  const baseStyle = (feature) => ({
    fillColor: look.palette[feature.properties.color % look.palette.length],
    fillOpacity: look.alpha, color: look.edge, weight: 1.2, opacity: 1,
  });
  const hoverStyle = () => ({ color: look.select, weight: 2, fillOpacity: Math.min(look.alpha + 0.14, 0.85) });
  // In "show only the selected area" mode the fill keeps the normal opacity, so the map shows through.
  const selectedStyle = () => ({ color: look.select, weight: 3.5, opacity: 1,
    fillOpacity: state.focus ? look.alpha : Math.min(look.alpha + 0.27, 0.9) });


  /* ---------- 3. Data loading ---------------------------------------------- */

  async function loadData() {
    const loaded = await Promise.all(cats.map(async (cat) => {
      const res = await fetch(city.dataPath + cat.file);
      if (!res.ok) throw new Error(cat.file + ": " + res.status);
      return [cat, await res.json()];
    }));

    for (const [cat, collection] of loaded) {
      const byId = new Map(), byName = new Map();
      for (const feature of collection.features) {
        const p = feature.properties;
        const found = cat.metaDetail && p.details.find((d) => d[0] === cat.metaDetail);
        p._meta = found ? found[1] : formatKm2(p.km2);
        p._haystack = [p.name, p.alias || "", p.short, found ? found[1] : ""].join(" ").toLowerCase();
        byId.set(p.id, feature);
        byName.set(p.name, feature);
      }
      data[cat.id] = { features: collection.features, byId, byName };
    }
  }


  /* ---------- 4. Map, layers and labels ------------------------------------ */

  function initMap() {
    map = L.map(dom.map, {
      minZoom: 9, zoomSnap: 1, preferCanvas: true,
      maxBounds: city.maxBounds, maxBoundsViscosity: 0.8,
    }).setView(city.center, city.zoom);

    // Two extra layers that sit above the areas but never take clicks
    for (const [name, z] of [["outlines", 450], ["placeNames", 460]]) {
      map.createPane(name);
      map.getPane(name).style.zIndex = z;
      map.getPane(name).style.pointerEvents = "none";
    }
    areaRenderer = L.canvas({ padding: 0.3 });
    outlineRenderer = L.canvas({ pane: "outlines", padding: 0.3 });

    const scheme = darkQuery.matches ? "dark" : "light";
    const tileOptions = { subdomains: CFG.basemap.subdomains, maxZoom: CFG.basemap.maxZoom, detectRetina: true };
    baseTiles = L.tileLayer(tileUrl(scheme, "tiles"), { ...tileOptions, attribution: CFG.basemap.attribution }).addTo(map);
    nameTiles = L.tileLayer(tileUrl(scheme, "labels") || "", { ...tileOptions, pane: "placeNames" });
    // Without a CARTO key the fallback map already has names, so the checkbox is not needed.
    dom.placeNames.closest(".opt").hidden = !CFG.basemap.apiKey;

    map.on("zoomend", updateLabelVisibility);
    map.on("click", clearSelection);   // clicking empty map deselects (areas stop their own clicks)
    new ResizeObserver(() => map.invalidateSize()).observe(dom.map);
  }

  /** Tile address for the current theme. With a CARTO key: CARTO tiles. Without: the keyless fallback. */
  function tileUrl(scheme, kind) {
    const b = CFG.basemap;
    if (!b.apiKey) return kind === "tiles" ? b.fallback : "";
    return b[scheme][kind] + "?key=" + encodeURIComponent(b.apiKey);
  }

  /** Build (once) the polygons and name labels for one category. */
  function getView(cat) {
    if (views[cat.id]) return views[cat.id];

    const layers = new Map();
    const group = L.geoJSON({ type: "FeatureCollection", features: data[cat.id].features }, {
      renderer: areaRenderer, style: baseStyle, bubblingMouseEvents: false,
      onEachFeature(feature, layer) {
        const p = feature.properties;
        layers.set(p.id, layer);
        layer.bindTooltip(p.name, { sticky: true, className: "hover-tip", direction: "top", opacity: 1 });
        layer.on({
          mouseover: () => { if (layer !== selectedLayer) layer.setStyle(hoverStyle()); },
          mouseout: () => { if (layer !== selectedLayer) group.resetStyle(layer); },
          click: () => select(cat.id, p.id),
        });
      },
    });

    const markers = new Map();
    const labels = L.layerGroup();
    for (const feature of data[cat.id].features) {
      const text = h("span", { text: feature.properties.short });
      const icon = L.divIcon({ className: "area-label", html: text, iconSize: [0, 0] });
      const marker = L.marker(feature.properties.lbl, { icon, interactive: false, keyboard: false });
      markers.set(feature.properties.id, marker);
      labels.addLayer(marker);
    }

    views[cat.id] = { group, layers, markers, labels };
    return views[cat.id];
  }

  function updateLabelVisibility() {
    const cat = catById[state.cat];
    if (!cat) return;
    dom.map.classList.toggle("labels-off", map.getZoom() < cat.labelMinZoom);
    dom.map.classList.toggle("big-labels", map.getZoom() >= 15);
  }

  /** "Show only the selected area": with an area selected, every other area (and its label) leaves the map. */
  function applyFocus() {
    const view = views[state.cat];
    if (!view) return;
    const only = state.focus ? state.selectedId : null;
    for (const [id, layer] of view.layers) {
      const show = !only || id === only;
      if (show !== view.group.hasLayer(layer)) show ? view.group.addLayer(layer) : view.group.removeLayer(layer);
      const marker = view.markers.get(id);
      if (show !== view.labels.hasLayer(marker)) show ? view.labels.addLayer(marker) : view.labels.removeLayer(marker);
    }
    if (selectedLayer) selectedLayer.bringToFront();
  }

  /** Dashed outlines of a second category, drawn over the areas. */
  function applyOverlay() {
    if (overlayLayer) { map.removeLayer(overlayLayer); overlayLayer = null; }
    if (!state.overlay || state.overlay === state.cat) return;
    overlayLayer = L.geoJSON({ type: "FeatureCollection", features: data[state.overlay].features }, {
      renderer: outlineRenderer, pane: "outlines", interactive: false,
      style: { fill: false, color: look.outline, weight: 1.6, dashArray: "5 4", opacity: 0.85 },
    }).addTo(map);
  }

  /** Re-read colours and swap tiles when the system switches between light and dark. */
  function applyTheme() {
    readLook();
    const scheme = darkQuery.matches ? "dark" : "light";
    baseTiles.setUrl(tileUrl(scheme, "tiles"));
    nameTiles.setUrl(tileUrl(scheme, "labels") || "");
    if (!state.cat) return;
    views[state.cat].group.setStyle(baseStyle);
    if (selectedLayer) selectedLayer.setStyle(selectedStyle());
    applyOverlay();
    renderList();
  }


  /* ---------- 5. Selecting areas ------------------------------------------- */

  function setCategory(catId) {
    if (state.mine) setMine(false);   // leaving "My map" brings the normal layer back
    if (state.cat === catId) return;

    if (state.cat) {
      const old = views[state.cat];
      state.selectedId = null; applyFocus();   // put every area back before leaving the category
      map.removeLayer(old.group);
      map.removeLayer(old.labels);
    }
    selectedLayer = null;
    state.cat = catId;
    state.selectedId = null;
    state.query = "";
    dom.search.value = "";

    const view = getView(catById[catId]);
    view.group.addTo(map);
    view.labels.addTo(map);

    if (state.overlay === catId) state.overlay = "";
    updateCats();
    renderOverlayOptions();
    applyOverlay();
    renderNote();
    renderList();
    renderDetail();
    updateLabelVisibility();
    writeHash();
  }

  function select(catId, id, options) {
    if (catId !== state.cat) setCategory(catId);
    const view = views[state.cat];
    const layer = view.layers.get(id);
    if (!layer) return;

    if (selectedLayer && selectedLayer !== layer) view.group.resetStyle(selectedLayer);
    selectedLayer = layer;
    state.selectedId = id;
    layer.setStyle(selectedStyle());
    layer.bringToFront();
    applyFocus();

    renderDetail();
    markListSelection();
    writeHash();
    if (options && options.fit) {
      map.fitBounds(layer.getBounds(), { padding: [48, 48], maxZoom: 15, animate: !reducedMotion });
    }
  }

  function clearSelection() {
    if (!state.selectedId) return;
    const view = views[state.cat];
    if (selectedLayer) view.group.resetStyle(selectedLayer);
    selectedLayer = null;
    state.selectedId = null;
    applyFocus();
    renderDetail();
    markListSelection();
    writeHash();
  }

  /** Jump to an area by name in any category (used by the "Where it sits" links). */
  function goTo(catId, name) {
    const feature = data[catId].byName.get(name);
    if (feature) select(catId, feature.properties.id, { fit: true });
  }


  /* ---------- 6. Side panel: note, list, detail ---------------------------- */

  function renderNote() {
    const cat = catById[state.cat];
    fill(dom.note,
      h("p", { class: "about", text: cat.about }),
      h("p", { class: "vintage", text: cat.vintage }),
      cat.caution ? h("p", { class: "caution", text: cat.caution }) : null,
    );
  }

  function visibleFeatures() {
    const features = data[state.cat].features;
    const tokens = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return features;
    return features.filter((f) => tokens.every((t) => f.properties._haystack.includes(t)));
  }

  function renderList() {
    const cat = catById[state.cat];
    const total = data[cat.id].features.length;
    const shown = visibleFeatures();

    dom.count.textContent = state.query ? `${shown.length} of ${total}` : `${total} ${cat.plural}`;

    if (!shown.length) {
      dom.list.replaceChildren(h("li", {
        class: "empty",
        text: `Nothing matches "${state.query}". Try part of a name, a number or a PIN code.`,
      }));
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const feature of shown) {
      const p = feature.properties;
      fragment.append(h("li", {},
        h("button", {
          class: "item", type: "button", "data-id": p.id,
          "aria-current": p.id === state.selectedId ? "true" : null,
          onclick: () => select(cat.id, p.id, { fit: true }),
        },
          h("span", { class: "swatch", style: `background:${look.palette[p.color % look.palette.length]}` }),
          h("span", { class: "nm", text: p.name }),
          h("span", { class: "meta", text: p._meta }),
        ),
      ));
    }
    dom.list.replaceChildren(fragment);
  }

  function markListSelection() {
    for (const button of dom.list.querySelectorAll(".item")) {
      const on = button.dataset.id === state.selectedId;
      if (on) { button.setAttribute("aria-current", "true"); button.scrollIntoView({ block: "nearest" }); }
      else button.removeAttribute("aria-current");
    }
  }

  /** A clickable name that jumps to that area. pct is how much of this area it covers. */
  function chip(catId, name, pct) {
    return h("button", { class: "link", type: "button", onclick: () => goTo(catId, name) },
      name, pct ? h("span", { class: "pct", text: ` ${pct}%` }) : null);
  }

  /** One row of "Where it sits": how the selected area relates to another category. */
  function relationRow(other, rel) {
    if (!rel) return null;
    const lines = [];

    if (rel.w) {
      lines.push(h("div", {}, h("span", { class: "lead", text: "Within" }),
        rel.w.map(([name, pct]) => chip(other.id, name, pct < 95 ? pct : null))));
    }
    if (rel.c) {
      const count = rel.cn || rel.c.length;
      if (count <= 4) {
        lines.push(h("div", {}, h("span", { class: "lead", text: "Contains" }),
          rel.c.map((name) => chip(other.id, name))));
      } else {
        lines.push(h("details", {},
          h("summary", { text: `Contains ${count} ${other.plural}` }),
          h("div", {}, rel.c.map((name) => chip(other.id, name)))));
      }
    }
    if (rel.o) {
      lines.push(h("div", {}, h("span", { class: "lead", text: "Overlaps" }),
        rel.o.map(([name, pct]) => chip(other.id, name, pct))));
    }
    return h("div", { class: "rel" }, h("div", { class: "cat-name", text: other.label }), h("div", { class: "lines" }, lines));
  }

  function renderDetail() {
    const feature = state.selectedId && data[state.cat].byId.get(state.selectedId);
    dom.detail.hidden = !feature;
    dom.panel.classList.toggle("has-detail", Boolean(feature));
    if (!feature) { fill(dom.detail); return; }

    const p = feature.properties;
    const cat = catById[state.cat];
    const facts = [...p.details, ["Area", formatKm2(p.km2)]];
    const rows = cats.filter((c) => c.id !== cat.id).map((c) => relationRow(c, p.rel[c.id])).filter(Boolean);

    fill(dom.detail,
      h("div", { class: "detail-head" },
        h("div", {},
          h("h2", { text: p.name }),
          h("p", { class: "kind", text: cat.singular })),
        h("button", { class: "close", type: "button", onclick: clearSelection, text: "Close" })),
      h("button", {
        class: "tool add-mine", type: "button",
        "aria-pressed": String(mineHas(cat.id, p.id)),
        onclick: () => { toggleMine(cat.id, p.id); const top = dom.detail.scrollTop; renderDetail(); dom.detail.scrollTop = top; },
        text: mineHas(cat.id, p.id) ? "Remove from my map" : "Add to my map",
      }),
      cat.caution ? h("p", { class: "caution", text: cat.caution }) : null,
      h("dl", { class: "facts" }, facts.map(([label, value]) => [h("dt", { text: label }), h("dd", { text: value })])),
      rows.length ? h("div", { class: "where" }, h("h3", { text: "Where it sits" }), rows) : null,
    );
    dom.detail.scrollTop = 0;
  }


  /* ---------- 6b. My map: collect areas, download them for the game --------- */

  const MINE_STORE = "areaviewer.mine.";

  function loadMine() {
    try {
      const saved = JSON.parse(localStorage.getItem(MINE_STORE + state.city) || "null");
      if (saved) { mineKeys = saved.keys || []; mineName = saved.name || mineName; }
    } catch (e) { /* storage unavailable: start empty */ }
    // drop anything that no longer exists in the data
    mineKeys = mineKeys.filter((key) => mineFeature(key));
  }

  function saveMine() {
    try { localStorage.setItem(MINE_STORE + state.city, JSON.stringify({ keys: mineKeys, name: mineName })); } catch (e) { /* skip */ }
  }

  const mineKey = (catId, id) => catId + "/" + id;
  const mineHas = (catId, id) => mineKeys.includes(mineKey(catId, id));

  function mineFeature(key) {
    const [catId, id] = key.split("/");
    return data[catId] && data[catId].byId.get(id);
  }

  /** The areas in the custom map, as { cat, feature }. */
  function mineItems() {
    return mineKeys.map((key) => ({ key, cat: catById[key.split("/")[0]], feature: mineFeature(key) }));
  }

  function toggleMine(catId, id) {
    const key = mineKey(catId, id);
    mineKeys = mineKeys.includes(key) ? mineKeys.filter((k) => k !== key) : [...mineKeys, key];
    saveMine();
    mineChanged();
  }

  function mineChanged() {
    dom.mineCount.textContent = mineKeys.length;
    if (state.mine) { buildMineLayer(); renderMine(); }
  }

  /** "bandra-and-khar" from "Bandra & Khar": the file name and map id. */
  function slug(name) {
    return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "my-map";
  }

  function buildMineLayer() {
    if (mineLayer) { map.removeLayer(mineLayer); mineLayer = null; }
    const features = mineItems().map((item) => item.feature);
    if (!features.length) return;
    mineLayer = L.geoJSON({ type: "FeatureCollection", features }, {
      renderer: areaRenderer, bubblingMouseEvents: false,
      style: (feature) => ({ ...baseStyle(feature), weight: 2.2, color: look.select }),
      onEachFeature: (feature, layer) => layer.bindTooltip(feature.properties.name, { sticky: true, className: "hover-tip", direction: "top", opacity: 1 }),
    }).addTo(map);
  }

  /** Switch the map and panel between the normal layers and the custom map. */
  function setMine(on) {
    if (state.mine === on) return;
    state.mine = on;
    const view = state.cat && views[state.cat];
    if (on) {
      if (view) { map.removeLayer(view.group); map.removeLayer(view.labels); }
      if (overlayLayer) map.removeLayer(overlayLayer);
      buildMineLayer();
      renderMine();
      if (mineLayer) map.fitBounds(mineLayer.getBounds(), { padding: [48, 48], animate: !reducedMotion });
    } else {
      if (mineLayer) { map.removeLayer(mineLayer); mineLayer = null; }
      if (view) { view.group.addTo(map); view.labels.addTo(map); }
      applyOverlay();
    }
    dom.mine.hidden = !on;
    dom.panel.classList.toggle("mode-mine", on);
    dom.mineBtn.setAttribute("aria-pressed", String(on));
    updateCats();
  }

  function renderMine() {
    const items = mineItems();
    const fileNote = h("code", { id: "mine-file", text: "" });
    const download = h("button", { class: "tool primary", type: "button", onclick: downloadMine, text: "Download map file" });
    const refresh = () => {
      const id = slug(mineName);
      fileNote.textContent = `custom_maps/${id}.geojson`;
      download.disabled = !items.length;
      steps.textContent = `python generate_pool.py --map ${id}`;
    };
    const steps = h("code", { class: "cmd" });
    const nameInput = h("input", {
      type: "text", value: mineName, maxlength: "40", "aria-label": "Map name",
      oninput: (event) => { mineName = event.target.value.trim() || "My map"; saveMine(); refresh(); },
    });

    fill(dom.mine,
      h("h2", { text: "My map" }),
      h("p", { class: "about", text: "Collect areas from any tab with “Add to my map”. Together they become one map for the game." }),
      h("label", { class: "field" }, h("span", { text: "Map name" }), nameInput),
      items.length
        ? h("ul", { class: "mine-list" }, items.map((item) => h("li", {},
            h("span", { class: "kind", text: item.cat.singular }),
            h("span", { class: "nm", text: item.feature.properties.name }),
            h("button", { class: "close", type: "button", onclick: () => toggleMine(...item.key.split("/")), "aria-label": "Remove " + item.feature.properties.name, text: "Remove" }))))
        : h("p", { class: "empty", text: "Nothing added yet. Open any tab, select an area, and press “Add to my map”." }),
      h("div", { class: "mine-actions" },
        download,
        items.length ? h("button", { class: "tool", type: "button", text: "Clear all", onclick: () => { mineKeys = []; saveMine(); mineChanged(); } }) : null),
      h("div", { class: "mine-steps" },
        h("p", { text: "To play it:" }),
        h("ol", {},
          h("li", {}, "Save the file as ", fileNote),
          h("li", {}, "In your project folder, run ", steps))),
    );
    refresh();
  }

  function downloadMine() {
    const items = mineItems().filter((item) => item.feature);
    if (!items.length) return;
    const id = slug(mineName);
    const file = {
      type: "FeatureCollection",
      map: { id, name: mineName, city: state.city },   // read by generate_pool.py
      features: items.map((item) => ({
        type: "Feature",
        properties: { name: item.feature.properties.name, layer: item.cat.id },
        geometry: item.feature.geometry,
      })),
    };
    const link = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/geo+json" })), download: id + ".geojson" });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }


  /* ---------- 7. Top bar controls and shareable links ---------------------- */

  function createCats() {
    dom.cats.replaceChildren(...cats.map((cat) => h("button", {
      class: "cat", type: "button", "data-cat": cat.id, "aria-pressed": "false",
      onclick: () => setCategory(cat.id),   // (setCategory also leaves "My map")
    }, cat.label, h("span", { class: "n", text: "" }))));
  }

  function updateCats() {
    for (const button of dom.cats.querySelectorAll(".cat")) {
      const id = button.dataset.cat;
      button.setAttribute("aria-pressed", String(id === state.cat && !state.mine));
      button.querySelector(".n").textContent = data[id] ? data[id].features.length : "";
    }
  }

  function renderOverlayOptions() {
    const options = [h("option", { value: "", text: "None" })];
    for (const cat of cats) if (cat.id !== state.cat) options.push(h("option", { value: cat.id, text: cat.label }));
    dom.overlay.replaceChildren(...options);
    dom.overlay.value = state.overlay;
  }

  function renderCityName() {
    const ids = Object.keys(CFG.cities);
    if (ids.length < 2) { dom.citySlot.textContent = city.name; return; }
    const select = h("select", { "aria-label": "City" }, ids.map((id) => h("option", { value: id, text: CFG.cities[id].name })));
    select.value = state.city;
    select.addEventListener("change", () => { location.hash = "#" + select.value; location.reload(); });
    dom.citySlot.replaceChildren(select);
  }

  function renderCredits() {
    dom.credits.replaceChildren(...CFG.credits.map((line) => h("p", { text: line })));
  }

  /** The address bar records city / category / area, so a link opens the same view. */
  function writeHash() {
    const parts = [state.city, state.cat];
    if (state.selectedId) parts.push(state.selectedId);
    try { history.replaceState(null, "", "#" + parts.join("/")); } catch (e) { /* not available, skip */ }
  }

  function readHash() {
    const [cityId, catId, id] = decodeURIComponent(location.hash.slice(1)).split("/");
    return { cityId, catId, id };
  }

  function applyHash() {
    const { catId, id } = readHash();
    if (!catById[catId]) return;
    setCategory(catId);
    if (id && data[catId].byId.has(id)) select(catId, id, { fit: true });
    else clearSelection();
  }

  function showBanner(message) {
    dom.banner.textContent = message;
    dom.banner.hidden = false;
  }

  function setSettingsOpen(open) {
    dom.settingsPane.hidden = !open;
    dom.settingsBtn.setAttribute("aria-expanded", String(open));
  }

  function bindControls() {
    dom.search.addEventListener("input", () => { state.query = dom.search.value; renderList(); });

    dom.overlay.addEventListener("change", () => { state.overlay = dom.overlay.value; applyOverlay(); });

    dom.placeNames.addEventListener("change", () => {
      if (dom.placeNames.checked) nameTiles.addTo(map); else map.removeLayer(nameTiles);
    });

    dom.mineBtn.addEventListener("click", () => setMine(!state.mine));

    dom.focusMode.addEventListener("change", () => { state.focus = dom.focusMode.checked; if (selectedLayer) selectedLayer.setStyle(selectedStyle()); applyFocus(); });

    dom.settingsBtn.addEventListener("click", () => setSettingsOpen(dom.settingsPane.hidden));
    document.addEventListener("click", (event) => {   // click elsewhere closes the pane
      if (!dom.settingsPane.hidden && !event.target.closest(".settings")) setSettingsOpen(false);
    });

    dom.panelToggle.addEventListener("click", () => {
      const hide = !dom.app.classList.contains("panel-hidden");
      dom.app.classList.toggle("panel-hidden", hide);
      dom.panel.hidden = hide;
      dom.panelToggle.textContent = hide ? "Show panel" : "Hide panel";
      dom.panelToggle.setAttribute("aria-expanded", String(!hide));
      map.invalidateSize();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !dom.settingsPane.hidden) { setSettingsOpen(false); return; }
      if (event.key !== "Escape") return;
      if (document.activeElement === dom.search && dom.search.value) {
        dom.search.value = ""; state.query = ""; renderList();
      } else {
        clearSelection();
      }
    });

    window.addEventListener("hashchange", applyHash);
    darkQuery.addEventListener("change", applyTheme);
  }


  /* ---------- 8. Start ----------------------------------------------------- */

  async function start() {
    const requested = readHash().cityId;
    state.city = CFG.cities[requested] ? requested : CFG.defaultCity;
    city = CFG.cities[state.city];
    cats = city.categories;
    for (const cat of cats) catById[cat.id] = cat;

    dom.title.textContent = CFG.appTitle;
    document.title = `${CFG.appTitle}: ${city.name}`;
    readLook();
    renderCityName();
    renderCredits();
    createCats();
    initMap();
    bindControls();
    dom.list.replaceChildren(h("li", { class: "empty", text: "Loading boundaries…" }));

    try {
      await loadData();
    } catch (error) {
      dom.list.replaceChildren();
      showBanner("The boundary files did not load. If you opened this page by double-clicking it, " +
        "start a local server instead (run  python -m http.server  in this folder) and open http://localhost:8000/.");
      return;
    }

    loadMine();
    dom.mineCount.textContent = mineKeys.length;
    const { catId, id } = readHash();
    setCategory(catById[catId] ? catId : cats[0].id);
    if (id && data[state.cat].byId.has(id)) select(state.cat, id, { fit: true });
  }

  start();

})();
