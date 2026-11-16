/* ==========================================================================
   scoring.js: pure helpers (no DOM, no Google Maps), so they can be tested alone.
   Exposed as window.GaliLib in the browser and via module.exports in Node.
   ========================================================================== */
(function (root) {
  'use strict';

  const EARTH_RADIUS_M = 6371008.8;

  /** Great-circle distance in metres between two {lat, lng} points. */
  function haversineM(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
  }

  /**
   * Points for one guess: maxPoints * exp(-distance / scale).
   * scaleM comes from the map's pool (score_scale_m), times an optional multiplier.
   * A missing guess (null distance) scores 0.
   */
  function scoreFor(distanceM, scaleM, scoring) {
    if (distanceM == null || !isFinite(distanceM)) return 0;
    if (distanceM <= scoring.perfectRadiusM) return scoring.maxPoints;
    return Math.round(scoring.maxPoints * Math.exp(-distanceM / scaleM));
  }

  /** The distance scale for one spot: the map's scale, the global multiplier, and the spot's difficulty. */
  function scaleFor(poolScaleM, loc, scoring) {
    const byDifficulty = (scoring.difficultyScale && scoring.difficultyScale[loc.difficulty]) || 1;
    return poolScaleM * scoring.scaleMultiplier * byDifficulty;
  }

  /**
   * Time bonus for one round. remainingFraction is time left / time allowed (0..1),
   * accuracy is the distance score / maxPoints (0..1). Returns 0 in untimed games.
   * Uses the first tier (listed best to worst) whose threshold is met.
   */
  function timeBonusFor(remainingFraction, accuracy, timeBonus) {
    if (!timeBonus || remainingFraction == null || !(accuracy > 0)) return 0;
    const tier = timeBonus.tiers.find((t) => remainingFraction >= t.remaining);
    if (!tier) return 0;
    return Math.round(timeBonus.max * tier.share * Math.min(1, accuracy));
  }

  /** Most points one round can give in this game. */
  function roundMax(scoring, timeBonus, timed) {
    return scoring.maxPoints + (timed && timeBonus ? timeBonus.max : 0);
  }

  /** Total points as a score out of 10 (two decimals), so games of any length compare. */
  function scoreOutOfTen(total, maxTotal) {
    if (!(maxTotal > 0)) return 0;
    return Math.round(Math.min(1, total / maxTotal) * 1000) / 100;
  }

  /** Local calendar date as "2026-11-10", from the device clock. */
  function localDayKey(date) {
    const d = date || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /**
   * Picks a line for a guess. fraction = score / max (null = no guess). Never repeats `last`.
   * messages is window.GAME_MESSAGES; {distance} in a line is replaced by distanceText.
   */
  function pickMessage(fraction, messages, distanceText, last, rng) {
    const random = rng || Math.random;
    const lines = fraction == null
      ? messages.noGuess
      : (messages.bands.find((b) => fraction >= b.min) || messages.bands[messages.bands.length - 1]).lines;
    let pool = lines.filter((l) => l !== last);
    if (!pool.length) pool = lines;
    const line = pool[Math.floor(random() * pool.length)];
    return { raw: line, text: line.replace(/\{distance\}/g, distanceText || 'some distance') };
  }

  /** "340 m", "3.4 km", "12 km" as {value, unit}. */
  function formatDistance(m) {
    if (m < 1000) return { value: String(Math.max(10, Math.round(m / 10) * 10)), unit: 'm' };
    if (m < 10000) return { value: (m / 1000).toFixed(1), unit: 'km' };
    return { value: String(Math.round(m / 1000)), unit: 'km' };
  }

  function formatPoints(n) {
    return Math.round(n).toLocaleString('en-IN');
  }

  /** Fisher-Yates shuffle, returns a new array. rng is injectable for tests. */
  function shuffle(list, rng) {
    const random = rng || Math.random;
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Locations of a pool matching a difficulty ('any' keeps everything). */
  function eligible(pool, difficulty) {
    return difficulty === 'any'
      ? pool.locations
      : pool.locations.filter((l) => l.difficulty === difficulty);
  }

  /** How many locations each difficulty has, plus 'any'. */
  function countsByDifficulty(pool) {
    const counts = { any: pool.locations.length };
    for (const l of pool.locations) counts[l.difficulty] = (counts[l.difficulty] || 0) + 1;
    return counts;
  }

  /** n distinct random locations for a game, or fewer if the pool is too small. */
  function pickLocations(pool, difficulty, n, rng) {
    return shuffle(eligible(pool, difficulty), rng).slice(0, n);
  }

  const api = { haversineM, scoreFor, scaleFor, timeBonusFor, roundMax, scoreOutOfTen, localDayKey, pickMessage, formatDistance, formatPoints, shuffle,
                eligible, countsByDifficulty, pickLocations };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GaliLib = api;
})(typeof window !== 'undefined' ? window : globalThis);
