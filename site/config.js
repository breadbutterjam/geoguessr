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

    /* Harder spots forgive distance more. Each spot has a difficulty (from its road type);
       the map's scale is multiplied by the number below for that spot, so the same miss
       costs less on a hard spot. 1 = the map's own scale. Also applies in "Any" games. */
    difficultyScale: { easy: 1, medium: 1.25, hard: 1.5 },

    /* Bump this when you change how scoring works. It is saved with every record, and
       leaderboards and local bests only compare records with the same number. */
    version: 2,
  },

  /* ---- Time bonus ----
     Only in timed games. Bonus = max * share * accuracy, where accuracy is the guess's
     distance score as a fraction of maxPoints (so a wild guess earns almost nothing).
     "remaining" is the fraction of the round's time still left when the guess is made.
     The first tier (top to bottom) whose "remaining" is met is used; below the last tier
     there is no bonus. Add, remove or edit tiers freely. */
  timeBonus: {
    max: 1000,
    tiers: [
      { remaining: 0.95, share: 1.00 },
      { remaining: 0.90, share: 0.90 },
      { remaining: 0.75, share: 0.75 },
      { remaining: 0.50, share: 0.50 },
      { remaining: 0.20, share: 0.20 },
    ],
  },

  /* ---- Leaderboards (needs Firebase; see firebase/SETUP.md) ----
     While firebase.apiKey is empty the leaderboard stays off and the game works as before. */
  firebase: {
    apiKey: '',
    authDomain: '',
    projectId: '',
    appId: '',
  },
  leaderboard: {
    topN: 10,                          // rows shown per board
    nameMaxLength: 20,
    sdkVersion: '10.14.1',             // Firebase web SDK, loaded from Google's CDN
  },

  /* Player avatars. "emoji" is the fallback; put your own images in site/avatars/ and set
     "src" (e.g. 'avatars/fox.png') to use them. "id" is what gets saved: keep ids stable. */
  avatars: [
    { id: 'fox',      label: 'Fox',      emoji: '🦊', src: null },
    { id: 'tiger',    label: 'Tiger',    emoji: '🐯', src: null },
    { id: 'elephant', label: 'Elephant', emoji: '🐘', src: null },
    { id: 'monkey',   label: 'Monkey',   emoji: '🐵', src: null },
    { id: 'owl',      label: 'Owl',      emoji: '🦉', src: null },
    { id: 'bear',     label: 'Bear',     emoji: '🐻', src: null },
    { id: 'panda',    label: 'Panda',    emoji: '🐼', src: null },
    { id: 'frog',     label: 'Frog',     emoji: '🐸', src: null },
    { id: 'cat',      label: 'Cat',      emoji: '🐱', src: null },
    { id: 'dog',      label: 'Dog',      emoji: '🐶', src: null },
  ],

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
