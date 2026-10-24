/* ==========================================================================
   config.js: every setting you are likely to want to change lives here.
   The game logic (game.js) and the look (style.css) contain no hard-coded values.
   ========================================================================== */
window.GAME_CONFIG = {

  /* ---- Identity ---- */
  appTitle: 'Gali Guesser',
  tagline: 'Dropped on a street somewhere in the city. Where are you?',

  /* ---- Google Maps ----
     Use a SEPARATE key from the one you used for the Python scripts:
       - Enable "Maps JavaScript API" for the project
       - Application restriction: HTTP referrers, e.g. http://localhost:8000/*  (add your
         GitHub Pages address later)
       - API restriction: Maps JavaScript API
     mapId: "DEMO_MAP_ID" works for development; create your own Map ID in the Cloud
     console (Map Management) when you publish. */
  googleMapsApiKey: 'AIzaSyAsyc0sL5i4-A_jRJnYcowckrE2YTt57A8',
  mapId: 'DEMO_MAP_ID',

  /* ---- Data ---- */
  poolsIndex: 'pools/index.json',      // written by generate_pool.py

  /* ---- Scoring ----
     points = maxPoints * exp(-distance / scale)
     scale comes from each map (score_scale_m in its pool file) times scaleMultiplier:
     below 1 is stricter, above 1 is more forgiving. */
  scoring: {
    maxPoints: 5000,
    perfectRadiusM: 15,                // closer than this counts as a perfect guess
    scaleMultiplier: 1,
  },

  /* ---- Choices shown in the menu ---- */
  roundsOptions: [3, 5, 10],
  timerOptions: [0, 60, 120, 180],     // seconds, 0 = no limit
  difficulties: [
    { id: 'any',    label: 'Any' },
    { id: 'easy',   label: 'Easy' },
    { id: 'medium', label: 'Medium' },
    { id: 'hard',   label: 'Hard' },
  ],
  movementModes: [
    { id: 'move',   label: 'Free to move',  hint: 'Walk along the street as far as you like.' },
    { id: 'nomove', label: 'Fixed spot',    hint: 'Look around and zoom, but no moving.' },
    { id: 'nmpz',   label: 'Frozen view',   hint: 'No moving, turning or zooming.' },
  ],
  defaults: { rounds: 5, timerSeconds: 0, movement: 'move', difficulty: 'any' },

  /* ---- Street View behaviour ---- */
  showRoadLabels: false,               // true shows street names drawn on the road
  randomStartHeading: true,            // false starts facing the way the car drove

  /* ---- Guess map ---- */
  guessMap: {
    startZoomPadding: 24,              // px of padding when fitting the map's area
    maxResultZoom: 18,                 // stops the result map zooming in too far
  },
};
