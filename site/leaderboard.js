/* ==========================================================================
   leaderboard.js: the shared leaderboard and the player profile (Firebase).
   Exposed as window.GaliBoard. Everything here is optional: while
   GAME_CONFIG.firebase.apiKey is empty, `enabled` is false and the game never touches Firebase.

   Data (see firebase/firestore.rules):
     allTime/{mapId}_{uid}              the player's best game ever on a map
     daily/{dayKey}_{mapId}_{uid}       the player's best game on one local day on a map
   One document per player per board, so nobody fills a top 10 with repeats.
   Players sign in anonymously (no login screen); the nickname and avatar are theirs to pick.
   ========================================================================== */
(function () {
  'use strict';

  const CFG = window.GAME_CONFIG;
  const PROFILE_KEY = 'gali.profile';

  const enabled = Boolean(CFG.firebase && CFG.firebase.apiKey);

  /* ---------- Player profile (kept in the browser, copied onto each score) ---------- */
  function cleanName(raw) {
    const max = CFG.leaderboard.nameMaxLength;
    return String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function readProfile() {
    try {
      const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
      if (p && cleanName(p.name) && CFG.avatars.some((a) => a.id === p.avatar)) return { name: cleanName(p.name), avatar: p.avatar };
    } catch (e) { /* ignore */ }
    return null;
  }

  /** The saved profile, or a friendly random one (saved straight away so it stays the same). */
  function getProfile() {
    const saved = readProfile();
    if (saved) return saved;
    const avatar = CFG.avatars[Math.floor(Math.random() * CFG.avatars.length)];
    const profile = { name: 'Guest ' + String(Math.floor(1000 + Math.random() * 9000)), avatar: avatar.id };
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (e) { /* ignore */ }
    return profile;
  }

  function saveProfile(name, avatarId) {
    const clean = cleanName(name);
    if (!clean) return { ok: false, error: 'Please enter a name.' };
    if (!CFG.avatars.some((a) => a.id === avatarId)) return { ok: false, error: 'Please pick an avatar.' };
    const profile = { name: clean, avatar: avatarId };
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (e) { /* ignore */ }
    return { ok: true, profile };
  }

  /* ---------- Firebase, loaded only when first needed ---------- */
  let sdkPromise = null;

  function sdk() {
    if (!enabled) return Promise.reject(new Error('Leaderboard is not set up.'));
    if (!sdkPromise) {
      const base = `https://www.gstatic.com/firebasejs/${CFG.leaderboard.sdkVersion}/`;
      sdkPromise = Promise.all([
        import(base + 'firebase-app.js'),
        import(base + 'firebase-auth.js'),
        import(base + 'firebase-firestore.js'),
      ]).then(async ([appMod, authMod, fs]) => {
        const app = appMod.initializeApp(CFG.firebase);
        const auth = authMod.getAuth(app);
        const db = fs.getFirestore(app);
        // Wait for any saved sign-in to be restored, otherwise sign in anonymously.
        const user = await new Promise((resolve, reject) => {
          const off = authMod.onAuthStateChanged(auth, (u) => { off(); resolve(u); }, reject);
        });
        const uid = user ? user.uid : (await authMod.signInAnonymously(auth)).user.uid;
        return { fs, db, uid };
      }).catch((err) => { sdkPromise = null; throw err; });
    }
    return sdkPromise;
  }

  /* ---------- Submitting a score ---------- */
  /**
   * record: { mapId, dayKey, score10, total, maxTotal, rounds, difficulty, timer, movement }
   * Saves it as the player's best for the day and for all time, only where it beats the old one.
   * Returns { allTime: 'new' | 'kept', daily: 'new' | 'kept' }.
   */
  async function submit(record) {
    const { fs, db, uid } = await sdk();
    const profile = getProfile();
    const result = {};

    const targets = [
      ['allTime', `${record.mapId}_${uid}`],
      ['daily', `${record.dayKey}_${record.mapId}_${uid}`],
    ];
    for (const [collection, id] of targets) {
      const ref = fs.doc(db, collection, id);
      const snap = await fs.getDoc(ref);
      const previous = snap.exists() ? snap.data() : null;
      const beats = !previous || record.score10 > previous.score10;
      // When the old score stands, resend it unchanged: only name, avatar and time are refreshed.
      const base = beats ? record : previous;
      await fs.setDoc(ref, {
        uid,
        mapId: record.mapId,
        name: profile.name,
        avatar: profile.avatar,
        score10: base.score10,
        total: base.total,
        maxTotal: base.maxTotal,
        rounds: base.rounds,
        difficulty: base.difficulty,
        timer: base.timer,
        movement: base.movement,
        dayKey: base.dayKey,
        v: CFG.scoring.version,
        ts: fs.serverTimestamp(),
      });
      result[collection] = beats ? 'new' : 'kept';
    }
    return { allTime: result.allTime, daily: result.daily, uid };
  }

  /* ---------- Reading a board ---------- */
  /** kind: 'daily' (needs dayKey) or 'allTime'. Returns [{ rank, name, avatar, score10, ..., mine }]. */
  async function top(kind, mapId, dayKey) {
    const { fs, db, uid } = await sdk();
    const constraints = [fs.where('mapId', '==', mapId), fs.where('v', '==', CFG.scoring.version)];
    if (kind === 'daily') constraints.push(fs.where('dayKey', '==', dayKey));
    constraints.push(fs.orderBy('score10', 'desc'), fs.limit(CFG.leaderboard.topN));
    const snap = await fs.getDocs(fs.query(fs.collection(db, kind), ...constraints));
    return snap.docs.map((d, i) => Object.assign({ rank: i + 1, mine: d.data().uid === uid }, d.data()));
  }

  window.GaliBoard = { enabled, getProfile, saveProfile, cleanName, submit, top };
})();
