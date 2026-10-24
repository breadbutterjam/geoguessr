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

  const api = { haversineM, scoreFor, formatDistance, formatPoints, shuffle,
                eligible, countsByDifficulty, pickLocations };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GaliLib = api;
})(typeof window !== 'undefined' ? window : globalThis);
