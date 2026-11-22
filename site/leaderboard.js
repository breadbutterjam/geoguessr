/* ==========================================================================
   leaderboard.js: the shared leaderboard, the player profile and sign-in (Firebase).
   Exposed as window.GaliBoard. Everything here is optional: while
   GAME_CONFIG.firebase.apiKey is empty, `enabled` is false and the game never touches Firebase.

   Data (see firebase/firestore.rules):
     allTime/{mapId}_{uid}              the player's best game ever on a map
     daily/{dayKey}_{mapId}_{uid}       the player's best game on one local day on a map
     users/{uid}                        { optOut }: the player's choice to stay off the boards
   One document per player per board, so nobody fills a top 10 with repeats.

   Everyone starts as a guest (anonymous sign-in, no login screen). A guest can later sign in
   with Google; that keeps the same account, so earlier scores stay. The nickname and avatar
   are chosen by the player. The Google email and photo are never stored by the game.
   ========================================================================== */
(function () {
  'use strict';

  const CFG = window.GAME_CONFIG;
  const PROFILE_KEY = 'gali.profile';
  const ACCOUNT_KEY = 'gali.account';       // 'google' | 'guest': remembered so the menu can show it at once

  const enabled = Boolean(CFG.firebase && CFG.firebase.apiKey);

  /* ---------- Change notifications (the menu redraws the player chip) ---------- */
  const listeners = [];
  const onChange = (fn) => listeners.push(fn);
  const emit = () => listeners.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });

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

  function randomProfile() {
    const avatar = CFG.avatars[Math.floor(Math.random() * CFG.avatars.length)];
    return { name: 'Guest ' + String(Math.floor(1000 + Math.random() * 9000)), avatar: avatar.id };
  }

  function writeProfile(profile) {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (e) { /* ignore */ }
  }

  /** The saved profile, or a friendly random one (saved straight away so it stays the same). */
  function getProfile() {
    const saved = readProfile();
    if (saved) return saved;
    const profile = randomProfile();
    writeProfile(profile);
    return profile;
  }

  function saveProfile(name, avatarId) {
    const clean = cleanName(name);
    if (!clean) return { ok: false, error: 'Please enter a name.' };
    if (!CFG.avatars.some((a) => a.id === avatarId)) return { ok: false, error: 'Please pick an avatar.' };
    const profile = { name: clean, avatar: avatarId };
    writeProfile(profile);
    return { ok: true, profile };
  }

  const isAutoName = (name) => /^Guest \d{4}$/.test(name);

  /* ---------- Account state (remembered locally; confirmed once Firebase has loaded) ---------- */
  function accountMode() {
    try { return localStorage.getItem(ACCOUNT_KEY) === 'google' ? 'google' : 'guest'; } catch (e) { return 'guest'; }
  }

  function setAccountMode(mode) {
    const before = accountMode();
    try { localStorage.setItem(ACCOUNT_KEY, mode); } catch (e) { /* ignore */ }
    if (before !== mode) emit();
  }

  /** Google refuses sign-in inside the built-in browsers of chat and social apps. */
  function inAppBrowser() {
    return /FBAN|FBAV|Instagram|Line\/|WhatsApp|Snapchat|MicroMessenger|Twitter|; wv\)/i.test(navigator.userAgent || '');
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
        // Wait for any saved sign-in to be restored, otherwise start as a guest.
        let user = await new Promise((resolve, reject) => {
          const off = authMod.onAuthStateChanged(auth, (u) => { off(); resolve(u); }, reject);
        });
        if (!user) user = (await authMod.signInAnonymously(auth)).user;
        setAccountMode(user.isAnonymous ? 'guest' : 'google');
        return { fs, db, auth, authMod };
      }).catch((err) => { sdkPromise = null; throw err; });
    }
    return sdkPromise;
  }

  /** Starts loading Firebase in the background so the account state is known early. */
  function init() {
    if (enabled) sdk().catch((err) => console.warn('Leaderboard:', err));
  }

  const uidOf = (ctx) => ctx.auth.currentUser.uid;

  /* ---------- Staying off the boards ---------- */
  async function isOptedOut(ctx) {
    const snap = await ctx.fs.getDoc(ctx.fs.doc(ctx.db, 'users', uidOf(ctx)));
    return snap.exists() && snap.data().optOut === true;
  }

  async function getOptedOut() {
    return isOptedOut(await sdk());
  }

  /** The player's own board documents: [{ ref, collection, id, data }]. */
  async function ownDocs(ctx, uid) {
    const found = [];
    for (const collection of ['allTime', 'daily']) {
      const snap = await ctx.fs.getDocs(ctx.fs.query(ctx.fs.collection(ctx.db, collection), ctx.fs.where('uid', '==', uid)));
      snap.docs.forEach((d) => found.push({ ref: d.ref || ctx.fs.doc(ctx.db, collection, d.id), collection, id: d.id, data: d.data() }));
    }
    return found;
  }

  /**
   * optedOut = true: removes the player's entries from every board and stops new scores.
   * optedOut = false: scores are posted again from the next game (removed entries do not come back).
   */
  async function setOptedOut(optedOut) {
    const ctx = await sdk();
    const uid = uidOf(ctx);
    // Remember the choice first so a new score can never slip in while the old ones are removed.
    await ctx.fs.setDoc(ctx.fs.doc(ctx.db, 'users', uid), { optOut: optedOut, ts: ctx.fs.serverTimestamp() });
    if (optedOut) {
      for (const d of await ownDocs(ctx, uid)) await ctx.fs.deleteDoc(d.ref);
    }
  }

  /* ---------- Signing in with Google, signing out ---------- */
  function friendlyAuthError(err) {
    const code = (err && err.code) || '';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return null;   // they changed their mind
    if (code === 'auth/popup-blocked') return 'The sign-in window was blocked. Allow pop-ups for this site and try again.';
    if (code === 'auth/unauthorized-domain') return 'This web address is not authorised in Firebase yet (Authentication > Settings > Authorised domains).';
    if (code === 'auth/operation-not-allowed') return 'Google sign-in is not switched on in Firebase yet.';
    if (code === 'auth/network-request-failed') return 'Could not reach Google. Check your connection and try again.';
    return 'Could not sign in. Please try again.';
  }

  /** Prefills the nickname with their Google first name, but only if they have not chosen one themselves. */
  function prefillName(user) {
    const first = cleanName(String(user.displayName || '').split(' ')[0]);
    const current = readProfile();
    if (first && (!current || isAutoName(current.name))) {
      writeProfile({ name: first, avatar: current ? current.avatar : randomProfile().avatar });
    }
  }

  /** Moves a guest's scores to the Google account they just signed in to (keeping the better score per board). */
  async function mergeInto(ctx, oldUid, newUid, docs) {
    const profile = getProfile();
    for (const d of docs) {
      const newId = d.id.slice(0, d.id.length - oldUid.length) + newUid;
      const ref = ctx.fs.doc(ctx.db, d.collection, newId);
      const existing = await ctx.fs.getDoc(ref);
      if (existing.exists() && existing.data().score10 >= d.data.score10) continue;
      await ctx.fs.setDoc(ref, Object.assign({}, d.data, {
        uid: newUid, name: profile.name, avatar: profile.avatar, ts: ctx.fs.serverTimestamp(),
      }));
    }
  }

  /**
   * Upgrades the guest account to a Google account (same uid, so scores stay).
   * If that Google account already exists (played on another device), switches to it and
   * carries over any better scores. Returns { ok, error?, profile? }.
   */
  async function signInWithGoogle() {
    if (inAppBrowser()) {
      return { ok: false, error: 'Google does not allow sign-in inside this app’s browser. Open this page in Chrome or Safari to sign in.' };
    }
    let ctx;
    try { ctx = await sdk(); } catch (err) { return { ok: false, error: 'Could not reach the leaderboard service.' }; }
    const { auth, authMod } = ctx;
    const provider = new authMod.GoogleAuthProvider();
    let user;
    try {
      user = (await authMod.linkWithPopup(auth.currentUser, provider)).user;
    } catch (err) {
      if (err && err.code === 'auth/credential-already-in-use') {
        const credential = authMod.GoogleAuthProvider.credentialFromError(err);
        const oldUid = auth.currentUser.uid;
        try {
          // Take the guest's entries out first (only the guest account may delete them), then switch.
          const docs = await ownDocs(ctx, oldUid);
          for (const d of docs) await ctx.fs.deleteDoc(d.ref);
          try {
            user = (await authMod.signInWithCredential(auth, credential)).user;
          } catch (inner) {
            for (const d of docs) await ctx.fs.setDoc(d.ref, Object.assign({}, d.data, { ts: ctx.fs.serverTimestamp() }));
            throw inner;
          }
          prefillName(user);
          await mergeInto(ctx, oldUid, user.uid, docs);
        } catch (inner) {
          const msg = friendlyAuthError(inner);
          return msg === null ? { ok: false, error: '' } : { ok: false, error: msg };
        }
      } else {
        const msg = friendlyAuthError(err);
        return { ok: false, error: msg === null ? '' : msg };
      }
    }
    prefillName(user);
    setAccountMode('google');
    return { ok: true, profile: getProfile() };
  }

  /** Signs out and carries on as a new guest. The nickname and avatar are reset so the next
   *  person on a shared device does not inherit them. */
  async function signOutUser() {
    const { auth, authMod } = await sdk();
    await authMod.signOut(auth);
    await authMod.signInAnonymously(auth);
    try { localStorage.removeItem(PROFILE_KEY); } catch (e) { /* ignore */ }
    setAccountMode('guest');
    emit();
  }

  /* ---------- Submitting a score ---------- */
  /**
   * record: { mapId, dayKey, score10, total, maxTotal, rounds, difficulty, timer, movement }
   * Saves it as the player's best for the day and for all time, only where it beats the old one.
   * Returns { optedOut: true } if the player chose to stay off the boards, otherwise
   * { allTime: 'new' | 'kept', daily: 'new' | 'kept' }.
   */
  async function submit(record) {
    const ctx = await sdk();
    if (await isOptedOut(ctx)) return { optedOut: true };
    const { fs, db } = ctx;
    const uid = uidOf(ctx);
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
    return { allTime: result.allTime, daily: result.daily };
  }

  /* ---------- Reading a board ---------- */
  /** kind: 'daily' (needs dayKey) or 'allTime'. Returns [{ rank, name, avatar, score10, ..., mine }]. */
  async function top(kind, mapId, dayKey) {
    const ctx = await sdk();
    const { fs, db } = ctx;
    const uid = uidOf(ctx);
    const constraints = [fs.where('mapId', '==', mapId), fs.where('v', '==', CFG.scoring.version)];
    if (kind === 'daily') constraints.push(fs.where('dayKey', '==', dayKey));
    constraints.push(fs.orderBy('score10', 'desc'), fs.limit(CFG.leaderboard.topN));
    const snap = await fs.getDocs(fs.query(fs.collection(db, kind), ...constraints));
    return snap.docs.map((d, i) => Object.assign({ rank: i + 1, mine: d.data().uid === uid }, d.data()));
  }

  window.GaliBoard = {
    enabled, init, onChange, accountMode, inAppBrowser,
    getProfile, saveProfile, cleanName,
    signInWithGoogle, signOutUser, getOptedOut, setOptedOut,
    submit, top,
  };
})();
