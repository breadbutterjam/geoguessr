/* ==========================================================================
   game.js: behaviour. Settings come from config.js, maths from scoring.js,
   look from style.css. Sections:
     1. Setup and small helpers
     2. State
     3. Google Maps loading
     4. Menu
     5. Starting a game and a round
     6. Guessing and the timer
     7. Round result
     8. Final screen
     9. Boot
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- 1. Setup and small helpers ---------- */
  const CFG = window.GAME_CONFIG;
  const Lib = window.GaliLib;
  const $ = (id) => document.getElementById(id);
  const SCREENS = ['menu', 'game', 'result', 'final'];
  const KEY_PLACEHOLDER = 'PASTE_YOUR_BROWSER_KEY_HERE';
  const MAX_SPOT_RETRIES = 5;

  function showScreen(name) {
    for (const s of SCREENS) $('screen-' + s).hidden = s !== name;
    window.scrollTo(0, 0);
  }

  function showError(message) {
    const el = $('error-banner');
    el.textContent = message;
    el.hidden = false;
  }
  function clearError() { $('error-banner').hidden = true; }

  /* localStorage can throw (private windows, blocked storage), so always wrap it */
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
      catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
  };

  function monthYear(dateStr) {
    const m = /^(\d{4})-(\d{2})/.exec(dateStr || '');
    if (!m) return 'unknown date';
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                   'August', 'September', 'October', 'November', 'December'];
    return `${names[Number(m[2]) - 1] || ''} ${m[1]}`.trim();
  }

  function streetViewUrl(panoId) {
    return 'https://www.google.com/maps/@?api=1&map_action=pano&pano=' + encodeURIComponent(panoId);
  }

  /* ---------- 2. State ---------- */
  const state = {
    index: null,                 // contents of pools/index.json
    pools: {},                   // map id -> loaded pool, cached
    selection: Object.assign(
      { mapId: null, difficulty: CFG.defaults.difficulty, rounds: CFG.defaults.rounds,
        timerSeconds: CFG.defaults.timerSeconds, movement: CFG.defaults.movement },
      store.get('gali.settings', {})),
    game: null,                  // the game in progress
    round: null,                 // the round in progress
    gm: null,                    // Google Maps classes, once loaded
    panorama: null,
    guessMap: null, guessMarker: null,
    resultMap: null, resultOverlays: [],
    timerId: null,
  };

  /* ---------- 3. Google Maps loading ---------- */
  window.gm_authFailure = function () {
    showError('Google rejected the API key. Check that the Maps JavaScript API is enabled, ' +
      'billing is linked, and the key allows this address: ' + location.origin + '/*');
  };

  function loadGoogleMaps() {
    if (state.gm) return Promise.resolve(state.gm);
    return new Promise((resolve, reject) => {
      window.__galiMapsReady = async () => {
        try {
          const { Map, Polyline } = await google.maps.importLibrary('maps');
          const { StreetViewPanorama } = await google.maps.importLibrary('streetView');
          const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
          state.gm = { Map, Polyline, StreetViewPanorama, AdvancedMarkerElement };
          resolve(state.gm);
        } catch (err) { reject(err); }
      };
      const s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' +
        encodeURIComponent(CFG.googleMapsApiKey) + '&v=weekly&loading=async&callback=__galiMapsReady';
      s.async = true;
      s.onerror = () => reject(new Error('Could not reach Google Maps. Check your connection or any ad blocker.'));
      document.head.appendChild(s);
    });
  }

  /* ---------- 4. Menu ---------- */
  function currentEntry() {
    return state.index.maps.find((m) => m.id === state.selection.mapId);
  }

  function countFor(entry, difficulty) {
    return difficulty === 'any' ? entry.count : (entry.counts[difficulty] || 0);
  }

  /** Builds a row of radio-style buttons inside `container`. */
  function renderSegmented(container, options, selectedValue, onPick, isDisabled) {
    container.replaceChildren();
    for (const opt of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(opt.value === selectedValue));
      b.textContent = opt.label;
      b.disabled = Boolean(isDisabled && isDisabled(opt.value));
      b.addEventListener('click', () => onPick(opt.value));
      container.appendChild(b);
    }
  }

  function renderMapList() {
    const list = $('map-list');
    list.replaceChildren();
    for (const entry of state.index.maps) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'map-item' + (entry.id === state.selection.mapId ? ' is-selected' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(entry.id === state.selection.mapId));
      const name = document.createElement('span');
      name.className = 'map-item-name';
      name.textContent = entry.name;
      const meta = document.createElement('span');
      meta.className = 'map-item-meta';
      meta.textContent = entry.count.toLocaleString('en-IN') + ' spots';
      b.append(name, meta);
      b.addEventListener('click', () => { state.selection.mapId = entry.id; renderMenu(); });
      list.appendChild(b);
    }
  }

  function renderMenu() {
    const sel = state.selection;
    const entry = currentEntry();
    renderMapList();

    // Difficulty: disable choices with fewer spots than rounds, and fall back if needed.
    const diffOptions = CFG.difficulties.map((d) => ({ value: d.id, label: d.label }));
    const tooFew = (id) => countFor(entry, id) < sel.rounds;
    if (tooFew(sel.difficulty)) sel.difficulty = 'any';
    renderSegmented($('opt-difficulty'), diffOptions, sel.difficulty,
      (v) => { sel.difficulty = v; renderMenu(); }, tooFew);
    $('difficulty-note').textContent =
      `${countFor(entry, sel.difficulty).toLocaleString('en-IN')} spots at this difficulty.`;

    renderSegmented($('opt-rounds'),
      CFG.roundsOptions.map((n) => ({ value: n, label: String(n) })), sel.rounds,
      (v) => { sel.rounds = v; renderMenu(); },
      (n) => entry.count < n);

    renderSegmented($('opt-timer'),
      CFG.timerOptions.map((s) => ({ value: s, label: s === 0 ? 'No limit' : s / 60 + ' min' })),
      sel.timerSeconds, (v) => { sel.timerSeconds = v; renderMenu(); });

    renderSegmented($('opt-movement'),
      CFG.movementModes.map((m) => ({ value: m.id, label: m.label })), sel.movement,
      (v) => { sel.movement = v; renderMenu(); });
    const mode = CFG.movementModes.find((m) => m.id === sel.movement);
    $('movement-note').textContent = mode ? mode.hint : '';

    store.set('gali.settings', sel);
    $('start-btn').disabled = !keyIsSet();
  }

  function keyIsSet() {
    return CFG.googleMapsApiKey && CFG.googleMapsApiKey !== KEY_PLACEHOLDER;
  }

  /* ---------- 5. Starting a game and a round ---------- */
  async function loadPool(entry) {
    if (state.pools[entry.id]) return state.pools[entry.id];
    const url = CFG.poolsIndex.replace(/[^/]*$/, '') + entry.file;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load ${url} (${res.status}).`);
    state.pools[entry.id] = await res.json();
    return state.pools[entry.id];
  }

  async function startGame() {
    clearError();
    const sel = state.selection;
    const entry = currentEntry();
    $('start-btn').disabled = true;
    try {
      const [pool] = await Promise.all([loadPool(entry), loadGoogleMaps()]);
      // Shuffle once: the first N are the rounds, the rest are spares for removed spots.
      const shuffled = Lib.shuffle(Lib.eligible(pool, sel.difficulty));
      state.game = {
        pool, entry,
        settings: Object.assign({}, sel),
        scaleM: pool.score_scale_m * CFG.scoring.scaleMultiplier,
        locations: shuffled.slice(0, sel.rounds),
        spares: shuffled.slice(sel.rounds),
        roundIndex: 0, rounds: [], total: 0, retries: 0,
      };
      startRound();
    } catch (err) {
      showError(err.message || String(err));
    } finally {
      $('start-btn').disabled = !keyIsSet();
    }
  }

  function panoOptionsFor(mode) {
    const free = mode === 'move';
    const frozen = mode === 'nmpz';
    return {
      addressControl: false, fullscreenControl: false, enableCloseButton: false,
      motionTracking: false, motionTrackingControl: false,
      showRoadLabels: CFG.showRoadLabels,
      linksControl: free, clickToGo: free,
      zoomControl: !frozen, panControl: !frozen, scrollwheel: !frozen,
    };
  }

  function ensureGameMaps() {
    const { Map, StreetViewPanorama } = state.gm;
    if (!state.guessMap) {
      state.guessMap = new Map($('guess-map'), {
        mapId: CFG.mapId, disableDefaultUI: true, zoomControl: true,
        gestureHandling: 'greedy', clickableIcons: false,
      });
      state.guessMap.addListener('click', (e) => placeGuess(e.latLng.lat(), e.latLng.lng()));
      // The panel grows on hover; tell the map so tiles fill the new size.
      new ResizeObserver(() => google.maps.event.trigger(state.guessMap, 'resize'))
        .observe($('guess-map'));
    }
    if (!state.panorama) {
      state.panorama = new StreetViewPanorama($('pano'), { visible: true });
      state.panorama.addListener('pano_changed', keepToStartSpot);
      state.panorama.addListener('status_changed', onPanoStatus);
    }
  }

  /** In the no-moving modes, snap back if anything (a key press, a link) moves the view. */
  function keepToStartSpot() {
    const r = state.round;
    if (!r || !r.active || state.game.settings.movement === 'move') return;
    if (state.panorama.getPano() !== r.loc.pano_id) state.panorama.setPano(r.loc.pano_id);
  }

  /** If a panorama has been removed since the pool was made, swap in a spare. */
  function onPanoStatus() {
    const r = state.round;
    if (!r || !r.active) return;
    const status = state.panorama.getStatus();
    if (status === google.maps.StreetViewStatus.OK || status === undefined) return;
    const g = state.game;
    if (g.spares.length === 0 || g.retries >= MAX_SPOT_RETRIES) {
      showError('This spot is no longer available in Street View. Regenerate the pool to refresh it.');
      return;
    }
    g.retries += 1;
    g.locations[g.roundIndex] = g.spares.shift();
    startRound();
  }

  function startRound() {
    const g = state.game;
    const loc = g.locations[g.roundIndex];
    const settings = g.settings;
    showScreen('game');
    ensureGameMaps();

    state.round = { loc, guess: null, active: true };
    const heading = CFG.randomStartHeading ? Math.random() * 360 : 0;
    state.panorama.setOptions(panoOptionsFor(settings.movement));
    state.panorama.setPano(loc.pano_id);
    state.panorama.setPov({ heading, pitch: 0 });
    state.panorama.setVisible(true);

    $('pano-shield').hidden = settings.movement !== 'nmpz';
    $('back-to-start').hidden = settings.movement !== 'move';
    $('hud-map').textContent = g.entry.name;
    $('hud-round').textContent = `Round ${g.roundIndex + 1} of ${g.locations.length}`;
    $('hud-score').textContent = Lib.formatPoints(g.total) + ' points';

    resetGuessMap();
    setGuessPanelOpen(false);
    $('guess-btn').disabled = true;
    $('guess-btn').textContent = 'Place your pin';
    startTimer(settings.timerSeconds);
  }

  function resetGuessMap() {
    if (state.guessMarker) { state.guessMarker.map = null; state.guessMarker = null; }
    const [south, west, north, east] = state.game.pool.bbox;
    state.guessMap.fitBounds({ south, west, north, east }, CFG.guessMap.startZoomPadding);
  }

  function setGuessPanelOpen(open) {
    $('guess-panel').classList.toggle('is-open', open);
    $('guess-toggle').setAttribute('aria-expanded', String(open));
    $('guess-toggle').textContent = open ? 'Shrink map' : 'Enlarge map';
  }

  /* ---------- 6. Guessing and the timer ---------- */
  function pinElement(kind) {
    const el = document.createElement('div');
    el.className = 'pin pin-' + kind;
    return el;
  }

  function placeGuess(lat, lng) {
    if (!state.round || !state.round.active) return;
    state.round.guess = { lat, lng };
    if (state.guessMarker) {
      state.guessMarker.position = { lat, lng };
    } else {
      state.guessMarker = new state.gm.AdvancedMarkerElement({
        map: state.guessMap, position: { lat, lng }, content: pinElement('guess'),
      });
    }
    $('guess-btn').disabled = false;
    $('guess-btn').textContent = 'Guess';
  }

  function startTimer(seconds) {
    clearInterval(state.timerId);
    const chip = $('hud-timer');
    chip.hidden = seconds <= 0;
    if (seconds <= 0) return;
    const deadline = Date.now() + seconds * 1000;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      chip.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      chip.classList.toggle('is-low', left <= 10);
      if (left === 0) submitGuess(true);
    };
    tick();
    state.timerId = setInterval(tick, 250);
  }

  function submitGuess(timedOut) {
    const r = state.round;
    if (!r || !r.active) return;
    if (!r.guess && !timedOut) return;
    r.active = false;
    clearInterval(state.timerId);

    const g = state.game;
    const truth = { lat: r.loc.lat, lng: r.loc.lng };
    const distanceM = r.guess ? Lib.haversineM(r.guess, truth) : null;
    const points = Lib.scoreFor(distanceM, g.scaleM, CFG.scoring);
    g.rounds.push({ loc: r.loc, guess: r.guess, distanceM, points });
    g.total += points;
    showResult(g.rounds[g.rounds.length - 1], truth);
  }

  /* ---------- 7. Round result ---------- */
  function animateNumber(el, to) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || to === 0) { el.textContent = '+' + Lib.formatPoints(to); return; }
    const start = performance.now();
    const duration = 700;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      el.textContent = '+' + Lib.formatPoints(to * (1 - (1 - t) ** 3));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function clearResultOverlays() {
    for (const o of state.resultOverlays) {
      if (typeof o.setMap === 'function') o.setMap(null); else o.map = null;
    }
    state.resultOverlays = [];
  }

  function showResult(round, truth) {
    const g = state.game;
    const last = g.rounds.length >= g.locations.length;
    showScreen('result');

    // text
    const hasGuess = round.distanceM !== null;
    if (hasGuess) {
      const d = Lib.formatDistance(round.distanceM);
      $('result-lead').textContent = 'Your pin landed';
      $('result-distance-value').textContent = d.value;
      $('result-distance-unit').textContent = d.unit;
      $('result-sub').textContent = 'away. Imagery from ' + monthYear(round.loc.date) + '.';
    } else {
      $('result-lead').textContent = 'Time ran out';
      $('result-distance-value').textContent = '0';
      $('result-distance-unit').textContent = '';
      $('result-sub').textContent = 'No pin was placed. The diamond shows where you were.';
    }
    $('result-points-of').textContent = 'of ' + Lib.formatPoints(CFG.scoring.maxPoints);
    $('next-btn').textContent = last ? 'See final score' : 'Next round';
    animateNumber($('result-points'), round.points);
    const meter = $('result-meter');
    meter.style.setProperty('--pct', '0%');
    requestAnimationFrame(() => requestAnimationFrame(() =>
      meter.style.setProperty('--pct', (round.points / CFG.scoring.maxPoints * 100) + '%')));

    // map
    const { Map, Polyline, AdvancedMarkerElement } = state.gm;
    if (!state.resultMap) {
      state.resultMap = new Map($('result-map'), {
        mapId: CFG.mapId, disableDefaultUI: true, zoomControl: true,
        gestureHandling: 'greedy', clickableIcons: false,
      });
    }
    clearResultOverlays();
    const bounds = new google.maps.LatLngBounds();
    const trueMarker = new AdvancedMarkerElement({
      map: state.resultMap, position: truth, content: pinElement('true'), title: 'Where you were',
    });
    bounds.extend(truth);
    state.resultOverlays.push(trueMarker);
    if (round.guess) {
      state.resultOverlays.push(new AdvancedMarkerElement({
        map: state.resultMap, position: round.guess, content: pinElement('guess'), title: 'Your guess',
      }));
      state.resultOverlays.push(new Polyline({
        map: state.resultMap, path: [round.guess, truth], strokeOpacity: 0,
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: '#b8306a', scale: 3 },
                  offset: '0', repeat: '14px' }],
      }));
      bounds.extend(round.guess);
    }
    state.resultMap.fitBounds(bounds, { top: 80, right: 80, bottom: 80, left: 80 });
    google.maps.event.addListenerOnce(state.resultMap, 'idle', () => {
      if (state.resultMap.getZoom() > CFG.guessMap.maxResultZoom) {
        state.resultMap.setZoom(CFG.guessMap.maxResultZoom);
      }
    });
    $('next-btn').focus();
  }

  function nextRound() {
    const g = state.game;
    if (g.rounds.length >= g.locations.length) { showFinal(); return; }
    g.roundIndex += 1;
    startRound();
  }

  /* ---------- 8. Final screen ---------- */
  function showFinal() {
    const g = state.game;
    const s = g.settings;
    const maxTotal = CFG.scoring.maxPoints * g.locations.length;
    showScreen('final');

    $('final-map').textContent = g.entry.name;
    $('final-total').textContent = Lib.formatPoints(g.total);
    $('final-max').textContent = 'of ' + Lib.formatPoints(maxTotal);

    const bestKey = `gali.best.${s.mapId}.${s.difficulty}.${g.locations.length}`;
    const previous = store.get(bestKey, 0);
    if (g.total > previous) {
      store.set(bestKey, g.total);
      $('final-best').textContent = previous ? 'New best for this setup.' : '';
    } else {
      $('final-best').textContent = 'Best for this setup: ' + Lib.formatPoints(previous);
    }

    const list = $('final-rounds');
    list.replaceChildren();
    g.rounds.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = 'final-round';
      const n = document.createElement('span'); n.className = 'final-round-n'; n.textContent = String(i + 1);
      const dist = document.createElement('span'); dist.className = 'final-round-dist';
      if (r.distanceM === null) dist.textContent = 'No guess';
      else { const d = Lib.formatDistance(r.distanceM); dist.textContent = d.value + ' ' + d.unit + ' away'; }
      const pts = document.createElement('span'); pts.className = 'final-round-pts';
      pts.textContent = Lib.formatPoints(r.points);
      const bar = document.createElement('span'); bar.className = 'final-round-bar';
      const fill = document.createElement('span');
      fill.style.setProperty('--pct', (r.points / CFG.scoring.maxPoints * 100) + '%');
      bar.appendChild(fill);
      const link = document.createElement('a');
      link.className = 'final-round-link'; link.textContent = 'Open this spot in Google Maps';
      link.href = streetViewUrl(r.loc.pano_id); link.target = '_blank'; link.rel = 'noopener';
      li.append(n, dist, pts, bar, link);
      list.appendChild(li);
    });
    $('again-btn').focus();
  }

  /* ---------- 9. Boot ---------- */
  function wireEvents() {
    $('options-form').addEventListener('submit', (e) => { e.preventDefault(); startGame(); });
    $('guess-btn').addEventListener('click', () => submitGuess(false));
    $('guess-toggle').addEventListener('click', () =>
      setGuessPanelOpen(!$('guess-panel').classList.contains('is-open')));
    $('back-to-start').addEventListener('click', () => {
      if (state.round) state.panorama.setPano(state.round.loc.pano_id);
    });
    $('next-btn').addEventListener('click', nextRound);
    $('again-btn').addEventListener('click', startGame);
    $('menu-btn').addEventListener('click', () => { showScreen('menu'); renderMenu(); });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (['BUTTON', 'A', 'INPUT', 'SELECT'].includes(tag)) return;
      if (!$('screen-game').hidden) submitGuess(false);
      else if (!$('screen-result').hidden) nextRound();
    });
  }

  async function boot() {
    document.title = CFG.appTitle;
    $('app-title').textContent = CFG.appTitle;
    $('app-tagline').textContent = CFG.tagline;
    wireEvents();
    showScreen('menu');

    if (!keyIsSet()) {
      showError('Add your browser API key to site/config.js (googleMapsApiKey), then reload.');
    }
    try {
      const res = await fetch(CFG.poolsIndex);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.index = await res.json();
    } catch (err) {
      showError('Could not load ' + CFG.poolsIndex + '. Open the game through a local server ' +
        '(run  python -m http.server 8000  inside the site folder, then visit ' +
        'http://localhost:8000), not by double-clicking index.html. And run ' +
        'python generate_pool.py --rebuild-index if the file does not exist yet.');
      return;
    }
    if (!state.index.maps.length) {
      showError('No maps yet. Generate one with  python generate_pool.py --map mumbai');
      return;
    }
    if (!currentEntry()) state.selection.mapId = state.index.maps[0].id;
    renderMenu();
  }

  boot();
})();
