/* ==========================================================================
   Area Viewer: configuration
   Everything you are likely to change lives here. No logic.

   To add a city:     copy the "mumbai" block, point dataPath at a folder of GeoJSON files.
   To add a category: add an entry to a city's `categories`; the tabs, list and map pick it up.
   Colours and fonts are in style.css (design tokens at the top).
   ========================================================================== */

window.AREA_VIEWER_CONFIG = {

  appTitle: "Area Viewer",
  defaultCity: "mumbai",

  /* --- Basemap ------------------------------------------------------------
     Free CARTO tiles built from OpenStreetMap. Swap the URLs to change provider.
     "labels" are place-name tiles drawn above the areas when "Place names" is ticked. */
  basemap: {
    /* CARTO tiles need a free key (no account): https://www.carto.com/basemaps/apikey/
       Paste it between the quotes. Keys are meant to sit in page code; the free limit is
       5 million tile requests a month for non-commercial use.
       Left empty, the map falls back to plain OpenStreetMap tiles (no key, no dark mode). */
    apiKey: "",
    fallback: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    light: {
      tiles:  "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
      labels: "https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png",
    },
    dark: {
      tiles:  "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png",
      labels: "https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png",
    },
    subdomains: "abcd",
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
      '&copy; <a href="https://carto.com/attributions">CARTO</a>',
  },

  /* Number of colours in the area palette (--c0 ... --cN in style.css). */
  paletteSize: 8,

  /* Shown at the bottom of the side panel. */
  credits: [
    "Boundaries from DataMeet community maps, shared under Creative Commons (CC BY, CC BY-SA, CC0). PIN code areas are India Post's, via DataMeet.",
  ],

  /* --- Cities ------------------------------------------------------------- */
  cities: {

    mumbai: {
      name: "Mumbai",
      center: [19.08, 72.88],
      zoom: 11,
      maxBounds: [[18.70, 72.60], [19.45, 73.15]],
      dataPath: "data/mumbai/",

      /* Category fields
         id           matches the file name and the URL hash
         label        tab text and list heading
         singular     used in "Parliament seat · 12 km²"
         plural       used in "Contains 6 prabhags"
         file         GeoJSON file inside dataPath
         labelMinZoom names appear on the map from this zoom level
         metaDetail   which detail to show beside each name in the list (and search)
         about        one plain sentence on what the layer is
         vintage      when the boundaries are from, and from where
         caution      optional: a limitation worth knowing before relying on it */
      categories: [
        {
          id: "parliament", label: "Parliament seats", singular: "Parliament seat", plural: "parliament seats",
          file: "parliament.geojson", labelMinZoom: 10, metaDetail: null,
          about: "The six Lok Sabha seats that cover Mumbai. Each is made of whole assembly seats.",
          vintage: "Built from the 2008 delimitation by merging the assembly seats of each parliament seat.",
        },
        {
          id: "assembly", label: "Assembly seats", singular: "Assembly seat", plural: "assembly seats",
          file: "assembly.geojson", labelMinZoom: 12, metaDetail: "Parliament seat",
          about: "The 36 Vidhan Sabha seats in Mumbai City and Mumbai Suburban. The Election Commission spells Bandra as Vandre.",
          vintage: "2008 delimitation, from Election Commission data via DataMeet.",
          caution: "DataMeet notes some positional shift in this data, so edges may sit slightly off the streets.",
        },
        {
          id: "wards", label: "BMC wards", singular: "BMC ward", plural: "BMC wards",
          file: "wards.geojson", labelMinZoom: 11, metaDetail: null,
          about: "The 24 administrative wards of the Brihanmumbai Municipal Corporation, named by letter, such as H/West.",
          vintage: "From DataMeet's BMC ward map.",
        },
        {
          id: "prabhags", label: "Prabhags", singular: "Prabhag", plural: "prabhags",
          file: "prabhags.geojson", labelMinZoom: 13, metaDetail: "BMC ward",
          about: "The 227 numbered electoral wards. Each elects one corporator to the BMC. Population is from the 2011 Census.",
          vintage: "Boundaries from the 2017 BMC election, via DataMeet.",
          caution: "BMC redrew about a quarter of these before the January 2026 election. The new boundaries were published as a notification and printed maps, so this layer is not updated.",
        },
        {
          id: "localities", label: "Localities", singular: "Locality", plural: "localities",
          file: "localities.geojson", labelMinZoom: 13, metaDetail: "PIN code",
          about: "Areas named after their India Post PIN code, such as Santacruz East (400055).",
          vintage: "India Post PIN code areas from 2014, via DataMeet.",
          caution: "These are post office delivery areas, not official localities. Some are named for an institution (BARC, FCI), and some PIN codes have no area in the source data.",
        },
      ],
    },

  },
};
