/* Sidekick — app.js  (all screens + logic + PWA boot)
 * Local-first freelance-admin PWA. Vanilla JS + IndexedDB + Service Worker.
 * NO backend, NO secrets, NO external CDNs. English-only MVP; i18n engine is
 * built so Thai (or any locale) can be added later by extending I18N.
 *
 * VERSION LOCKSTEP: APP_VERSION tracks sw.js SW_VERSION and the ?v= query on
 * the precached app.js / styles.css. Bump all three together on every deploy.
 *
 * Formerly "Freelanz Gym" (a personal-gym-trainer-focused fork of the general
 * "Freelanz" app). Rebranded to Sidekick and promoted to be the flagship app —
 * see RENAME/MIGRATION below for how existing local data carries over.
 */
const APP_VERSION = '0.9.22';          // <-> sw.js SW_VERSION 'sidekick-v0.9.22'

// ─── DB ───────────────────────────────────────────────────────────────
// Per-uid keyed stores (guest uid = 'guest'). M1 actively uses users / jobs /
// expenses / settings; clients / invoices / documents / meta / outbox are
// created now (dormant) so M2/M3 features and a future sync layer can land
// without a schema migration.
let db;
// DB_VER bumped 1→2 in M1.5 ('services'), 2→3 in M3 ('bookings'/'followups'/
// 'portfolio' — the M2 invoices/documents stores were added under the old v2
// without a version bump, so onupgradeneeded never re-fired for existing v2
// databases; this bump fixes that too, since the guarded creates below run
// for ANY store still missing, not just the three new ones), 3→4 in M5
// ('research'), 4→5 ('memberTags' — retired; the store creation line was
// removed once Member Tags merged into the Client system, see saveJob()),
// 5→6 ('usageEvents' — local usage analytics), 6→7 ('packages' — session
// bundles, e.g. "buy 10, track remaining"; 'progressLogs' — per-client
// weight/notes entries over time). onupgradeneeded only CREATES
// missing stores (each guarded by !contains) — it never drops or clears
// existing stores, so guest jobs / clients / settings survive the upgrade.
const DB_NAME = 'sidekick-v1', DB_VER = 7;
// RENAME/MIGRATION: this app used to be "Freelanz Gym" (DB_NAME
// 'freelanz-gym-v1'), namespaced that way because it co-hosted with a
// separate "Freelanz" app on the same GitHub Pages origin. That sibling app
// has been retired and this one promoted to be the flagship — see
// migrateLegacyStorageIfNeeded() below, which one-time-copies any existing
// local data (IndexedDB stores + the logged-in session + UI prefs) from the
// old names into the new ones, so nobody's on-device data is silently
// orphaned by the rename.
const LEGACY_DB_NAME = 'freelanz-gym-v1';
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('users')) {
        const u = d.createObjectStore('users', {keyPath:'id', autoIncrement:true});
        u.createIndex('username', 'username', {unique:true});
      }
      if (!d.objectStoreNames.contains('jobs'))      d.createObjectStore('jobs',      {keyPath:'id', autoIncrement:true});
      if (!d.objectStoreNames.contains('expenses'))  d.createObjectStore('expenses',  {keyPath:'id', autoIncrement:true});
      if (!d.objectStoreNames.contains('clients'))   d.createObjectStore('clients',   {keyPath:'id', autoIncrement:true});
      if (!d.objectStoreNames.contains('services'))  d.createObjectStore('services',  {keyPath:'id', autoIncrement:true}); // M1.5 catalog
      if (!d.objectStoreNames.contains('invoices'))  d.createObjectStore('invoices',  {keyPath:'id', autoIncrement:true});
      if (!d.objectStoreNames.contains('documents')) d.createObjectStore('documents', {keyPath:'id', autoIncrement:true});
      if (!d.objectStoreNames.contains('bookings'))  d.createObjectStore('bookings',  {keyPath:'id', autoIncrement:true}); // M3 day view
      if (!d.objectStoreNames.contains('followups')) d.createObjectStore('followups', {keyPath:'id', autoIncrement:true}); // M3 CRM snooze/dismiss state
      if (!d.objectStoreNames.contains('portfolio')) d.createObjectStore('portfolio', {keyPath:'id', autoIncrement:true}); // M3 showcase
      if (!d.objectStoreNames.contains('research'))  d.createObjectStore('research',  {keyPath:'id', autoIncrement:true}); // M5 content library
      if (!d.objectStoreNames.contains('usageEvents')) d.createObjectStore('usageEvents', {keyPath:'id', autoIncrement:true}); // local-only usage analytics (never leaves this device)
      if (!d.objectStoreNames.contains('packages'))    d.createObjectStore('packages',    {keyPath:'id', autoIncrement:true}); // session bundles
      if (!d.objectStoreNames.contains('progressLogs')) d.createObjectStore('progressLogs', {keyPath:'id', autoIncrement:true}); // per-client weight/notes over time
      if (!d.objectStoreNames.contains('settings'))  d.createObjectStore('settings',  {keyPath:'key'});
      if (!d.objectStoreNames.contains('meta'))      d.createObjectStore('meta',      {keyPath:'key'});   // dormant (future sync)
      if (!d.objectStoreNames.contains('outbox'))    d.createObjectStore('outbox',    {keyPath:'key', autoIncrement:true}); // dormant
    };
    req.onsuccess = e => {
      db = e.target.result;
      // If another tab opens a newer version, close this connection so its
      // upgrade isn't blocked (and doesn't wedge). No silent hang.
      db.onversionchange = () => { db.close(); location.reload(); };
      res(db);
    };
    req.onerror = () => rej(req.error);
    // Another tab holds an older-version connection open: surface it instead of hanging forever.
    req.onblocked = () => rej(new Error('DB upgrade blocked — close other Sidekick tabs and reload.'));
  });
}
// One-time carry-over from the pre-rebrand "Freelanz Gym" database/session/UI-pref
// names into the new Sidekick ones, so a browser that already had local data
// doesn't get silently logged out or see an empty account after the rename.
// Guarded by a flag so it only ever runs once per browser; safe to no-op if
// the legacy DB never existed (a fresh install) or the browser doesn't support
// indexedDB.databases() (older Safari/Firefox — skips migration rather than
// crashing boot, since this is a best-effort convenience, not the data itself).
const LEGACY_MIGRATION_FLAG = 'sidekick_migrated_from_freelanz_gym';
async function migrateLegacyStorageIfNeeded() {
  if (localStorage.getItem(LEGACY_MIGRATION_FLAG)) return;
  try {
    const hasLegacyDb = typeof indexedDB.databases === 'function'
      ? (await indexedDB.databases()).some(d => d.name === LEGACY_DB_NAME)
      : false;
    if (hasLegacyDb) {
      const legacyDb = await new Promise((res, rej) => {
        const req = indexedDB.open(LEGACY_DB_NAME);   // no version arg — opens as-is, never triggers an upgrade
        req.onsuccess = e => res(e.target.result);
        req.onerror = () => rej(req.error);
      });
      for (const storeName of Array.from(legacyDb.objectStoreNames)) {
        if (!db.objectStoreNames.contains(storeName)) continue;   // e.g. retired 'memberTags'
        const rows = await new Promise(res => {
          legacyDb.transaction(storeName, 'readonly').objectStore(storeName).getAll().onsuccess = e => res(e.target.result);
        });
        for (const row of rows) {
          // put() (not add()) preserves each row's original id/key, so
          // cross-store references (jobs.clientId -> clients.id, etc.) stay intact.
          await new Promise(res => {
            const tx = db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).put(row);
            tx.oncomplete = () => res();
          });
        }
      }
      legacyDb.close();
    }
    // Carry over the logged-in session and UI prefs too, so a returning user
    // isn't bounced to the login screen or has their language/theme reset.
    const legacyPairs = [
      ['freelanz_gym_uid', SESSION_KEY],
      ['gym_guest_username', 'sidekick_guest_username'],
      ['gym_guest_counter', 'sidekick_guest_counter'],
      ['gym_ui_lang', 'sidekick_ui_lang'],
      ['gym_ui_theme', 'sidekick_ui_theme'],
    ];
    legacyPairs.forEach(([oldKey, newKey]) => {
      const v = localStorage.getItem(oldKey);
      if (v != null && localStorage.getItem(newKey) == null) localStorage.setItem(newKey, v);
    });
  } catch (e) { console.error('migrateLegacyStorageIfNeeded', e); }
  localStorage.setItem(LEGACY_MIGRATION_FLAG, '1');
}
function dbAll(store) {
  return new Promise(res => {
    const tx = db.transaction(store, 'readonly');
    tx.objectStore(store).getAll().onsuccess = e => res(e.target.result);
  });
}
function dbPut(store, obj) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(obj);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
function dbAdd(store, obj) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).add(obj);
    req.onsuccess = () => res(req.result);
    req.onerror = e => { e.preventDefault(); rej(req.error); };
  });
}
function dbDel(store, id) {
  return new Promise(res => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id).onsuccess = () => res();
  });
}
function dbGet(store, key) {
  return new Promise(res => {
    const tx = db.transaction(store, 'readonly');
    tx.objectStore(store).get(key).onsuccess = e => res(e.target.result);
  });
}
function dbGetByUsername(username) {
  return new Promise(res => {
    const tx = db.transaction('users', 'readonly');
    tx.objectStore('users').index('username').get(username).onsuccess = e => res(e.target.result);
  });
}
function cuid() { return crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
function nowISO() { return new Date().toISOString(); }

// ─── AUTH ─────────────────────────────────────────────────────────────
const SESSION_KEY = 'sidekick_uid';
let currentUser = null;
let authMode = 'login';
let isGuest = false;

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
}
function randomSalt() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2,'0')).join('');
}
const PBKDF2_ITERS = 100000;
async function hashPassword(password, salt, iters) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {name:'PBKDF2', hash:'SHA-256', salt: enc.encode(salt), iterations: iters},
    key, 256
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2,'0')).join('');
}
function setAuthMode(mode) {
  authMode = mode;
  document.getElementById('tab-login').classList.toggle('active', mode === 'login');
  document.getElementById('tab-register').classList.toggle('active', mode === 'register');
  document.getElementById('auth-confirm-wrap').style.display = mode === 'register' ? 'block' : 'none';
  document.getElementById('auth-name-wrap').style.display = mode === 'register' ? 'block' : 'none';
  document.getElementById('auth-submit').textContent = mode === 'register' ? t('create_account') : t('login');
  document.getElementById('auth-pass').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  authError('');
}
function authError(msg) {
  const el = document.getElementById('auth-err');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('show', !!msg);
}
// Stable per-device guest identity (label only; all guest data lives under the
// fixed uid 'guest' so leaving and re-entering guest mode restores it).
function guestUsername() {
  let u = localStorage.getItem('sidekick_guest_username');
  if (!u) {
    const n = (parseInt(localStorage.getItem('sidekick_guest_counter') || '0', 10) + 1);
    localStorage.setItem('sidekick_guest_counter', String(n));
    u = 'Guest' + String(n).padStart(6, '0');
    localStorage.setItem('sidekick_guest_username', u);
  }
  return u;
}
// Guest data lives under one fixed uid ('guest') per device, so a shared
// device's second guest sees the first guest's data by default — asking
// "resume or start fresh?" only when there's actually something to choose
// between (a brand-new guest on this device skips straight through, no
// extra tap for the common case).
async function loginGuest() {
  if (await guestDataExists()) {
    document.getElementById('s-auth').classList.remove('active');
    document.getElementById('s-guest-choice').classList.add('active');
    const nameEl = document.getElementById('guest-choice-name');
    if (nameEl) nameEl.textContent = guestUsername();
    return;
  }
  await proceedAsGuest();
}
function cancelGuestChoice() {
  document.getElementById('s-guest-choice').classList.remove('active');
  document.getElementById('s-auth').classList.add('active');
}
async function resumeGuest() { await proceedAsGuest(); }
async function startFreshGuest() {
  if (!confirm(t('guest_fresh_confirm'))) return;
  await wipeGuestData();
  await proceedAsGuest();
}
async function proceedAsGuest() {
  isGuest = true;
  currentUser = {id: 0, username: guestUsername()};
  localStorage.setItem(SESSION_KEY, 'guest');
  sessionStorage.setItem('sidekick_post_login_toast', t('welcome') + ', ' + t('guest_name') + '!');
  location.href = './';
}
// Cheap existence check reusing BACKUP_STORES (every uid-scoped store) —
// true the moment any of them holds a guest-uid row.
async function guestDataExists() {
  const lists = await Promise.all(BACKUP_STORES.map(s => dbAll(s)));
  return lists.some(rows => rows.some(r => r.uid === 'guest'));
}
// Erases every guest-uid row across every uid-scoped store, guest-prefixed
// settings, and local usage-analytics events (excluded from BACKUP_STORES
// since backups never carry it, but it's still this guest's data on this
// device) — then drops the remembered guest username/counter so the next
// guestUsername() call mints a genuinely new label, not the erased one's.
async function wipeGuestData() {
  for (const s of BACKUP_STORES) {
    const rows = (await dbAll(s)).filter(r => r.uid === 'guest');
    for (const row of rows) await dbDel(s, row.id);
  }
  const settingsRows = (await dbAll('settings')).filter(r => r.key.startsWith('guest:'));
  for (const row of settingsRows) await dbDel('settings', row.key);
  const events = (await dbAll('usageEvents')).filter(r => r.uid === 'guest');
  for (const row of events) await dbDel('usageEvents', row.id);
  localStorage.removeItem('sidekick_guest_username');
}

// ─── LINE LOGIN ───────────────────────────────────────────────────────
// api/line-login-callback.js hands the verified LINE profile back as a URL
// fragment (never sent to any server) on redirect to this page. Accounts
// are local-only here too — a LINE user is just another 'users' row, keyed
// by username `line:<sub>` so it can't collide with an email/username a
// person would type by hand, with hash:null marking it passwordless (only
// reachable via loginWithLine(), never via submitAuth()'s password check).
function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - b64url.length % 4) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
// The Vercel deployment is the only origin that runs api/ handlers at all
// (GitHub Pages is 100% static) — so this has to be an absolute cross-origin
// URL, not a relative one that would 404 on GitHub Pages. `returnTo` tells
// the serverless side which of the app's several live origins (GitHub Pages
// root, its /gym/ mirror, or this Vercel project's own static mirror) to
// send the browser back to once LINE's redirect dance is done — each is a
// separate origin with its own separate local IndexedDB, so getting this
// wrong strands the login in the wrong account store.
const LINE_LOGIN_ORIGIN = 'https://sidekickz.vercel.app';
function loginWithLine() {
  const returnTo = encodeURIComponent(location.origin + location.pathname);
  location.href = `${LINE_LOGIN_ORIGIN}/api/line-login-start?returnTo=${returnTo}`;
}
// Returns true if this load was a LINE redirect and login was handled
// (caller should stop its own boot sequence); false otherwise.
async function handleLineLoginRedirect() {
  const hash = location.hash;
  if (!hash) return false;
  const params = new URLSearchParams(hash.slice(1));
  const errCode = params.get('line_error');
  const encoded = params.get('line');
  history.replaceState(null, '', location.pathname + location.search);
  if (!errCode && !encoded) return false;
  if (errCode) { authError(t('err_line_login')); return false; }

  let profile;
  try { profile = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded))); }
  catch { authError(t('err_line_login')); return false; }
  if (!profile || !profile.sub) { authError(t('err_line_login')); return false; }

  const username = 'line:' + profile.sub;
  let user = await dbGetByUsername(username);
  if (!user) {
    const id = await dbAdd('users', {
      username, salt: null, hash: null, iters: null,
      firstName: profile.name || '', linePicture: profile.picture || '',
      lineAuth: true, profileComplete: false, createdAt: nowISO(),
    });
    // Re-fetch the full stored row rather than hand-assembling a slim one —
    // completeLineProfile() below does a keyPath put() of this same object,
    // which replaces the whole record, so it must carry every field
    // (salt/hash/iters/linePicture/etc.), not just the ones used here.
    user = await dbGet('users', id);
  }
  // profileComplete is undefined on any account created before this gate
  // existed (password accounts always had a name up front, and earlier LINE
  // sign-ins finished before this field existed) — only an explicit `false`
  // blocks entry, so nobody already-signed-up gets stopped retroactively.
  if (user.profileComplete === false) {
    showLineProfileStep(user);
    return true;
  }
  finishLineLogin(user);
  return true;
}

function finishLineLogin(user) {
  currentUser = { id: user.id, username: user.username, firstName: user.firstName || '' };
  isGuest = false;
  localStorage.setItem(SESSION_KEY, String(user.id));
  sessionStorage.setItem('sidekick_post_login_toast', t('welcome_back') + (user.firstName ? ', ' + user.firstName : '') + '!');
  location.href = './';
}

// First LINE sign-in only: LINE's own display name is sometimes a nickname/
// emoji, not the name the user wants stored — required (no skip), same as
// the equivalent field on password registration, but shown as its own step
// since there's no registration form to fold it into here. The account row
// already exists at this point (created above) but isn't logged into yet —
// SESSION_KEY is only set once this completes, so closing the tab mid-step
// just re-shows this same step next time, rather than leaving a half-signed-
// -in session.
let pendingLineUser = null;
function showLineProfileStep(user) {
  pendingLineUser = user;
  document.getElementById('line-profile-name').value = user.firstName || '';
  document.getElementById('s-auth').classList.remove('active');
  document.getElementById('s-line-profile').classList.add('active');
}
async function completeLineProfile() {
  const firstName = document.getElementById('line-profile-name').value.trim();
  if (!firstName) { document.getElementById('line-profile-err').classList.add('show'); return; }
  document.getElementById('line-profile-err').classList.remove('show');
  const user = { ...pendingLineUser, firstName, profileComplete: true };
  await dbPut('users', user);
  finishLineLogin(user);
}

async function submitAuth() {
  const id0 = document.getElementById('auth-user').value.trim().toLowerCase();
  const password = document.getElementById('auth-pass').value;
  const nameEl = document.getElementById('auth-name');
  const firstName = nameEl ? nameEl.value.trim() : '';
  // Local-only accounts, keyed by email/username string. (No cloud backend in M1.)
  if (!id0 || id0.length < 3) { authError(t('err_id_min3')); return; }
  if (!password || password.length < 8) { authError(t('err_pw_min4')); return; }
  if (authMode === 'register') {
    // 'line:' is a reserved prefix (see handleLineLoginRedirect() above) —
    // without this guard, someone could register e.g. "line:U1234..." by
    // hand and either collide with, or preemptively squat, a real LINE
    // user's account.
    if (id0.startsWith('line:')) { authError(t('err_reserved_username')); return; }
    if (!firstName) { authError(t('err_auth_name_required')); return; }
    if (password !== document.getElementById('auth-confirm').value) { authError(t('err_pw_mismatch')); return; }
    if (await dbGetByUsername(id0)) { authError(t('err_account_exists')); return; }
    const salt = randomSalt();
    const iters = PBKDF2_ITERS;
    const hash = await hashPassword(password, salt, iters);
    const id = await dbAdd('users', {username:id0, salt, hash, iters, firstName, profileComplete: true, createdAt: nowISO()});
    currentUser = {id, username:id0, firstName};
    isGuest = false;
    localStorage.setItem(SESSION_KEY, String(id));
    sessionStorage.setItem('sidekick_post_login_toast', t('welcome') + (firstName ? ', ' + firstName : '') + '!');
    location.href = './';
  } else {
    const user = await dbGetByUsername(id0);
    if (!user) { authError(t('err_no_account')); return; }
    const hash = await hashPassword(password, user.salt, user.iters || PBKDF2_ITERS);
    if (hash !== user.hash) { authError(t('err_incorrect_pw')); return; }
    currentUser = {id: user.id, username: user.username, firstName: user.firstName || ''};
    isGuest = false;
    localStorage.setItem(SESSION_KEY, String(user.id));
    sessionStorage.setItem('sidekick_post_login_toast', t('welcome_back') + (user.firstName ? ', ' + user.firstName : '') + '!');
    location.href = './';
  }
}
async function logout() {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.setItem('sidekick_post_login_toast', t('logged_out'));
  location.href = 'login.html';
}
async function restoreSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (raw === 'guest') { isGuest = true; currentUser = {id: 0, username: 'Guest'}; return true; }
  const uid = parseInt(raw);
  if (uid) {
    const u = (await dbAll('users')).find(x => x.id === uid);
    if (u) { currentUser = {id: u.id, username: u.username, firstName: u.firstName || ''}; isGuest = false; return true; }
    localStorage.removeItem(SESSION_KEY);
  }
  return false;
}

// ─── STATE ────────────────────────────────────────────────────────────
let jobs = [], expenses = [], customers = [], services = [], usageEvents = [], packages = [], settings = {lang:'th', currency:'THB'};
let currentPeriod = 'month';

// HTML/attr escaping (shared by all list/form renderers)
function htmlEsc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function attrEsc(s) { return htmlEsc(s).replace(/"/g,'&quot;'); }

const CURRENCY_SYM = {THB:'฿', USD:'$', EUR:'€', GBP:'£', SGD:'S$', MYR:'RM'};
function curSym() { return CURRENCY_SYM[(settings && settings.currency) || 'THB'] || '฿'; }

// ─── BUSINESS TYPES (persona reintroduced per the 2026 redesign handoff) ──
// Reverses the earlier "Persona strip" decision (commit 848c4e8) on explicit
// user instruction — settings.businessType now genuinely drives seed
// services and the unit word, not just which tracker card renders on a
// client (see clientTrackerHtml()). Existing installs migrate to 'trainer'
// in enterApp() (this app's actual base case up to now), so nobody already
// using it sees any behavior change.
const BUSINESS_TYPES = {
  trainer:    { label:'Personal trainer', unitWord:'Session', seedServices:[['1-on-1 session',800,'session'],['Group class',400,'session'],['Nutrition plan',2000,'plan']] },
  realestate: { label:'Real estate agent', unitWord:'Deal',    seedServices:[['Property viewing',0,'viewing'],['Listing consultation',0,'consult']] },
  laundry:    { label:'Laundry service',   unitWord:'Order',   seedServices:[['Wash & fold',150,'kg'],['Dry cleaning',80,'item']] },
  insurance:  { label:'Insurance agent',   unitWord:'Policy',  seedServices:[['Policy review',0,'review'],['Claim assistance',0,'case']] },
  garage:     { label:'Car garage',        unitWord:'Job',     seedServices:[['Oil change',600,'job'],['Full service',2500,'job']] },
  custom:     { label:'Other',             unitWord:'Job',     seedServices:[] },
};
function businessType() { return BUSINESS_TYPES[settings && settings.businessType] ? settings.businessType : 'trainer'; }
function unitWord() { return BUSINESS_TYPES[businessType()].unitWord; }

// Sensible per-persona starting point for a package's unit — "50 pieces of
// laundry," "10 training sessions," "5 policy reviews." Kept as a free-text
// setting (packageUnitLabel), not a fixed list, so a future business type
// this registry doesn't know about yet still works with zero code changes —
// the user just types whatever word fits.
const PACKAGE_UNIT_DEFAULTS = {
  trainer: 'Sessions', realestate: 'Deals', laundry: 'Pieces', insurance: 'Policies', garage: 'Jobs', custom: 'Units',
};
function packageUnitLabel() {
  return (settings && settings.packageUnitLabel) || PACKAGE_UNIT_DEFAULTS[businessType()] || 'Units';
}

// ─── ENGAGEMENT PIPELINE (user-facing label: "Workflow" — see i18n) ─────
// A session IS an engagement moving through a fixed 6-stage lifecycle. The
// internal stage id stays `pitch` even though its display label is now
// "Inquiry" — same rename convention as Booking→Calendar, only the
// user-facing text changed:
//   pitch    → initial outreach to a prospective client ("Inquiry")
//   quote    → send a price quote for a session/package
//   invoice  → send the invoice
//   paid     → payment received
//   delivery → deliver the session(s) themselves
//   extend   → offer a renewal/extension once delivered
// All six are mandatory and always present (no optional/toggleable stage,
// no per-persona presets) — this fixed order IS the business process. Still
// reorderable in Settings ▸ Stage order for personal preference, guarded so
// Paid can't precede Invoice.
const STAGES = ['pitch', 'quote', 'invoice', 'paid', 'delivery', 'extend'];
// dot: a distinct per-stage color used by the Booking calendar's activity
// legend (bookings.js) to show which stage(s) a day's engagements are in —
// chosen to read clearly at a few px each, separate from the semantically-
// loaded --paid/--due/--overdue vars used elsewhere for invoice status.
// label/action/done/hint hold i18n KEYS, not display text — every consumer
// must resolve them with t() (e.g. t(meta.label)), never read raw. Keeping
// the field names but swapping their values to keys (rather than adding new
// labelKey/actionKey fields) is a deliberate minimal-diff choice: every call
// site already reads `meta.label` etc, so only the read needs a `t()`
// wrapper, not a field rename everywhere.
const STAGE_META = {
  pitch:    {label:'stage_pitch_label',    dot:'#64748B', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:inline-block;vertical-align:middle"><path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4 20-7z"/></svg>', action:'stage_pitch_action',     done:'stage_pitch_done', hint:'stage_pitch_hint'},
  quote:    {label:'stage_quote_label',    dot:'#8B5CF6', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:inline-block;vertical-align:middle"><path d="M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-6.5A8 8 0 1 1 21 12z"/></svg>', action:'stage_quote_action',       done:'stage_quote_done', skippable:true, hint:'stage_quote_hint'},
  invoice:  {label:'stage_invoice_label',  dot:'#F59E0B', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:inline-block;vertical-align:middle"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6"/><path d="M9 11h6"/><path d="M9 15h4"/></svg>', action:'stage_invoice_action',      done:'stage_invoice_done', skippable:true, hint:'stage_invoice_hint'},
  paid:     {label:'stage_paid_label',     dot:'#2F9E5B', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:inline-block;vertical-align:middle"><circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M14.5 9.3C14.5 8.3 13.4 8 12 8s-2.5.6-2.5 1.7c0 2.4 5 1.2 5 3.6 0 1.1-1.1 1.7-2.5 1.7s-2.5-.4-2.5-1.4"/></svg>', action:'stage_paid_action',         done:'stage_paid_done', hint:'stage_paid_hint'},
  delivery: {label:'stage_delivery_label', dot:'#22554B', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:inline-block;vertical-align:middle"><path d="M14.5 5.5a3.5 3.5 0 0 0-4.6 4.4L4 15.8V20h4.2l5.9-5.9a3.5 3.5 0 0 0 4.4-4.6l-2.3 2.3-2-2z"/></svg>', action:'stage_delivery_action',  done:'stage_delivery_done', hint:'stage_delivery_hint'},
  extend:   {label:'stage_extend_label',   dot:'#0EA5E9', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:inline-block;vertical-align:middle"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>', action:'stage_extend_action',           done:'stage_extend_done', hint:'stage_extend_hint'},
};
const DEFAULT_STAGE_ORDER = STAGES.slice();
function getStageOrder() {
  const s = settings && settings.stageOrder;
  if (Array.isArray(s) && s.length === STAGES.length && s.every(x => STAGES.includes(x)) && new Set(s).size === s.length) {
    return s.slice();
  }
  return DEFAULT_STAGE_ORDER.slice();
}
// The stage order snapshotted onto a session at creation, so a later reorder
// in Settings never remaps an already-in-flight engagement out from under it.
function jobOrder(j) {
  const o = j && j.stageOrder;
  if (Array.isArray(o) && o.length && o.every(x => STAGES.includes(x)) && new Set(o).size === o.length) return o.slice();
  return getStageOrder();
}
// Current stage of a session within its own order. Legacy sessions (no stage)
// or ones whose stored stage was toggled out of the order fall back sensibly.
function jobStage(j) {
  const order = jobOrder(j);
  if (j.stage && order.includes(j.stage)) return j.stage;
  if (j.stage && !order.includes(j.stage)) return order[0];   // stage removed from order → restart at first
  return order[order.length - 1];                              // legacy (no stage) → final stage
}
// Legacy sessions (logged before this feature existed, no stage recorded) are
// treated as completed engagements (Done) — they represent already-earned work.
function jobComplete(j) {
  if (j.complete) return true;
  if (j.stage == null) return true;
  return false;
}
// A session "ships" (counts against a package) once it reaches Delivery or
// later in its own stage order, or is otherwise complete — matches the
// business meaning of "delivery" regardless of where a reorder puts it.
function jobDelivered(j) {
  if (jobComplete(j)) return true;
  const order = jobOrder(j);
  const deliveryIdx = order.indexOf('delivery');
  const idx = order.indexOf(jobStage(j));
  return deliveryIdx >= 0 && idx >= deliveryIdx;
}
// True exactly when the single next stage-advance would cross this job into
// "delivered" for the first time (not already there) — the one moment a
// package-linked job needs its quantity confirmed, since that's when it
// first counts against the package (see jobDelivered() above).
function entersDeliveryOnAdvance(j) {
  const order = jobOrder(j);
  const idx = order.indexOf(jobStage(j));
  const deliveryIdx = order.indexOf('delivery');
  if (idx < 0 || deliveryIdx < 0) return false;
  return idx < deliveryIdx && (idx + 1) >= deliveryIdx;
}

// ─── PACKAGES (N-unit bundles, e.g. "buy 10 sessions" / "50 pieces of laundry") ──
// Remaining is always computed live from `jobs` rather than decremented and
// stored, so it can never drift out of sync with a session being
// re-opened/un-delivered later. Sums each delivered job's own `count` (how
// many units THAT delivery used — e.g. 12 pieces this drop-off), falling
// back to 1 per job when count isn't set, so existing trainer packages
// (always 1 session per job) behave exactly as before with no migration.
function packageUsed(pkg) {
  return jobs
    .filter(j => j.packageId === pkg.id && jobDelivered(j))
    .reduce((sum, j) => sum + (Number(j.count) > 0 ? Number(j.count) : 1), 0);
}
// A single check point for expiry: once expiresAt passes, any unused
// balance is forfeited (not carried over) — this is the only place that
// needs to know about expiry, since activePackageFor()'s own
// `packageRemaining(p) > 0` filter then naturally excludes an expired
// package with no further changes needed there.
function packageIsExpired(pkg) {
  return !!(pkg.expiresAt && pkg.expiresAt < todayISO());
}
function packageRemaining(pkg) {
  if (packageIsExpired(pkg)) return 0;
  return Math.max(0, (Number(pkg.totalSessions) || 0) - packageUsed(pkg));
}
// Remaining ignoring expiry — only used to tell "expired with balance
// forfeited" apart from "genuinely used up," so the status message can say
// which actually happened instead of showing the same generic empty state.
function packageRemainingIgnoringExpiry(pkg) {
  return Math.max(0, (Number(pkg.totalSessions) || 0) - packageUsed(pkg));
}
// The package a new session should offer to apply to: the client's most
// recently purchased package that still has sessions left, or null.
function activePackageFor(clientId) {
  const mine = packages.filter(p => p.clientId === clientId)
    .sort((a, b) => (b.purchasedDate || '').localeCompare(a.purchasedDate || '') || (b.id || 0) - (a.id || 0));
  return mine.find(p => packageRemaining(p) > 0) || null;
}
function clientPackages(clientId) {
  return packages.filter(p => p.clientId === clientId)
    .sort((a, b) => (b.purchasedDate || '').localeCompare(a.purchasedDate || '') || (b.id || 0) - (a.id || 0));
}

// ─── I18N ─────────────────────────────────────────────────────────────
// t(key) resolves a persona-scoped `key@<workType>` variant first, then the
// base key, then the English fallback, then the raw key. Base (no workType) =
// "Job" wording. Add another locale later by adding I18N.<lang>.
const I18N = {
  en: {
    // auth
    login:'Log in', create_account:'Create account', email:'Email or username', password:'Password',
    confirm_password:'Confirm password', your_name:'Your name', login_guest:'Continue as guest', login_line:'Continue with LINE',
    guest_choice_title:'Welcome back', guest_choice_sub:'This device already has guest data saved on it.',
    guest_resume_btn:'Resume as', guest_fresh_btn:"Start fresh (erase this guest's data)",
    guest_fresh_confirm:'This permanently deletes all guest data on this device. This cannot be undone. Continue?',
    err_line_login:'LINE login didn’t go through — please try again.',
    err_reserved_username:'That username is reserved. Please choose a different one.',
    err_auth_name_required:'Please enter your name.',
    line_profile_title:'One more thing', line_profile_sub:'What name should we use for you?', btn_continue:'Continue',
    auth_hint:'Create an account to save your work on this device.<br>Everything stays local — no cloud, no tracking.<br>Guest mode is temporary.',
    tagline:'Get booked. Get hired. Get paid.',
    // nav
    nav_home:'Home', nav_docs:'Docs', nav_pipeline:'Task flow', nav_book:'Calendar', nav_more:'More',
    pipeline_title:'Task flow', workflow_title:'Stage order', pipeline_glance_title:'Task flow at a glance',
    skip_stage:'Skip', mark_finished:'Finished', reschedule:'Reschedule', cash_job:'Cash job', active_count:'active',
    stage_pitch_label:'Inquiry', stage_pitch_action:'Log inquiry', stage_pitch_done:'Inquired',
    stage_pitch_hint:'Inquiry — a prospective client reached out, not booked yet.',
    stage_quote_label:'Quote', stage_quote_action:'Send quote', stage_quote_done:'Quote sent',
    stage_quote_hint:'Quote — waiting on a price quote to go out.',
    stage_invoice_label:'Invoice', stage_invoice_action:'Send invoice', stage_invoice_done:'Invoice sent',
    stage_invoice_hint:'Invoice — quote accepted, waiting on the invoice to go out.',
    stage_paid_label:'Paid', stage_paid_action:'Mark paid', stage_paid_done:'Paid',
    stage_paid_hint:'Paid — invoiced, waiting on payment to come in.',
    stage_delivery_label:'Delivery', stage_delivery_action:'Mark delivered', stage_delivery_done:'Delivered',
    stage_delivery_hint:'Delivery — sessions scheduled, not yet delivered.',
    stage_extend_label:'Renew', stage_extend_action:'Renew', stage_extend_done:'Renewed',
    stage_extend_hint:'Renew — delivered, offer a renewal or wrap up.',
    pl_nothing_here:'Nothing here yet',
    // dashboard
    earned_this_month:'Earned this month', net_after_expenses:'net after expenses',
    stat_jobs:'Sessions', stat_avg:'Avg / session', stat_expenses:'Expenses',
    todays_goal:"Today's goal", goal_reached:'Goal reached! 🎉', goal_of:'of',
    my_task_goal:'My Task Goal', period_month:'Month', period_quarter:'Quarter', period_year:'Year',
    goal_pace_on:'On pace — ', goal_to_go_month:' to go this month', goal_to_go_quarter:' to go this quarter', goal_to_go_year:' to go this year',
    incoming_pipeline:'Up next', incoming_pipeline_empty:'Nothing scheduled.', incoming_pipeline_empty_sub:'New engagements will appear here as you log sessions.',
    coming_m2:'Invoices ship in M2',
    // job form
    add_job:'Add session', edit_job:'Edit session', save_job:'Save session', delete_job:'Delete session',
    field_date:'Date',
    field_client:'Member', field_amount:'Fee', field_tip:'Tip', field_expense:'Expense', field_count:'Sessions', field_notes:'Notes',
    field_notes_ph:'Anything to remember…',
    net_take:'Net take',
    // validation
    err_enter_date:'Please pick a date', err_amount:'Amount must be 0 or more', err_neg:'Values cannot be negative', err_too_big:'That value is too large',
    // settings
    more_title:'More', settings_title:'Settings', account:'Account', local_account:'Local account on this device',
    edit_name_title:'Edit your name', save_name:'Save name',
    preferences:'Preferences', currency:'Currency', theme:'Theme', language:'Language',
    theme_auto:'Auto', theme_light:'Light', theme_dark:'Dark',
    business_info_title:'Business info (optional)', business_info_sub:'Fill these in to have them show up automatically on your quotes, invoices, and receipts — none of them are required.',
    business_name:'Business name', business_taxid:'Tax ID', business_address:'Address',
    tax_defaults:'Tax defaults (for M2)', wht:'Withholding tax %', vat:'VAT %',
    daily_goal:'Daily income goal', goal_target_month:'Monthly income goal', goal_target_quarter:'Quarterly income goal', goal_target_year:'Yearly income goal',
    business_type_label:'Business type', business_type_trainer:'Personal trainer', business_type_realestate:'Real estate agent',
    business_type_laundry:'Laundry service', business_type_insurance:'Insurance agent', business_type_garage:'Car garage',
    business_type_custom:'Other',
    onboard_persona_title:'What kind of business do you run?', onboard_persona_sub:'Pick the closest match — we’ll set up starting services for it. You can change this anytime in Settings.',
    subtasks_title:'Sub-tasks', subtask_add_ph:'Add a sub-task…', btn_add:'+ Add', no_subtasks:'No sub-tasks yet.',
    milestones_title:'Milestone payments', add_milestone:'+ Add milestone', save_milestone:'Save milestone',
    draft_invoice:'Draft invoice', milestone_locked:'Locked', no_milestones:'No milestones yet.',
    unlocks_with:'Unlocks with: ', no_gating_subtask:'No gating sub-task',
    ms_amount_label:'Amount', ms_gate_label:'Gating sub-task (optional)', ms_gate_none:'None',
    time_tracking_title:'Time tracking', unbilled_time:'Unbilled time', start_timer:'▶ Start timer', stop_timer:'■ Stop timer',
    focus_mode_btn:'Focus mode', add_unbilled_to_invoice:'+ Add unbilled time to invoice', time_invoiced_label:'Invoiced',
    billable_session:'Billable this session:', focus_pause:'Pause', focus_resume:'Resume', focus_stop:'Stop',
    tracker_deal_title:'Deal tracker', tracker_order_title:'Order tracker', tracker_policy_title:'Policy tracker', tracker_vehicle_title:'Vehicle tracker',
    field_search_brief:'Budget / areas / needs', field_offer_status:'Offer status', field_est_commission:'Est. commission',
    deals_title:'Deals', no_deals:'No deals yet.', add_deal_btn:'+ Add deal', delete_deal_btn:'Delete deal',
    field_deal_stage:'Stage', deal_stage_searching:'Searching', deal_stage_viewing:'Viewing', deal_stage_offer:'Offer submitted',
    deal_stage_negotiating:'Negotiating', deal_stage_closing:'Closing', deal_stage_closed:'Closed',
    field_order_status:'Order status', order_step_received:'Received', order_step_washing:'Washing', order_step_drying:'Drying', order_step_ready:'Ready',
    field_monthly_kg_plan:'Monthly kg plan', field_preferences:'Preferences',
    current_order_title:'Current order', no_active_order:'No active order.', start_new_order_btn:'+ Start new order',
    field_order_date:'Order date', field_order_kg:'Weight (kg)', field_order_notes:'Notes',
    mark_picked_up_btn:'Mark picked up', order_history_title:'Order history', no_order_history:'No completed orders yet.',
    field_policy_name:'Policy name', field_renewal_date:'Renewal date',
    policies_title:'Policies', no_policies:'No policies yet.', add_policy_btn:'+ Add policy', delete_policy_btn:'Delete policy',
    field_plate:'Plate', field_mileage:'Mileage', field_next_service_due:'Next service due',
    day_singular:'day', day_plural:'days', overdue_for_renewal:'overdue for renewal', until_renewal:'until renewal',
    tracker_mealplan_title:'Meal plan', no_meal_plan_rows:'No meal plan rows yet.', meal_plan_add_ph:'Add a meal plan row…',
    viewing_log_title:'Viewing log', no_viewings:'No viewings logged yet.', field_viewing_property:'Property',
    viewing_verdict_interested:'Interested', viewing_verdict_maybe:'Maybe', viewing_verdict_passed:'Passed',
    field_birthday:'Birthday', field_referred_by:'Referred by',
    lifetime_spend_label:'Lifetime spend', service_history_title:'Service history', no_service_history:'No service history yet.',
    field_service_note:'Service note',
    vehicles_title:'Vehicles', no_vehicles:'No vehicles yet.', add_vehicle_btn:'+ Add vehicle', delete_vehicle_btn:'Delete vehicle',
    unnamed_vehicle:'Unnamed vehicle', svc_vehicle_none_option:'No vehicle (general)',
    package_unit_label:'Package unit', package_unit_ph:'Sessions',
    package_unit_sub:'What one unit of a package is called — "Pieces," "Sessions," "Policies," whatever fits.',
    apply_to_package:'Apply to package', of_label:'of', left_label:'left', purchased_label:'Purchased',
    field_price:'Price', save_package:'Save package', renew_package:'+ Renew package', new_package:'+ New package',
    no_units_left:'No {unit} left on the last package.', no_package_yet:'No package yet.',
    enter_package_total:'Enter how many {unit} this package includes', package_saved:'Package saved',
    confirm_delivered_title:'Confirm {unit} delivered', confirm_delivered_context:'{n} of {total} {unit} left on this package',
    confirm_cancel:'Cancel', confirm_and_advance:'Confirm & advance',
    confirm_overdraft_error:'Only {n} left on this package. Enter {n} or fewer, or start a new package first.',
    package_section_title:'Package',
    expires_label:'Expires', expires_ph:'Optional',
    package_expired_forfeited:'Expired {date} — {n} {unit} forfeited.',
    expiry_before_purchase:'Expiry date can’t be before the purchase date',
    log_delivery_btn:'Log delivery — {n} of {total} {unit} left',
    delivery_logged:'Delivered — {n} {unit} logged',
    data:'Data', export_csv:'Export CSV', backup_json:'Backup JSON', restore_json:'Restore JSON',
    total_jobs:'Total jobs', app_word:'App', version:'Version', logout:'Log out', exit_guest:'Exit guest mode',
    // placeholder modules
    invoices_title:'Invoices', docs_title:'Documents', book_title:'Calendar',
    module_soon_h:'Coming soon', mod_invoices_p:'Send branded invoices, track paid / due / overdue, and auto-fill tax. Arrives in M2.',
    mod_docs_p:'Store contracts, receipts and portfolio files — all on your device. Arrives in M2.',
    mod_book_p:'Share a booking link and let clients pick a slot. Arrives in M3.',
    pill_m2:'Ships in M2', pill_m3:'Ships in M3',
    // M3 — bookings (calendar / day agenda / booking form) — full i18n pass
    cal_today:'Today', cal_tomorrow:'Tomorrow', cal_yesterday:'Yesterday',
    wd_mon:'Mon', wd_tue:'Tue', wd_wed:'Wed', wd_thu:'Thu', wd_fri:'Fri', wd_sat:'Sat', wd_sun:'Sun',
    wd_full_mon:'Monday', wd_full_tue:'Tuesday', wd_full_wed:'Wednesday', wd_full_thu:'Thursday',
    wd_full_fri:'Friday', wd_full_sat:'Saturday', wd_full_sun:'Sunday',
    cal_mode_week:'Week', cal_mode_month:'Month',
    cal_prev_week_aria:'Previous week', cal_next_week_aria:'Next week',
    cal_prev_month_aria:'Previous month', cal_next_month_aria:'Next month',
    session_singular:'session', session_plural:'sessions',
    booking_word:'Booking', no_client_option:'No client',
    cal_gap_free_word:'Free', cal_gap_add_word:'+ add',
    cal_nothing_on:'Nothing on {date}', cal_tap_new_session_hint:'Tap “+ New session” above to log work.',
    cal_schedule_booking_link:'+ Schedule a booking', cal_new_session_btn:'+ New session',
    cal_tap_day_hint:'Tap a day to see what’s on it.', bookings_load_error:'Could not load bookings.',
    pipeline_section_label:'Pipeline', bookings_section_label:'Bookings',
    cal_overlap_msg:'Overlaps by {n} min{suffix}', cal_overlap_buffer_msg:'Overlaps by {n} min{suffix} — need {buf} min buffer',
    cal_short_gap_msg:'Only {n} min{suffix} — need {buf} min', cal_free_gap_msg:'{n} min free{suffix}',
    cal_before_ref:'before {ref}', cal_tomorrows_booking_ref:'tomorrow’s "{title}"',
    new_booking_title:'New booking', edit_booking_title:'Edit booking', booking_form_aria:'Booking form',
    field_title:'Title', bk_title_ph:'e.g. Portrait shoot',
    when_header:'When', start_time_label:'Start time', duration_min_label:'Duration (min)',
    travel_buffer_label:'Travel buffer after (min)', details_header:'Details',
    location_label:'Location', location_ph:'Address or place (optional)', status_label:'Status',
    repeat_header:'Repeat', repeat_none_option:'Does not repeat', repeat_weekly_option:'Weekly',
    repeat_biweekly_option:'Every 2 weeks', repeat_until_label:'Repeat until',
    save_changes_btn:'Save changes', create_booking_btn:'Create booking', delete_booking_btn:'Delete booking',
    status_scheduled:'Scheduled', status_done:'Done', status_cancelled:'Cancelled',
    booking_not_found:'Booking not found', booking_updated:'Booking updated', booking_created:'Booking created',
    booking_created_series:'Booking created (+{n} more in the series)', booking_save_failed:'Could not save booking',
    err_pick_date:'Pick a date', err_pick_start_time:'Pick a start time', err_enter_booking_title:'Enter a title for this booking',
    err_duration_min:'Duration must be at least 1 minute', err_repeat_end_date:'Pick an end date for the repeat',
    err_repeat_end_after:'Repeat end date must be after the booking date',
    delete_booking_confirm:'Delete this booking? This cannot be undone.', booking_deleted:'Booking deleted',
    // M2 — invoices (list / form / detail / print / payment channels) — full i18n pass
    inv_status_paid:'Paid', inv_status_overdue:'Overdue', inv_status_sent:'Sent', inv_status_draft:'Draft',
    tawi_cert_title:'50 Tawi certificate', tawi_received:'Received',
    tawi_missing_template:'Missing · {n} {unit} outstanding',
    mark_missing_btn:'Mark missing', mark_received_btn:'Mark received',
    new_invoice_btn:'+ New invoice', no_invoices:'No invoices yet',
    no_invoices_sub:'Create your first invoice — add line items, snapshot tax, and share a PromptPay QR.',
    inv_outstanding_label:'Outstanding', liquid_revenue_label:'Liquid revenue', wht_tax_credits_label:'WHT tax credits',
    new_invoice_title:'New invoice', edit_invoice_title:'Edit invoice', invoice_form_aria:'Invoice form',
    free_text_option:'— Free text —', add_line_from_service_option:'+ Add line from service…',
    pick_client_label:'Pick a client', bill_to_name_label:'Bill to (name)', client_company_name_ph:'Client or company name',
    dates_status_header:'Dates & status', issue_date_label:'Issue date', due_date_label:'Due date',
    line_items_header:'Line items', add_from_service_label:'Add from service', add_blank_line_btn:'+ Add blank line',
    tax_deposit_header:'Tax & deposit', wht_pct_label:'WHT %', deposit_pct_label:'Deposit % (upfront, optional)',
    invoice_notes_label:'Notes (shown on the invoice)', create_invoice_btn:'Create invoice', delete_invoice_btn:'Delete invoice',
    description_ph:'Description', remove_line_aria:'Remove line', qty_label:'Qty', quantity_aria:'Quantity',
    rate_label:'Rate', unit_price_aria:'Unit price',
    subtotal_label:'Subtotal', vat_pct_row:'VAT ({pct}%)', wht_pct_row:'WHT ({pct}%)',
    client_pays_label:'Client pays', you_receive_label:'You receive', deposit_pct_row:'Deposit ({pct}%)',
    err_enter_billed_to:'Enter who this invoice is billed to', err_add_line_item:'Add at least one line item',
    err_invoice_total_zero:'Invoice total must be greater than zero',
    invoice_updated:'Invoice updated', invoice_created_with_number:'Invoice {number} created', invoice_save_failed:'Could not save invoice',
    delete_invoice_confirm:'Delete this invoice? This cannot be undone.', invoice_deleted:'Invoice deleted',
    invoice_not_found:'Invoice not found', invoice_detail_aria:'Invoice detail', invoice_word:'Invoice',
    tax_id_prefix:'Tax ID: ', issued_label:'Issued', due_label:'Due',
    edit_btn:'Edit', print_pdf_btn:'Print / PDF', change_status_label:'Change status', close_btn:'Close',
    add_payment_channel_hint:'Add a payment channel (PromptPay, bank transfer, etc.) in <b>More → Settings</b> to show clients how to pay.',
    scan_promptpay_label:'Scan with any Thai banking app', promptpay_label:'PromptPay', payment_word:'Payment',
    bill_to_label:'Bill to', amount_header:'Amount', status_toast_prefix:'Status: ',
    service_word:'Service', qr_unavailable:'QR unavailable',
    // misc
    welcome:'Welcome', welcome_back:'Welcome back', guest_name:'Guest', logged_out:'Logged out',
    greeting_morning:'Good morning', greeting_afternoon:'Good afternoon', greeting_evening:'Good evening',
    cancel:'Cancel', saved:'Saved', deleted:'Deleted', job_saved:'Job saved', job_deleted:'Job deleted',
    exported:'Exported', restore_confirm:'Restore this backup? It REPLACES this account’s {n} current jobs + expenses. This cannot be undone.',
    restore_done:'Restored {n} records', restore_bad_file:'Not a valid Sidekick backup file',
    restore_failed:'Restore failed — your existing data was kept.',
    backup_reminder_title:'Back up your data', backup_reminder_sub:'Everything lives only on this device. Last backup: {date}.',
    backup_now:'Back up now', remind_later:'Remind me later', backup_snoozed:'Reminder snoozed for 2 weeks', backup_never:'never',
    cloud_backup_title:'Cloud backup (beta)', cloud_backup_disabled_sub:'Your clients only live on this device. Turn this on to also keep a copy in your account.',
    cloud_backup_enabled_sub:'Your clients are backed up to your account.', cloud_backup_enable_btn:'Enable cloud backup',
    cloud_backup_reenter_password:'Enter your password to finish enabling cloud backup:',
    cloud_backup_failed:'Could not enable cloud backup — try again in a moment.',
    cloud_backup_upload_failed:'Enabled, but the first backup failed — it will retry next time you save a client.',
    cloud_backup_enabled_toast:'Cloud backup enabled — {n} client(s) backed up.',
    cloud_backup_modal_body:'Right now your clients only live on this device — if it\'s lost or reset, they\'re gone. Turn on cloud backup to also keep a copy in your account. You can always do this later from Settings.',
    cloud_backup_later_btn:'Not now',
    subscription_needs_account_hint:'Enable cloud backup above to start your 15-day free trial and manage billing.',
    subscription_plan_basic:'Basic plan', subscription_plan_pro:'Pro plan', subscription_plan_team:'Team plan',
    subscription_status_trialing:'Free trial — {n} day(s) left', subscription_status_active:'Active',
    subscription_status_past_due:'Payment failed — update your card to keep access', subscription_status_canceled:'Canceled',
    subscription_status_locked:'Trial ended',
    subscription_locked_banner:'Your trial has ended. Your data is safe and visible, but you\'ll need to subscribe to add or edit anything.',
    subscription_upgrade_pro_btn:'Upgrade to Pro — ฿{price}/mo', subscription_subscribe_basic_btn:'Subscribe to Basic — ฿{price}/mo',
    subscription_manage_billing_btn:'Manage billing', subscription_checkout_failed:'Could not start checkout — try again in a moment.',
    subscription_portal_failed:'Could not open billing — try again in a moment.',
    client_cap_reached:'You\'ve reached your plan\'s client limit — upgrade in Settings > Subscription to add more.',
    recurring_locked:'Repeat bookings need a Pro subscription — upgrade in Settings > Subscription.',
    research_premium_plan_note:'Premium articles are also included free with a Pro subscription.',
    business_logo:'Business logo', doc_branding_locked:'Add your logo to quotes/invoices/receipts with a Pro subscription.',
    remove_logo_btn:'Remove logo', image_too_large:'Image too large — please pick one under 2MB', image_read_failed:'Could not read that image',
    delete_job_confirm:'Delete this job?', name_saved:'Name saved',
    err_id_min3:'Enter an email or username (3+ characters).', err_pw_min4:'Password must be at least 8 characters.',
    err_pw_mismatch:'Passwords do not match.', err_account_exists:'That account already exists on this device.',
    err_no_account:'No account with that email on this device.', err_incorrect_pw:'Incorrect password.',
    // More/Settings menu rows added after the initial i18n pass (Manage's
    // Docs row, More tools, Preferences' page-size/notifications, Payment
    // channels, Data's invoices-CSV export)
    manage_docs_row:'Docs', more_tools_title:'More tools',
    followups_row_title:'Follow-ups', portfolio_row_title:'Portfolio', research_row_title:'Research',
    page_size_label:'Document page size', notifications_label:'Notifications',
    notifications_sub:'Overdue invoices, bookings starting soon, and stuck engagements — only while this app is open or recently open in the background.',
    payment_channels_title:'Payment channels',
    payment_channels_sub:'Add PromptPay, bank transfer, cash, or another method so clients know how to pay you. PromptPay shows a scannable QR on invoices; the rest show as reference text.',
    add_payment_channel:'+ Add payment channel', export_invoices_csv:'Export invoices CSV', export_pnd_summary:'Export P.N.D. summary CSV',
    no_payment_channels:'No payment channels yet', no_payment_channels_sub:'Add PromptPay, bank transfer, cash, or another method so clients know how to pay you.',
    business_name_ph:'Defaults to your account name',
    // M1.5 — customers (displayed as "client" throughout — the gym-trainer term)
    manage:'Manage', customers_title:'Clients', add_customer:'Add client', edit_customer:'Edit client',
    save_customer:'Save client', delete_customer:'Delete client', delete_customer_confirm:'Delete this client?',
    no_customers:'No clients yet', no_customers_sub:'Add your first client to reuse their details.',
    needs_attention_title:'Needs attention', all_clients_title:'All clients', remind_action:'Remind', offer_renewal_action:'Offer renewal',
    customer_saved:'Client saved', customer_deleted:'Client deleted',
    field_name:'Name', field_phone:'Phone', field_email:'Email', field_tags:'Tags (comma-separated)',
    field_taxid:'Tax ID', field_billing:'Billing address', field_member_no:'Member ID',
    field_health:'Health notes', field_allergies:'Allergies', field_goals:'Goals',
    assigned_on_save:'(assigned on save)',
    err_name_required:'Please enter a name',
    err_select_client:'Please select a client',
    // M1.5 — services
    services_title:'Services', add_service:'Add service', edit_service:'Edit service', save_service:'Save service',
    delete_service:'Delete service', delete_service_confirm:'Delete this service?',
    no_services:'No services yet', no_services_sub:'Add services to prefill fees when logging work.',
    service_saved:'Service saved', service_deleted:'Service deleted',
    field_rate:'Package Price', field_unit:'Unit', field_unit_ph:'e.g. session, hour, project',
    field_usage_qty:'Service usage qty', add_new_service_option:'+ Add a new service',
    // M1.5 — job form links
    field_customer:'Client', field_service:'Service', none_option:'— None —',
    add_new_client_option:'+ Add a new client…',
    export_customers_csv:'Export clients CSV',
    nav_customers:'Clients',
    // Usage insights (local-only analytics)
    insights_title:'Insights', no_insights:'No activity yet', no_insights_sub:'Insights build up as you use the app — nothing is sent anywhere, this stays on your device.',
    insights_sessions_logged:'Sessions logged', insights_clients_added:'Clients added', insights_active_days_30:'Active days (30d)',
    insights_feature_usage:'Feature usage', insights_pipeline_activity:'Task flow activity', insights_no_pipeline_activity:'No task flow activity yet',
    insights_stage_done:'Completed', insights_clear:'Clear usage data', insights_clear_confirm:'Clear all local usage data? This cannot be undone.',
    insights_cleared:'Usage data cleared', insights_unlocked:'Insights unlocked',
  },
  // Thai — covers the static app chrome (nav, Settings/More menu, dashboard,
  // forms, toasts) via the same data-i18n/t() keys as `en`, plus the full
  // bookings.js (calendar/day agenda/booking form) and invoices.js (list/
  // form/detail/print/payment channels) UI text added in the M2/M3 i18n
  // pass above. Screens built by other owned modules that don't route their
  // dynamic content through t() yet (docgen.js generated documents, tax.js)
  // stay English — out of scope for this pass; t() already falls back to
  // `en` for any key missing here, so nothing breaks either way.
  th: {
    // auth
    login:'เข้าสู่ระบบ', create_account:'สร้างบัญชี', email:'อีเมลหรือชื่อผู้ใช้', password:'รหัสผ่าน',
    confirm_password:'ยืนยันรหัสผ่าน', your_name:'ชื่อของคุณ', login_guest:'เข้าใช้แบบผู้เยี่ยมชม', login_line:'เข้าสู่ระบบด้วย LINE',
    guest_choice_title:'ยินดีต้อนรับกลับมา', guest_choice_sub:'อุปกรณ์นี้มีข้อมูลผู้เยี่ยมชมที่บันทึกไว้อยู่แล้ว',
    guest_resume_btn:'ดำเนินการต่อในชื่อ', guest_fresh_btn:'เริ่มต้นใหม่ (ลบข้อมูลผู้เยี่ยมชมนี้)',
    guest_fresh_confirm:'การทำเช่นนี้จะลบข้อมูลผู้เยี่ยมชมทั้งหมดบนอุปกรณ์นี้อย่างถาวร ไม่สามารถย้อนกลับได้ ดำเนินการต่อหรือไม่?',
    err_line_login:'เข้าสู่ระบบด้วย LINE ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
    err_reserved_username:'ชื่อผู้ใช้นี้ถูกสงวนไว้ กรุณาเลือกชื่ออื่น',
    err_auth_name_required:'กรุณากรอกชื่อของคุณ',
    line_profile_title:'อีกนิดเดียว', line_profile_sub:'ใช้ชื่ออะไรดี?', btn_continue:'ดำเนินการต่อ',
    auth_hint:'สร้างบัญชีเพื่อบันทึกข้อมูลไว้ในเครื่องนี้<br>ทุกอย่างเก็บอยู่ในเครื่อง — ไม่มีคลาวด์ ไม่มีการติดตาม<br>โหมดผู้เยี่ยมชมใช้งานได้ชั่วคราวเท่านั้น',
    tagline:'จองคิวได้ ได้งาน ได้รับเงิน',
    // nav
    nav_home:'หน้าแรก', nav_docs:'เอกสาร', nav_pipeline:'แผนงาน', nav_book:'ปฏิทิน', nav_more:'เพิ่มเติม',
    pipeline_title:'แผนงาน', workflow_title:'ลำดับขั้นตอน', pipeline_glance_title:'ภาพรวมแผนงาน',
    skip_stage:'ข้าม', mark_finished:'เสร็จสิ้น', reschedule:'เลื่อนนัด', cash_job:'จ่ายสด', active_count:'กำลังดำเนินการ',
    stage_pitch_label:'สอบถาม', stage_pitch_action:'บันทึกการสอบถาม', stage_pitch_done:'สอบถามแล้ว',
    stage_pitch_hint:'สอบถาม — ลูกค้าที่มีแนวโน้มติดต่อมา ยังไม่ได้จองงาน',
    stage_quote_label:'เสนอราคา', stage_quote_action:'ส่งใบเสนอราคา', stage_quote_done:'ส่งใบเสนอราคาแล้ว',
    stage_quote_hint:'เสนอราคา — รอส่งใบเสนอราคาให้ลูกค้า',
    stage_invoice_label:'ใบแจ้งหนี้', stage_invoice_action:'ส่งใบแจ้งหนี้', stage_invoice_done:'ส่งใบแจ้งหนี้แล้ว',
    stage_invoice_hint:'ใบแจ้งหนี้ — ลูกค้ายอมรับราคาแล้ว รอส่งใบแจ้งหนี้',
    stage_paid_label:'ชำระแล้ว', stage_paid_action:'บันทึกว่าชำระแล้ว', stage_paid_done:'ชำระแล้ว',
    stage_paid_hint:'ชำระแล้ว — ส่งใบแจ้งหนี้แล้ว รอรับชำระเงิน',
    stage_delivery_label:'ส่งมอบ', stage_delivery_action:'บันทึกว่าส่งมอบแล้ว', stage_delivery_done:'ส่งมอบแล้ว',
    stage_delivery_hint:'ส่งมอบ — นัดหมายแล้ว ยังไม่ได้ส่งมอบงาน',
    stage_extend_label:'ต่ออายุ', stage_extend_action:'ต่ออายุ', stage_extend_done:'ต่ออายุแล้ว',
    stage_extend_hint:'ต่ออายุ — ส่งมอบแล้ว เสนอการต่ออายุหรือปิดงาน',
    pl_nothing_here:'ยังไม่มีงานในขั้นตอนนี้',
    // dashboard
    earned_this_month:'รายได้เดือนนี้', net_after_expenses:'สุทธิหลังหักค่าใช้จ่าย',
    stat_jobs:'เซสชัน', stat_avg:'เฉลี่ย/เซสชัน', stat_expenses:'ค่าใช้จ่าย',
    todays_goal:'เป้าหมายวันนี้', goal_reached:'ถึงเป้าหมายแล้ว! 🎉', goal_of:'จาก',
    my_task_goal:'เป้าหมายงานของฉัน', period_month:'เดือน', period_quarter:'ไตรมาส', period_year:'ปี',
    goal_pace_on:'ตามเป้า — เหลืออีก ', goal_to_go_month:' ในเดือนนี้', goal_to_go_quarter:' ในไตรมาสนี้', goal_to_go_year:' ในปีนี้',
    incoming_pipeline:'ถัดไป', incoming_pipeline_empty:'ยังไม่มีนัดหมาย', incoming_pipeline_empty_sub:'งานใหม่จะปรากฏที่นี่เมื่อคุณบันทึกเซสชัน',
    coming_m2:'ใบแจ้งหนี้จะเปิดใช้งานใน M2',
    // job form
    add_job:'เพิ่มเซสชัน', edit_job:'แก้ไขเซสชัน', save_job:'บันทึกเซสชัน', delete_job:'ลบเซสชัน',
    field_date:'วันที่',
    field_client:'สมาชิก', field_amount:'ค่าธรรมเนียม', field_tip:'ทิป', field_expense:'ค่าใช้จ่าย', field_count:'จำนวนเซสชัน', field_notes:'บันทึกช่วยจำ',
    field_notes_ph:'สิ่งที่ต้องจำ…',
    net_take:'รายรับสุทธิ',
    // validation
    err_enter_date:'กรุณาเลือกวันที่', err_amount:'จำนวนเงินต้องมากกว่าหรือเท่ากับ 0', err_neg:'ค่าต้องไม่ติดลบ', err_too_big:'ค่านี้สูงเกินไป',
    // settings
    more_title:'เพิ่มเติม', settings_title:'ตั้งค่า', account:'บัญชี', local_account:'บัญชีในเครื่องนี้',
    edit_name_title:'แก้ไขชื่อของคุณ', save_name:'บันทึกชื่อ',
    preferences:'การตั้งค่าทั่วไป', currency:'สกุลเงิน', theme:'ธีม', language:'ภาษา',
    theme_auto:'อัตโนมัติ', theme_light:'สว่าง', theme_dark:'มืด',
    business_info_title:'ข้อมูลธุรกิจ (ไม่บังคับ)', business_info_sub:'กรอกข้อมูลนี้เพื่อให้แสดงอัตโนมัติในใบเสนอราคา ใบแจ้งหนี้ และใบเสร็จ — ไม่บังคับกรอก',
    business_name:'ชื่อธุรกิจ', business_taxid:'เลขประจำตัวผู้เสียภาษี', business_address:'ที่อยู่',
    tax_defaults:'ค่าเริ่มต้นภาษี', wht:'ภาษีหัก ณ ที่จ่าย %', vat:'ภาษีมูลค่าเพิ่ม %',
    daily_goal:'เป้าหมายรายได้ต่อวัน', goal_target_month:'เป้าหมายรายได้ต่อเดือน', goal_target_quarter:'เป้าหมายรายได้ต่อไตรมาส', goal_target_year:'เป้าหมายรายได้ต่อปี',
    business_type_label:'ประเภทธุรกิจ', business_type_trainer:'เทรนเนอร์ส่วนตัว', business_type_realestate:'นายหน้าอสังหาริมทรัพย์',
    business_type_laundry:'ร้านซักรีด', business_type_insurance:'ตัวแทนประกันภัย', business_type_garage:'อู่ซ่อมรถ',
    business_type_custom:'อื่นๆ',
    onboard_persona_title:'ธุรกิจของคุณเป็นแบบไหน?', onboard_persona_sub:'เลือกที่ใกล้เคียงที่สุด — เราจะตั้งค่าบริการเริ่มต้นให้ คุณเปลี่ยนได้ทุกเมื่อในการตั้งค่า',
    subtasks_title:'งานย่อย', subtask_add_ph:'เพิ่มงานย่อย…', btn_add:'+ เพิ่ม', no_subtasks:'ยังไม่มีงานย่อย',
    milestones_title:'การจ่ายเงินตามช่วงงาน', add_milestone:'+ เพิ่มช่วงงาน', save_milestone:'บันทึกช่วงงาน',
    draft_invoice:'ร่างใบแจ้งหนี้', milestone_locked:'ล็อกอยู่', no_milestones:'ยังไม่มีช่วงงาน',
    unlocks_with:'ปลดล็อกเมื่อ: ', no_gating_subtask:'ไม่มีงานย่อยที่ต้องรอ',
    ms_amount_label:'จำนวนเงิน', ms_gate_label:'งานย่อยที่ต้องรอ (ไม่บังคับ)', ms_gate_none:'ไม่มี',
    time_tracking_title:'บันทึกเวลา', unbilled_time:'เวลาที่ยังไม่เรียกเก็บเงิน', start_timer:'▶ เริ่มจับเวลา', stop_timer:'■ หยุดจับเวลา',
    focus_mode_btn:'โหมดโฟกัส', add_unbilled_to_invoice:'+ เพิ่มเวลาที่ยังไม่เรียกเก็บเงินลงใบแจ้งหนี้', time_invoiced_label:'ออกใบแจ้งหนี้แล้ว',
    billable_session:'เวลาที่เรียกเก็บเงินได้ในเซสชันนี้:', focus_pause:'หยุดชั่วคราว', focus_resume:'ดำเนินการต่อ', focus_stop:'หยุด',
    tracker_deal_title:'ติดตามดีล', tracker_order_title:'ติดตามออเดอร์', tracker_policy_title:'ติดตามกรมธรรม์', tracker_vehicle_title:'ติดตามรถ',
    field_search_brief:'งบประมาณ / ทำเล / ความต้องการ', field_offer_status:'สถานะข้อเสนอ', field_est_commission:'ค่าคอมมิชชั่นโดยประมาณ',
    deals_title:'ดีล', no_deals:'ยังไม่มีดีล', add_deal_btn:'+ เพิ่มดีล', delete_deal_btn:'ลบดีล',
    field_deal_stage:'ขั้นตอน', deal_stage_searching:'กำลังหา', deal_stage_viewing:'กำลังดูสถานที่', deal_stage_offer:'ยื่นข้อเสนอแล้ว',
    deal_stage_negotiating:'กำลังต่อรอง', deal_stage_closing:'ปิดการขาย', deal_stage_closed:'ปิดแล้ว',
    field_order_status:'สถานะออเดอร์', order_step_received:'รับผ้าแล้ว', order_step_washing:'กำลังซัก', order_step_drying:'กำลังตาก', order_step_ready:'พร้อมรับ',
    field_monthly_kg_plan:'แผนกิโลกรัมต่อเดือน', field_preferences:'ความต้องการเฉพาะ',
    current_order_title:'ออเดอร์ปัจจุบัน', no_active_order:'ไม่มีออเดอร์ที่กำลังดำเนินการ', start_new_order_btn:'+ เริ่มออเดอร์ใหม่',
    field_order_date:'วันที่รับออเดอร์', field_order_kg:'น้ำหนัก (กก.)', field_order_notes:'หมายเหตุ',
    mark_picked_up_btn:'ทำเครื่องหมายว่ารับแล้ว', order_history_title:'ประวัติออเดอร์', no_order_history:'ยังไม่มีออเดอร์ที่เสร็จสมบูรณ์',
    field_policy_name:'ชื่อกรมธรรม์', field_renewal_date:'วันต่ออายุ',
    policies_title:'กรมธรรม์', no_policies:'ยังไม่มีกรมธรรม์', add_policy_btn:'+ เพิ่มกรมธรรม์', delete_policy_btn:'ลบกรมธรรม์',
    field_plate:'ทะเบียนรถ', field_mileage:'เลขไมล์', field_next_service_due:'กำหนดเข้าศูนย์ครั้งถัดไป',
    day_singular:'วัน', day_plural:'วัน', overdue_for_renewal:'เลยกำหนดต่ออายุ', until_renewal:'ก่อนถึงกำหนดต่ออายุ',
    tracker_mealplan_title:'แผนมื้ออาหาร', no_meal_plan_rows:'ยังไม่มีแผนมื้ออาหาร', meal_plan_add_ph:'เพิ่มรายการแผนมื้ออาหาร…',
    viewing_log_title:'บันทึกการดูสถานที่', no_viewings:'ยังไม่มีบันทึกการดูสถานที่', field_viewing_property:'ทรัพย์สิน',
    viewing_verdict_interested:'สนใจ', viewing_verdict_maybe:'อาจจะ', viewing_verdict_passed:'ไม่สนใจ',
    field_birthday:'วันเกิด', field_referred_by:'แนะนำโดย',
    lifetime_spend_label:'ยอดใช้จ่ายสะสม', service_history_title:'ประวัติการซ่อมบำรุง', no_service_history:'ยังไม่มีประวัติการซ่อมบำรุง',
    field_service_note:'บันทึกการซ่อมบำรุง',
    vehicles_title:'ยานพาหนะ', no_vehicles:'ยังไม่มียานพาหนะ', add_vehicle_btn:'+ เพิ่มยานพาหนะ', delete_vehicle_btn:'ลบยานพาหนะ',
    unnamed_vehicle:'ยานพาหนะไม่มีชื่อ', svc_vehicle_none_option:'ไม่ระบุยานพาหนะ (ทั่วไป)',
    package_unit_label:'หน่วยแพ็กเกจ', package_unit_ph:'เซสชัน',
    package_unit_sub:'หน่วยของแพ็กเกจเรียกว่าอะไร — "ชิ้น" "เซสชัน" "กรมธรรม์" หรือคำที่เหมาะกับธุรกิจของคุณ',
    apply_to_package:'ใช้กับแพ็กเกจ', of_label:'จาก', left_label:'เหลือ', purchased_label:'ซื้อเมื่อ',
    field_price:'ราคา', save_package:'บันทึกแพ็กเกจ', renew_package:'+ ต่ออายุแพ็กเกจ', new_package:'+ แพ็กเกจใหม่',
    no_units_left:'ไม่มี{unit}เหลือในแพ็กเกจล่าสุด', no_package_yet:'ยังไม่มีแพ็กเกจ',
    enter_package_total:'ระบุจำนวน{unit}ที่รวมอยู่ในแพ็กเกจนี้', package_saved:'บันทึกแพ็กเกจแล้ว',
    confirm_delivered_title:'ยืนยันจำนวน{unit}ที่ส่งมอบ', confirm_delivered_context:'เหลือ {n} จาก {total} {unit} ในแพ็กเกจนี้',
    confirm_cancel:'ยกเลิก', confirm_and_advance:'ยืนยันและดำเนินการต่อ',
    confirm_overdraft_error:'เหลือเพียง {n} ในแพ็กเกจนี้ กรุณาใส่ {n} หรือน้อยกว่า หรือเริ่มแพ็กเกจใหม่',
    package_section_title:'แพ็กเกจ',
    expires_label:'วันหมดอายุ', expires_ph:'ไม่บังคับ',
    package_expired_forfeited:'หมดอายุเมื่อ {date} — {n} {unit} ถูกยกเลิก',
    expiry_before_purchase:'วันหมดอายุต้องไม่ก่อนวันที่ซื้อ',
    log_delivery_btn:'บันทึกการส่งมอบ — เหลือ {n} จาก {total} {unit}',
    delivery_logged:'ส่งมอบแล้ว — บันทึก {n} {unit}',
    data:'ข้อมูล', export_csv:'ส่งออก CSV', backup_json:'สำรองข้อมูล JSON', restore_json:'กู้คืนข้อมูล JSON',
    total_jobs:'จำนวนเซสชันทั้งหมด', app_word:'แอป', version:'เวอร์ชัน', logout:'ออกจากระบบ', exit_guest:'ออกจากโหมดผู้เยี่ยมชม',
    // placeholder modules
    invoices_title:'ใบแจ้งหนี้', docs_title:'เอกสาร', book_title:'ปฏิทิน',
    module_soon_h:'เร็วๆ นี้', mod_invoices_p:'ส่งใบแจ้งหนี้ที่มีแบรนด์ของคุณ ติดตามสถานะจ่ายแล้ว/ค้างจ่าย/เกินกำหนด และคำนวณภาษีอัตโนมัติ เปิดใช้งานใน M2',
    mod_docs_p:'เก็บสัญญา ใบเสร็จ และผลงานทั้งหมดไว้ในเครื่องของคุณ เปิดใช้งานใน M2',
    mod_book_p:'แชร์ลิงก์นัดหมายให้ลูกค้าเลือกเวลาได้เอง เปิดใช้งานใน M3',
    pill_m2:'เปิดใช้งานใน M2', pill_m3:'เปิดใช้งานใน M3',
    // M3 — bookings (calendar / day agenda / booking form) — full i18n pass
    cal_today:'วันนี้', cal_tomorrow:'พรุ่งนี้', cal_yesterday:'เมื่อวาน',
    wd_mon:'จ.', wd_tue:'อ.', wd_wed:'พ.', wd_thu:'พฤ.', wd_fri:'ศ.', wd_sat:'ส.', wd_sun:'อา.',
    wd_full_mon:'วันจันทร์', wd_full_tue:'วันอังคาร', wd_full_wed:'วันพุธ', wd_full_thu:'วันพฤหัสบดี',
    wd_full_fri:'วันศุกร์', wd_full_sat:'วันเสาร์', wd_full_sun:'วันอาทิตย์',
    cal_mode_week:'สัปดาห์', cal_mode_month:'เดือน',
    cal_prev_week_aria:'สัปดาห์ก่อนหน้า', cal_next_week_aria:'สัปดาห์ถัดไป',
    cal_prev_month_aria:'เดือนก่อนหน้า', cal_next_month_aria:'เดือนถัดไป',
    session_singular:'เซสชัน', session_plural:'เซสชัน',
    booking_word:'การจอง', no_client_option:'ไม่มีลูกค้า',
    cal_gap_free_word:'ว่าง', cal_gap_add_word:'+ เพิ่ม',
    cal_nothing_on:'ไม่มีนัดหมายวันที่ {date}', cal_tap_new_session_hint:'แตะ “+ เซสชันใหม่” ด้านบนเพื่อบันทึกงาน',
    cal_schedule_booking_link:'+ กำหนดการจอง', cal_new_session_btn:'+ เซสชันใหม่',
    cal_tap_day_hint:'แตะวันที่เพื่อดูรายละเอียด', bookings_load_error:'ไม่สามารถโหลดการจองได้',
    pipeline_section_label:'แผนงาน', bookings_section_label:'การจอง',
    cal_overlap_msg:'ทับซ้อนกัน {n} นาที{suffix}', cal_overlap_buffer_msg:'ทับซ้อนกัน {n} นาที{suffix} — ต้องการเวลาเผื่อ {buf} นาที',
    cal_short_gap_msg:'เหลือเพียง {n} นาที{suffix} — ต้องการ {buf} นาที', cal_free_gap_msg:'ว่าง {n} นาที{suffix}',
    cal_before_ref:'ก่อน {ref}', cal_tomorrows_booking_ref:'“{title}” ของพรุ่งนี้',
    new_booking_title:'จองใหม่', edit_booking_title:'แก้ไขการจอง', booking_form_aria:'แบบฟอร์มการจอง',
    field_title:'ชื่อ', bk_title_ph:'เช่น ถ่ายภาพพอร์ตเทรต',
    when_header:'เวลานัดหมาย', start_time_label:'เวลาเริ่ม', duration_min_label:'ระยะเวลา (นาที)',
    travel_buffer_label:'เวลาเผื่อเดินทางหลังจบงาน (นาที)', details_header:'รายละเอียด',
    location_label:'สถานที่', location_ph:'ที่อยู่หรือสถานที่ (ไม่บังคับ)', status_label:'สถานะ',
    repeat_header:'ทำซ้ำ', repeat_none_option:'ไม่ทำซ้ำ', repeat_weekly_option:'ทุกสัปดาห์',
    repeat_biweekly_option:'ทุก 2 สัปดาห์', repeat_until_label:'ทำซ้ำจนถึง',
    save_changes_btn:'บันทึกการเปลี่ยนแปลง', create_booking_btn:'สร้างการจอง', delete_booking_btn:'ลบการจอง',
    status_scheduled:'กำหนดการแล้ว', status_done:'เสร็จสิ้น', status_cancelled:'ยกเลิกแล้ว',
    booking_not_found:'ไม่พบการจองนี้', booking_updated:'อัปเดตการจองแล้ว', booking_created:'สร้างการจองแล้ว',
    booking_created_series:'สร้างการจองแล้ว (+{n} รายการในชุดเดียวกัน)', booking_save_failed:'ไม่สามารถบันทึกการจองได้',
    err_pick_date:'กรุณาเลือกวันที่', err_pick_start_time:'กรุณาเลือกเวลาเริ่ม', err_enter_booking_title:'กรุณากรอกชื่อสำหรับการจองนี้',
    err_duration_min:'ระยะเวลาต้องอย่างน้อย 1 นาที', err_repeat_end_date:'กรุณาเลือกวันสิ้นสุดการทำซ้ำ',
    err_repeat_end_after:'วันสิ้นสุดการทำซ้ำต้องอยู่หลังวันที่จอง',
    delete_booking_confirm:'ลบการจองนี้หรือไม่? ไม่สามารถย้อนกลับได้', booking_deleted:'ลบการจองแล้ว',
    // M2 — invoices (list / form / detail / print / payment channels) — full i18n pass
    inv_status_paid:'ชำระแล้ว', inv_status_overdue:'เกินกำหนด', inv_status_sent:'ส่งแล้ว', inv_status_draft:'ร่าง',
    tawi_cert_title:'หนังสือรับรองหัก ณ ที่จ่าย (50 ทวิ)', tawi_received:'ได้รับแล้ว',
    tawi_missing_template:'ยังไม่ได้รับ · ค้างอยู่ {n} {unit}',
    mark_missing_btn:'ทำเครื่องหมายว่ายังไม่ได้รับ', mark_received_btn:'ทำเครื่องหมายว่าได้รับแล้ว',
    new_invoice_btn:'+ ใบแจ้งหนี้ใหม่', no_invoices:'ยังไม่มีใบแจ้งหนี้',
    no_invoices_sub:'สร้างใบแจ้งหนี้ใบแรก — เพิ่มรายการ คำนวณภาษี และแชร์ QR พร้อมเพย์ให้ลูกค้า',
    inv_outstanding_label:'ค้างชำระ', liquid_revenue_label:'รายได้สุทธิที่รับแล้ว', wht_tax_credits_label:'เครดิตภาษีหัก ณ ที่จ่าย',
    new_invoice_title:'ใบแจ้งหนี้ใหม่', edit_invoice_title:'แก้ไขใบแจ้งหนี้', invoice_form_aria:'แบบฟอร์มใบแจ้งหนี้',
    free_text_option:'— กรอกข้อความเอง —', add_line_from_service_option:'+ เพิ่มรายการจากบริการ…',
    pick_client_label:'เลือกลูกค้า', bill_to_name_label:'เรียกเก็บเงินจาก (ชื่อ)', client_company_name_ph:'ชื่อลูกค้าหรือบริษัท',
    dates_status_header:'วันที่และสถานะ', issue_date_label:'วันที่ออกใบแจ้งหนี้', due_date_label:'วันครบกำหนด',
    line_items_header:'รายการ', add_from_service_label:'เพิ่มจากบริการ', add_blank_line_btn:'+ เพิ่มรายการว่าง',
    tax_deposit_header:'ภาษีและเงินมัดจำ', wht_pct_label:'ภาษีหัก ณ ที่จ่าย %', deposit_pct_label:'เงินมัดจำ % (จ่ายล่วงหน้า ไม่บังคับ)',
    invoice_notes_label:'หมายเหตุ (แสดงบนใบแจ้งหนี้)', create_invoice_btn:'สร้างใบแจ้งหนี้', delete_invoice_btn:'ลบใบแจ้งหนี้',
    description_ph:'รายละเอียด', remove_line_aria:'ลบรายการนี้', qty_label:'จำนวน', quantity_aria:'จำนวน',
    rate_label:'ราคาต่อหน่วย', unit_price_aria:'ราคาต่อหน่วย',
    subtotal_label:'ยอดรวมก่อนภาษี', vat_pct_row:'ภาษีมูลค่าเพิ่ม ({pct}%)', wht_pct_row:'ภาษีหัก ณ ที่จ่าย ({pct}%)',
    client_pays_label:'ลูกค้าชำระ', you_receive_label:'คุณได้รับ', deposit_pct_row:'เงินมัดจำ ({pct}%)',
    err_enter_billed_to:'กรุณากรอกชื่อผู้รับใบแจ้งหนี้', err_add_line_item:'กรุณาเพิ่มรายการอย่างน้อยหนึ่งรายการ',
    err_invoice_total_zero:'ยอดรวมใบแจ้งหนี้ต้องมากกว่าศูนย์',
    invoice_updated:'อัปเดตใบแจ้งหนี้แล้ว', invoice_created_with_number:'สร้างใบแจ้งหนี้ {number} แล้ว', invoice_save_failed:'ไม่สามารถบันทึกใบแจ้งหนี้ได้',
    delete_invoice_confirm:'ลบใบแจ้งหนี้นี้หรือไม่? ไม่สามารถย้อนกลับได้', invoice_deleted:'ลบใบแจ้งหนี้แล้ว',
    invoice_not_found:'ไม่พบใบแจ้งหนี้นี้', invoice_detail_aria:'รายละเอียดใบแจ้งหนี้', invoice_word:'ใบแจ้งหนี้',
    tax_id_prefix:'เลขประจำตัวผู้เสียภาษี: ', issued_label:'ออกเมื่อ', due_label:'ครบกำหนด',
    edit_btn:'แก้ไข', print_pdf_btn:'พิมพ์ / PDF', change_status_label:'เปลี่ยนสถานะ', close_btn:'ปิด',
    add_payment_channel_hint:'เพิ่มช่องทางชำระเงิน (พร้อมเพย์ โอนผ่านธนาคาร ฯลฯ) ใน <b>เพิ่มเติม → ตั้งค่า</b> เพื่อให้ลูกค้าทราบวิธีชำระเงิน',
    scan_promptpay_label:'สแกนด้วยแอปธนาคารไทยได้ทุกแอป', promptpay_label:'พร้อมเพย์', payment_word:'การชำระเงิน',
    bill_to_label:'เรียกเก็บเงินจาก', amount_header:'จำนวนเงิน', status_toast_prefix:'สถานะ: ',
    service_word:'บริการ', qr_unavailable:'ไม่สามารถแสดง QR ได้',
    // misc
    welcome:'ยินดีต้อนรับ', welcome_back:'ยินดีต้อนรับกลับมา', guest_name:'ผู้เยี่ยมชม', logged_out:'ออกจากระบบแล้ว',
    greeting_morning:'สวัสดีตอนเช้า', greeting_afternoon:'สวัสดีตอนบ่าย', greeting_evening:'สวัสดีตอนเย็น',
    cancel:'ยกเลิก', saved:'บันทึกแล้ว', deleted:'ลบแล้ว', job_saved:'บันทึกเซสชันแล้ว', job_deleted:'ลบเซสชันแล้ว',
    exported:'ส่งออกแล้ว', restore_confirm:'กู้คืนข้อมูลสำรองนี้หรือไม่? การทำเช่นนี้จะแทนที่เซสชันและค่าใช้จ่าย {n} รายการปัจจุบันของบัญชีนี้ทั้งหมด และไม่สามารถย้อนกลับได้',
    restore_done:'กู้คืนข้อมูลแล้ว {n} รายการ', restore_bad_file:'ไฟล์นี้ไม่ใช่ไฟล์สำรองข้อมูลของ Sidekick ที่ถูกต้อง',
    restore_failed:'กู้คืนข้อมูลไม่สำเร็จ — ข้อมูลเดิมของคุณยังคงอยู่',
    backup_reminder_title:'สำรองข้อมูลของคุณ', backup_reminder_sub:'ข้อมูลทั้งหมดเก็บอยู่ในเครื่องนี้เท่านั้น สำรองข้อมูลล่าสุด: {date}',
    backup_now:'สำรองข้อมูลตอนนี้', remind_later:'เตือนภายหลัง', backup_snoozed:'เลื่อนการแจ้งเตือนออกไป 2 สัปดาห์', backup_never:'ไม่เคย',
    cloud_backup_title:'สำรองข้อมูลบนคลาวด์ (ทดลอง)', cloud_backup_disabled_sub:'ข้อมูลลูกค้าของคุณอยู่ในเครื่องนี้เท่านั้น เปิดใช้งานเพื่อเก็บสำเนาไว้ในบัญชีของคุณด้วย',
    cloud_backup_enabled_sub:'ข้อมูลลูกค้าของคุณสำรองไว้ในบัญชีแล้ว', cloud_backup_enable_btn:'เปิดใช้งานสำรองข้อมูลบนคลาวด์',
    cloud_backup_reenter_password:'กรอกรหัสผ่านของคุณเพื่อเปิดใช้งานสำรองข้อมูลบนคลาวด์:',
    cloud_backup_failed:'ไม่สามารถเปิดใช้งานสำรองข้อมูลบนคลาวด์ได้ — ลองใหม่อีกครั้ง',
    cloud_backup_upload_failed:'เปิดใช้งานแล้ว แต่การสำรองข้อมูลครั้งแรกล้มเหลว — ระบบจะลองใหม่เมื่อคุณบันทึกข้อมูลลูกค้าครั้งถัดไป',
    cloud_backup_enabled_toast:'เปิดใช้งานสำรองข้อมูลบนคลาวด์แล้ว — สำรองข้อมูลลูกค้า {n} รายการ',
    cloud_backup_modal_body:'ตอนนี้ข้อมูลลูกค้าของคุณอยู่ในเครื่องนี้เท่านั้น — หากเครื่องหายหรือถูกรีเซ็ต ข้อมูลจะหายไปด้วย เปิดใช้งานสำรองข้อมูลบนคลาวด์เพื่อเก็บสำเนาไว้ในบัญชีของคุณด้วย คุณสามารถทำภายหลังได้จากหน้าตั้งค่า',
    cloud_backup_later_btn:'ไว้ทีหลัง',
    subscription_needs_account_hint:'เปิดใช้งานสำรองข้อมูลบนคลาวด์ด้านบนเพื่อเริ่มทดลองใช้ฟรี 15 วันและจัดการการเรียกเก็บเงิน',
    subscription_plan_basic:'แพ็กเกจ Basic', subscription_plan_pro:'แพ็กเกจ Pro', subscription_plan_team:'แพ็กเกจ Team',
    subscription_status_trialing:'ทดลองใช้ฟรี — เหลืออีก {n} วัน', subscription_status_active:'ใช้งานอยู่',
    subscription_status_past_due:'ชำระเงินไม่สำเร็จ — อัปเดตบัตรของคุณเพื่อใช้งานต่อ', subscription_status_canceled:'ยกเลิกแล้ว',
    subscription_status_locked:'หมดระยะทดลองใช้',
    subscription_locked_banner:'ระยะทดลองใช้ของคุณสิ้นสุดแล้ว ข้อมูลของคุณยังปลอดภัยและดูได้ แต่คุณต้องสมัครสมาชิกเพื่อเพิ่มหรือแก้ไขข้อมูล',
    subscription_upgrade_pro_btn:'อัปเกรดเป็น Pro — ฿{price}/เดือน', subscription_subscribe_basic_btn:'สมัคร Basic — ฿{price}/เดือน',
    subscription_manage_billing_btn:'จัดการการเรียกเก็บเงิน', subscription_checkout_failed:'ไม่สามารถเริ่มการชำระเงินได้ — ลองใหม่อีกครั้ง',
    subscription_portal_failed:'ไม่สามารถเปิดหน้าจัดการการเรียกเก็บเงินได้ — ลองใหม่อีกครั้ง',
    client_cap_reached:'คุณถึงขีดจำกัดจำนวนลูกค้าของแพ็กเกจแล้ว — อัปเกรดที่การตั้งค่า > การสมัครสมาชิก เพื่อเพิ่มลูกค้า',
    recurring_locked:'การจองซ้ำต้องสมัครแพ็กเกจ Pro — อัปเกรดที่การตั้งค่า > การสมัครสมาชิก',
    research_premium_plan_note:'บทความ Premium ยังรวมอยู่ในแพ็กเกจ Pro โดยไม่มีค่าใช้จ่ายเพิ่มเติม',
    business_logo:'โลโก้ธุรกิจ', doc_branding_locked:'เพิ่มโลโก้ในใบเสนอราคา/ใบแจ้งหนี้/ใบเสร็จได้ด้วยแพ็กเกจ Pro',
    remove_logo_btn:'ลบโลโก้', image_too_large:'ไฟล์ภาพใหญ่เกินไป — กรุณาเลือกไฟล์ที่มีขนาดไม่เกิน 2MB', image_read_failed:'ไม่สามารถอ่านไฟล์ภาพนี้ได้',
    delete_job_confirm:'ลบเซสชันนี้หรือไม่?', name_saved:'บันทึกชื่อแล้ว',
    err_id_min3:'กรอกอีเมลหรือชื่อผู้ใช้ (อย่างน้อย 3 ตัวอักษร)', err_pw_min4:'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร',
    err_pw_mismatch:'รหัสผ่านไม่ตรงกัน', err_account_exists:'มีบัญชีนี้อยู่แล้วในเครื่องนี้',
    err_no_account:'ไม่พบบัญชีที่ใช้อีเมลนี้ในเครื่องนี้', err_incorrect_pw:'รหัสผ่านไม่ถูกต้อง',
    manage_docs_row:'เอกสาร', more_tools_title:'เครื่องมือเพิ่มเติม',
    followups_row_title:'ติดตามลูกค้า', portfolio_row_title:'ผลงาน', research_row_title:'คลังความรู้',
    page_size_label:'ขนาดหน้าเอกสาร', notifications_label:'การแจ้งเตือน',
    notifications_sub:'ใบแจ้งหนี้ที่เกินกำหนด การนัดหมายที่ใกล้ถึง และงานที่ค้างในไปป์ไลน์ — แจ้งเตือนเฉพาะขณะเปิดแอปหรือเพิ่งใช้งานล่าสุดเท่านั้น',
    payment_channels_title:'ช่องทางการชำระเงิน',
    payment_channels_sub:'เพิ่มพร้อมเพย์ โอนผ่านธนาคาร เงินสด หรือช่องทางอื่นให้ลูกค้าทราบวิธีชำระเงิน พร้อมเพย์จะแสดง QR ให้สแกนบนใบแจ้งหนี้ ส่วนช่องทางอื่นแสดงเป็นข้อความอ้างอิง',
    add_payment_channel:'+ เพิ่มช่องทางชำระเงิน', export_invoices_csv:'ส่งออกใบแจ้งหนี้เป็น CSV', export_pnd_summary:'ส่งออกสรุป ภ.ง.ด. เป็น CSV',
    no_payment_channels:'ยังไม่มีช่องทางชำระเงิน', no_payment_channels_sub:'เพิ่มพร้อมเพย์ โอนผ่านธนาคาร เงินสด หรือช่องทางอื่นให้ลูกค้าทราบวิธีชำระเงิน',
    business_name_ph:'ค่าเริ่มต้นตามชื่อบัญชีของคุณ',
    // M1.5 — customers
    manage:'จัดการ', customers_title:'ลูกค้า', add_customer:'เพิ่มลูกค้า', edit_customer:'แก้ไขลูกค้า',
    save_customer:'บันทึกลูกค้า', delete_customer:'ลบลูกค้า', delete_customer_confirm:'ลบลูกค้ารายนี้หรือไม่?',
    no_customers:'ยังไม่มีลูกค้า', no_customers_sub:'เพิ่มลูกค้ารายแรกเพื่อใช้ข้อมูลซ้ำได้',
    needs_attention_title:'ต้องดำเนินการ', all_clients_title:'ลูกค้าทั้งหมด', remind_action:'เตือน', offer_renewal_action:'เสนอต่ออายุ',
    customer_saved:'บันทึกลูกค้าแล้ว', customer_deleted:'ลบลูกค้าแล้ว',
    field_name:'ชื่อ', field_phone:'เบอร์โทร', field_email:'อีเมล', field_tags:'แท็ก (คั่นด้วยจุลภาค)',
    field_taxid:'เลขประจำตัวผู้เสียภาษี', field_billing:'ที่อยู่สำหรับเรียกเก็บเงิน', field_member_no:'รหัสสมาชิก',
    field_health:'บันทึกสุขภาพ', field_allergies:'อาการแพ้', field_goals:'เป้าหมาย',
    assigned_on_save:'(กำหนดให้เมื่อบันทึก)',
    err_name_required:'กรุณากรอกชื่อ',
    err_select_client:'กรุณาเลือกลูกค้า',
    // M1.5 — services
    services_title:'บริการ', add_service:'เพิ่มบริการ', edit_service:'แก้ไขบริการ', save_service:'บันทึกบริการ',
    delete_service:'ลบบริการ', delete_service_confirm:'ลบบริการนี้หรือไม่?',
    no_services:'ยังไม่มีบริการ', no_services_sub:'เพิ่มบริการเพื่อกรอกค่าธรรมเนียมล่วงหน้าเมื่อบันทึกงาน',
    service_saved:'บันทึกบริการแล้ว', service_deleted:'ลบบริการแล้ว',
    field_rate:'ราคาแพ็กเกจ', field_unit:'หน่วย', field_unit_ph:'เช่น เซสชัน, ชั่วโมง, โปรเจกต์',
    field_usage_qty:'จำนวนการใช้งานต่อครั้ง', add_new_service_option:'+ เพิ่มบริการใหม่',
    // M1.5 — job form links
    field_customer:'ลูกค้า', field_service:'บริการ', none_option:'— ไม่มี —',
    add_new_client_option:'+ เพิ่มลูกค้าใหม่…',
    export_customers_csv:'ส่งออกลูกค้าเป็น CSV',
    nav_customers:'ลูกค้า',
    // Usage insights
    insights_title:'ข้อมูลเชิงลึก', no_insights:'ยังไม่มีกิจกรรม', no_insights_sub:'ข้อมูลเชิงลึกจะสะสมเมื่อคุณใช้งานแอป — ไม่มีการส่งข้อมูลออกไปที่ใด เก็บอยู่ในเครื่องนี้เท่านั้น',
    insights_sessions_logged:'เซสชันที่บันทึก', insights_clients_added:'ลูกค้าที่เพิ่ม', insights_active_days_30:'วันที่ใช้งาน (30 วัน)',
    insights_feature_usage:'การใช้งานฟีเจอร์', insights_pipeline_activity:'กิจกรรมแผนงาน', insights_no_pipeline_activity:'ยังไม่มีกิจกรรมแผนงาน',
    insights_stage_done:'เสร็จสมบูรณ์', insights_clear:'ล้างข้อมูลการใช้งาน', insights_clear_confirm:'ล้างข้อมูลการใช้งานทั้งหมดในเครื่องหรือไม่? ไม่สามารถย้อนกลับได้',
    insights_cleared:'ล้างข้อมูลการใช้งานแล้ว', insights_unlocked:'ปลดล็อกข้อมูลเชิงลึกแล้ว',
  },
};
function curLang() { return (settings && settings.lang) || localStorage.getItem('sidekick_ui_lang') || 'th'; }
function t(key) {
  const l = curLang();
  return (I18N[l] && I18N[l][key]) ?? I18N.en[key] ?? key;
}
function greetingPeriod() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : (h < 18 ? 'afternoon' : 'evening');
}

// ─── DATES / MONEY ────────────────────────────────────────────────────
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmt(n, dec=0) { return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec}); }
function money(n, dec=0) { return curSym() + fmt(n, dec); }
function netOf(j) { return (Number(j.amount)||0) + (Number(j.tip)||0) - (Number(j.expense)||0); }

// ─── THEME ────────────────────────────────────────────────────────────
// Light by default (reverses the 2026 rebrand's "dark by default" decision
// on explicit user instruction). Stored value is one of 'light' | 'dark' |
// 'auto', in localStorage (not the per-uid `settings` DB object) so the
// pre-paint inline script in index.html/login.html can read it
// synchronously, before IndexedDB is even open, to avoid a flash of the
// wrong theme.
//   'light' -> dataset.theme = 'light'  (forces light, overrides OS)
//   'dark'  -> dataset.theme = 'dark'   (forces dark, overrides OS)
//   'auto'  -> dataset.theme removed    (styles.css's prefers-color-scheme
//              media query decides, tracking the OS live)
const THEME_KEY = 'sidekick_ui_theme';
function applyTheme() {
  const stored = localStorage.getItem(THEME_KEY) || 'light';
  if (stored === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = (stored === 'dark') ? 'dark' : 'light';
}
async function onThemeChange(v) {
  localStorage.setItem(THEME_KEY, (v === 'dark' || v === 'auto') ? v : 'light');
  applyTheme();
}

// ─── BOOT ─────────────────────────────────────────────────────────────
function showPostLoginToast() {
  const msg = sessionStorage.getItem('sidekick_post_login_toast');
  if (msg) { sessionStorage.removeItem('sidekick_post_login_toast'); toast(msg); }
}
// login.html entry — already-authed devices skip to the app.
async function bootLogin() {
  applyTheme();
  await openDB();
  await migrateLegacyStorageIfNeeded();
  // Runs before handleLineLoginRedirect() (not after, as `showPostLoginToast()`
  // below implies) so the s-line-profile screen it can show is already
  // localized — that early-return path never reaches the applyLang() call
  // that used to sit down here.
  applyLang();
  if (await handleLineLoginRedirect()) return;
  if (await restoreSession()) { location.replace('./'); return; }
  showPostLoginToast();
}
// index.html entry — no session → bounce to login.
async function bootApp() {
  applyTheme();
  { const v = document.getElementById('app-version'); if (v) v.textContent = APP_VERSION; }
  await openDB();
  await migrateLegacyStorageIfNeeded();
  if (!(await restoreSession())) { location.replace('login.html'); return; }
  await enterApp();
  showPostLoginToast();
}
function boot() {
  const page = document.body.dataset.page;
  const run = page === 'login' ? bootLogin : bootApp;
  Promise.resolve().then(run).catch(err => {
    console.error('boot failed', err);
    const msg = (err && err.message ? String(err.message) : 'storage error').replace(/[<>]/g, '');
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="padding:24px;max-width:34rem;margin:0 auto;font:15px/1.5 system-ui;color:#1A2421">' +
      '<b>Couldn’t start Sidekick.</b><br>' + msg +
      '<br><br>Close any other Sidekick tabs and reload.</div>');
  });
}

async function enterApp() {
  document.body.classList.add('authed');
  settings = {lang:'th', currency:'THB'};
  const sAll = await dbAll('settings');
  const prefix = isGuest ? 'guest:' : (currentUser.id + ':');
  sAll.forEach(s => { if (s.key.startsWith(prefix)) settings[s.key.slice(prefix.length)] = s.value; });

  await reload();
  applyUser();
  applyLang();
  // reflect settings into controls
  // Tax defaults: TH standard WHT 3% / VAT 7% when the user has not set them.
  // In-memory only (persisted on first change) so M2 tax/invoices can read them.
  if (settings.wht == null) settings.wht = 3;
  if (settings.vat == null) settings.vat = 7;
  const set = (id, v) => { const el = document.getElementById(id); if (el != null && v != null) el.value = v; };
  set('set-theme', localStorage.getItem(THEME_KEY) || 'light');
  set('set-lang', settings.lang || 'th');
  set('set-currency', settings.currency || 'THB');
  set('set-page-size', settings.docPageSize || 'A4');
  set('set-wht', settings.wht != null ? settings.wht : '');
  set('set-vat', settings.vat != null ? settings.vat : '');
  set('set-seller-name', settings.sellerBusinessName || '');
  set('set-seller-taxid', settings.sellerTaxId || '');
  set('set-seller-address', settings.sellerAddress || '');
  const notifCheckbox = document.getElementById('set-notifications');
  if (notifCheckbox) notifCheckbox.checked = !!(settings.notificationsEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted');

  // One-time migration: the old single "PromptPay ID" field becomes the
  // first entry in the new payment-channels list, if it was ever set.
  if (!Array.isArray(settings.paymentChannels)) {
    const migrated = settings.promptpayId
      ? [{ id: cuid(), type: 'promptpay', label: 'PromptPay', detail: settings.promptpayId }]
      : [];
    await saveSetting('paymentChannels', migrated);
  }
  renderPaymentChannels();

  // One-time migration: My Task Goal replaces the old single daily-income
  // goal with Month/Quarter/Year targets. A daily figure doesn't map to a
  // period target directly, so this seeds reasonable month/quarter/year
  // figures from it (30x/90x/365x) rather than silently losing the old
  // setting; leaves all three at 0 (goal card stays hidden, same as before)
  // if no daily goal was ever set.
  if (!settings.goalTargets) {
    const monthGuess = (Number(settings.dailyGoal) || 0) * 30;
    await saveSetting('goalTargets', { month: monthGuess, quarter: monthGuess * 3, year: monthGuess * 12 });
  }
  if (!settings.goalPeriod) await saveSetting('goalPeriod', 'month');
  set('set-goal-month', settings.goalTargets.month || '');
  set('set-goal-quarter', settings.goalTargets.quarter || '');
  set('set-goal-year', settings.goalTargets.year || '');

  // Business type (persona) picker — reintroduced per the 2026 redesign
  // handoff. Migrates existing installs to 'trainer' (this app's actual base
  // case up to now, back when it was single-persona-only) so switching over
  // changes nothing for anyone not deliberately picking a different type.
  // Business type (persona) picker — reintroduced per the 2026 redesign
  // handoff, now asked once at first run via a blocking modal instead of
  // silently defaulting to 'trainer'. Existing installs already have
  // `businessType` set from the earlier silent-default migration, so this
  // only ever gates a genuinely new account/device — nobody already using
  // the app sees it appear. enterApp() returns early here; finishAppBoot()
  // (below) picks up once a choice is made, in showPersonaOnboard()'s
  // choosePersonaOnboard() handler.
  if (!settings.businessType) { showPersonaOnboard(); return; }
  document.body.setAttribute('data-work-type', businessType());
  set('set-business-type', businessType());
  if (!settings.packageUnitLabel) await saveSetting('packageUnitLabel', PACKAGE_UNIT_DEFAULTS[businessType()] || 'Units');
  set('set-package-unit', packageUnitLabel());
  await finishAppBoot();
}

// The rest of boot, once businessType is known — split out of enterApp()
// so the first-run persona picker can pause boot after loading settings/
// applying theme+lang, then resume here once a choice is made.
async function finishAppBoot() {
  // One-time migration: the client-facing ID format changes from "M-xxxx"
  // to "SK-xxxx" per the 2026 redesign spec. Rewrites existing records in
  // place (preserving the numeric sequence) rather than leaving old and new
  // clients on two different-looking ID formats forever.
  if (!settings.memberNoSkMigrated) {
    for (const c of customers) {
      if (typeof c.memberNo === 'string' && c.memberNo.indexOf('M-') === 0) {
        c.memberNo = 'SK-' + c.memberNo.slice(2);
        await dbPut('clients', c);
      }
    }
    await saveSetting('memberNoSkMigrated', true);
  }
  await seedServicesIfEmpty();
  switchScreen('home');
  await maybeShowCloudBackupModal();
  // Fire-and-forget: populates __entitlements for the Phase 1 feature
  // gates (planHasFeature()/planClientCap()) without delaying boot on a
  // network round trip guest/local-only accounts don't even need.
  refreshEntitlements();

  // App-triggered OS notifications: only fire while this tab stays open (no
  // backend to check conditions while fully closed — see the comment above
  // computeNotificationConditions()). reload() (already called above) fires
  // the first check; this just re-checks every minute after that, mainly for
  // the time-sensitive "booking starting soon" condition.
  setInterval(checkAndFireNotifications, 60000);
}

// First-run persona picker (index.html's #modal-persona-onboard). Shown
// exactly once, only when settings.businessType has never been set —
// deliberately not dismissible (enterApp() already returned without calling
// finishAppBoot() above, so nothing else runs until a choice is made here).
function showPersonaOnboard() {
  const m = document.getElementById('modal-persona-onboard');
  if (m) m.classList.add('open');
}
async function choosePersonaOnboard(v) {
  if (!BUSINESS_TYPES[v]) return;
  const m = document.getElementById('modal-persona-onboard');
  if (m) m.classList.remove('open');
  await saveSetting('businessType', v);
  await saveSetting('packageUnitLabel', PACKAGE_UNIT_DEFAULTS[v] || 'Units');
  document.body.setAttribute('data-work-type', v);
  const btEl = document.getElementById('set-business-type'); if (btEl) btEl.value = v;
  const puEl = document.getElementById('set-package-unit'); if (puEl) puEl.value = packageUnitLabel();
  await finishAppBoot();
}

function displayName() {
  if (isGuest) return t('guest_name');
  return (currentUser && currentUser.firstName) ? currentUser.firstName : (currentUser ? currentUser.username : '');
}
// The name printed on documents (quotes/invoices/receipts/contracts/NDAs) as
// the seller — an optional Settings override, falling back to the casual
// display name so documents work fine even if it's never filled in.
function sellerBusinessName() {
  return (settings.sellerBusinessName || '').trim() || displayName();
}
function applyUser() {
  const name = displayName();
  const initial = (name || '?').charAt(0).toUpperCase();
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('home-avatar', initial);
  setTxt('acct-avatar', initial);
  setTxt('acct-name', name + (isGuest ? ' · guest' : ''));
  setTxt('acct-sub', isGuest ? 'Temporary guest — data on this device only' : t('local_account'));
  const logoutBtn = document.querySelector('.btn-logout');
  if (logoutBtn) logoutBtn.textContent = isGuest ? t('exit_guest') : t('logout');
  // Guest has no stored name to edit (displayName() is a fixed translation,
  // not a users-store field) — hide the affordance rather than open a modal
  // that has nothing real to save.
  const chevron = document.getElementById('acct-edit-chevron');
  if (chevron) chevron.style.display = isGuest ? 'none' : '';
}

function openAccountNameModal() {
  if (isGuest || !currentUser) return;
  document.getElementById('acct-name-input').value = currentUser.firstName || '';
  document.getElementById('modal-account-name').classList.add('open');
}
function closeAccountNameModal() { document.getElementById('modal-account-name').classList.remove('open'); }
async function saveAccountName() {
  const name = document.getElementById('acct-name-input').value.trim();
  if (!name) { markFieldError('acct-name-input', 'err_name_required'); return; }
  // Fetch the full stored row rather than mutating a slim in-memory copy —
  // dbPut() is a keyPath put() that replaces the entire record (see the
  // same fix in completeLineProfile()), so it must carry every field.
  const row = await dbGet('users', currentUser.id);
  if (row) { row.firstName = name; await dbPut('users', row); }
  currentUser.firstName = name;
  closeAccountNameModal();
  applyUser();
  toast(t('saved'));
}

async function reload() {
  const uid = isGuest ? 'guest' : currentUser.id;
  jobs = (await dbAll('jobs')).filter(j => j.uid === uid);
  jobs.sort((a,b) => (b.date||'').localeCompare(a.date||'') || ((b.id||0)-(a.id||0)));
  expenses = (await dbAll('expenses')).filter(x => x.uid === uid);
  customers = (await dbAll('clients')).filter(c => c.uid === uid);
  await backfillMemberNumbers();
  customers.sort((a,b) => (a.name||'').localeCompare(b.name||''));
  services = (await dbAll('services')).filter(s => s.uid === uid);
  services.sort((a,b) => (a.name||'').localeCompare(b.name||''));
  usageEvents = (await dbAll('usageEvents')).filter(e => e.uid === uid);
  packages = (await dbAll('packages')).filter(p => p.uid === uid);
  renderHome();
  renderCustomers();
  renderServices();
  if (typeof renderPipeline === 'function') renderPipeline();
  renderInsights();
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('set-count', jobs.length);
  checkAndFireNotifications();
}
// ─── USAGE INSIGHTS (local-only — never leaves this device) ───────────
// A lightweight event log so the app owner can see which features get reached
// for, to guide what's worth building next. Collection always runs (it's the
// whole point), but the Settings > Insights screen itself is developer-only —
// hidden from the normal Manage list so ordinary end users never see or land
// on it. No network calls, no third-party analytics.
function logEvent(name) {
  if (!db) return;
  const uid = isGuest ? 'guest' : currentUser.id;
  const row = {uid, name, ts: nowISO()};
  dbAdd('usageEvents', row).then(id => { row.id = id; usageEvents.push(row); }).catch(()=>{});
}
// Reveal Insights the same way Android reveals Developer Options: tap the
// version number 7 times. Unlocking is a one-time, permanent, per-device flag.
const INSIGHTS_UNLOCK_TAPS = 7;
let _versionTapCount = 0;
let _versionTapTimer = null;
function tapVersion() {
  if (settings.insightsUnlocked) return;
  _versionTapCount++;
  clearTimeout(_versionTapTimer);
  _versionTapTimer = setTimeout(() => { _versionTapCount = 0; }, 2000);
  if (_versionTapCount >= INSIGHTS_UNLOCK_TAPS) {
    _versionTapCount = 0;
    unlockInsights();
  }
}
async function unlockInsights() {
  await saveSetting('insightsUnlocked', true);
  applyInsightsVisibility();
  toast(t('insights_unlocked'));
}
function applyInsightsVisibility() {
  const row = document.getElementById('insights-row');
  if (row) row.style.display = settings.insightsUnlocked ? 'flex' : 'none';
}
const SCREEN_LABELS = {
  home:'Home', pipeline:'Task flow', customers:'Clients', book:'Calendar', more:'Settings',
  services:'Services', invoices:'Invoices', tax:'Tax', docs:'Documents',
  followups:'Follow-ups', portfolio:'Portfolio', research:'Research', insights:'Insights',
};
function daysAgoISO(days) { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString(); }
function renderInsights() {
  const wrap = document.getElementById('insights-body');
  if (!wrap) return;
  if (!usageEvents.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-icon">📊</div>
      <p>${htmlEsc(t('no_insights'))}</p><span>${htmlEsc(t('no_insights_sub'))}</span></div>`;
    return;
  }
  const since30 = daysAgoISO(30);
  const last30 = usageEvents.filter(e => e.ts >= since30);
  const sessionsLogged = usageEvents.filter(e => e.name === 'session_logged').length;
  const clientsAdded = usageEvents.filter(e => e.name === 'client_added').length;
  const activeDays30 = new Set(last30.map(e => e.ts.slice(0,10))).size;

  const screenCounts = {};
  usageEvents.forEach(e => {
    if (e.name.startsWith('screen_view:')) {
      const s = e.name.slice('screen_view:'.length);
      screenCounts[s] = (screenCounts[s]||0) + 1;
    }
  });
  const topScreens = Object.entries(screenCounts).sort((a,b) => b[1]-a[1]);

  const stageCounts = {};
  usageEvents.forEach(e => {
    if (e.name.startsWith('pipeline_stage:')) {
      const s = e.name.slice('pipeline_stage:'.length);
      stageCounts[s] = (stageCounts[s]||0) + 1;
    }
  });
  const stageOrderForDisplay = (typeof getStageOrder === 'function') ? getStageOrder().concat(['extended', 'finished', 'done']) : Object.keys(stageCounts);
  const STAGE_DISPLAY_LABELS = { done: t('insights_stage_done'), extended: STAGE_META.extend && t(STAGE_META.extend.done), finished: t('mark_finished') };
  const stageRows = stageOrderForDisplay.filter(s => stageCounts[s]).map(s => {
    const label = STAGE_DISPLAY_LABELS[s] || (STAGE_META[s] && t(STAGE_META[s].label)) || s;
    return {label, count: stageCounts[s]};
  });

  wrap.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">${htmlEsc(t('insights_sessions_logged'))}</div><div class="stat-val tnum">${sessionsLogged}</div></div>
      <div class="stat-card"><div class="stat-label">${htmlEsc(t('insights_clients_added'))}</div><div class="stat-val tnum">${clientsAdded}</div></div>
      <div class="stat-card"><div class="stat-label">${htmlEsc(t('insights_active_days_30'))}</div><div class="stat-val tnum">${activeDays30}</div></div>
    </div>
    <div class="section-title">${htmlEsc(t('insights_feature_usage'))}</div>
    <div class="list-card">${topScreens.length ? topScreens.map(([s,n]) => `
      <div class="list-row" style="cursor:default">
        <div class="list-main"><div class="list-title">${htmlEsc(SCREEN_LABELS[s] || s)}</div></div>
        <div class="list-right"><span class="list-amt">${n}</span></div>
      </div>`).join('') : `<div class="list-row" style="cursor:default"><div class="list-main"><div class="list-sub">${htmlEsc(t('no_insights_sub'))}</div></div></div>`}</div>
    <div class="section-title">${htmlEsc(t('insights_pipeline_activity'))}</div>
    <div class="list-card">${stageRows.length ? stageRows.map(r => `
      <div class="list-row" style="cursor:default">
        <div class="list-main"><div class="list-title">${htmlEsc(r.label)}</div></div>
        <div class="list-right"><span class="list-amt">${r.count}</span></div>
      </div>`).join('') : `<div class="list-row" style="cursor:default"><div class="list-main"><div class="list-sub">${htmlEsc(t('insights_no_pipeline_activity'))}</div></div></div>`}</div>
    <button type="button" class="btn-danger" style="width:100%;margin-top:6px" onclick="clearUsageEvents()">${htmlEsc(t('insights_clear'))}</button>
  `;
}
async function clearUsageEvents() {
  if (!confirm(t('insights_clear_confirm'))) return;
  const uid = isGuest ? 'guest' : currentUser.id;
  for (const e of usageEvents) { await dbDel('usageEvents', e.id); }
  usageEvents = usageEvents.filter(e => e.uid !== uid);
  renderInsights();
  toast(t('insights_cleared'));
}

// ─── DASHBOARD (Home) ─────────────────────────────────────────────────
function monthKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function jobsThisMonth() { const m = monthKey(); return jobs.filter(j => (j.date||'').startsWith(m)); }
function jobsToday() { const t0 = todayISO(); return jobs.filter(j => j.date === t0); }
// My Task Goal's Quarter/Year periods — same date-range-filter shape as
// jobsThisMonth(), just a wider window (a plain string-prefix match, like
// jobsThisMonth uses, doesn't work once the window spans more than one
// month, so these compare actual Date objects instead).
function jobsThisQuarter() {
  const d = new Date();
  const qStart = new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
  const qEnd = new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3 + 3, 1);
  return jobs.filter(j => { const jd = new Date(j.date); return jd >= qStart && jd < qEnd; });
}
function jobsThisYear() { const y = String(new Date().getFullYear()); return jobs.filter(j => (j.date||'').startsWith(y)); }

// ─── Backup reminder (data-loss protection) ────────────────────────────
// Sidekick is local-only storage: clearing browser data or switching
// devices without ever exporting a backup means total, unrecoverable data
// loss. Nudge (not nag): only once there's real data worth losing, only
// after 30 days since the last export (or none ever), and dismissible for
// another 14 days at a time.
const BACKUP_REMIND_DAYS = 30;
const BACKUP_SNOOZE_DAYS = 14;
function addDaysISO(iso, days) {
  const d = new Date((iso || todayISO()) + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function daysSinceISO(iso) {
  const a = new Date((iso || todayISO()).slice(0,10) + 'T12:00:00'), b = new Date(todayISO() + 'T12:00:00');
  if (isNaN(a)) return Infinity;
  return Math.round((b - a) / 86400000);
}
function backupReminderDue() {
  // services doesn't count: it's always auto-seeded with starter examples
  // per persona on onboarding, so it's never a signal of real user activity.
  const hasData = jobs.length > 0 || customers.length > 0;
  if (!hasData) return false;
  const snoozedUntil = settings.backupReminderSnoozedUntil;
  if (snoozedUntil && snoozedUntil >= todayISO()) return false;
  if (!settings.lastBackupAt) return true;
  return daysSinceISO(settings.lastBackupAt) >= BACKUP_REMIND_DAYS;
}
async function snoozeBackupReminder() {
  await saveSetting('backupReminderSnoozedUntil', addDaysISO(todayISO(), BACKUP_SNOOZE_DAYS));
  renderBackupReminder();
  updateMoreNavBadge();
  toast(t('backup_snoozed'));
}
// Lives in More/Settings (next to the Backup JSON/Restore JSON actions it's
// nudging you toward) rather than on Home — a device-housekeeping reminder,
// not something that competes with pipeline/payment items for attention.
function renderBackupReminder() {
  const el = document.getElementById('backup-reminder-body');
  if (!el) return;
  if (!backupReminderDue()) { el.innerHTML = ''; return; }
  const last = settings.lastBackupAt ? fmtDate(settings.lastBackupAt.slice(0,10)) : t('backup_never');
  el.innerHTML = `<div class="list-card">
      <div class="list-row" style="cursor:default">
        <div class="list-icon">💾</div>
        <div class="list-main">
          <div class="list-title">${htmlEsc(t('backup_reminder_title'))}</div>
          <div class="list-sub">${htmlEsc(t('backup_reminder_sub').replace('{date}', last))}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;padding:0 16px 14px">
        <button type="button" onclick="exportBackup()" style="flex:1;padding:10px;border:none;background:var(--brand);color:#fff;border-radius:var(--radius-sm);font-weight:700;font-family:inherit;font-size:13px;cursor:pointer">${htmlEsc(t('backup_now'))}</button>
        <button type="button" onclick="snoozeBackupReminder()" style="flex:1;padding:10px;border:1px solid var(--border);background:none;color:var(--text3);border-radius:var(--radius-sm);font-weight:700;font-family:inherit;font-size:13px;cursor:pointer">${htmlEsc(t('remind_later'))}</button>
      </div>
    </div>`;
}
// A small dot on the More nav icon so a due backup reminder is still
// discoverable without opening Settings, now that it no longer shows on Home.
function updateMoreNavBadge() {
  const badge = document.getElementById('more-nav-badge');
  if (!badge) return;
  badge.style.display = backupReminderDue() ? 'flex' : 'none';
}

// ─── Cloud backup (beta) — Phase 1 of the local-first -> backend migration
// ─────────────────────────────────────────────────────────────────────────
// Deliberately opt-in and additive, not a replacement: enabling this mirrors
// `clients` (only) to the new backend API (window.SidekickBackend, see
// dataClient.js) alongside the existing local IndexedDB save, which stays
// authoritative for reads. Guest mode is out of scope on purpose — it stays
// exactly local-only, zero network calls, matching its whole reason to
// exist (see the project plan for the full reasoning).
function renderCloudBackupSection() {
  const el = document.getElementById('cloud-backup-body');
  if (!el || typeof SidekickBackend === 'undefined') return;
  if (isGuest) { el.innerHTML = ''; return; }
  const enabled = SidekickBackend.isEnabled();
  el.innerHTML = `<div class="list-card">
      <div class="list-row" style="cursor:default">
        <div class="list-icon">${enabled ? '☁️' : '🔒'}</div>
        <div class="list-main">
          <div class="list-title">${htmlEsc(t('cloud_backup_title'))}</div>
          <div class="list-sub">${htmlEsc(enabled ? t('cloud_backup_enabled_sub') : t('cloud_backup_disabled_sub'))}</div>
        </div>
      </div>
      ${enabled ? '' : `<div style="padding:0 16px 14px">
        <button type="button" onclick="enableCloudBackup()" style="width:100%;padding:10px;border:none;background:var(--brand);color:#fff;border-radius:var(--radius-sm);font-weight:700;font-family:inherit;font-size:13px;cursor:pointer">${htmlEsc(t('cloud_backup_enable_btn'))}</button>
      </div>`}
    </div>`;
}
// Re-hashes nothing: reuses this account's already-computed {salt, hash,
// iters} straight from the local `users` record (the same triple
// hashPassword() produced at local registration/login), so enabling this
// never needs the user to re-enter their password — mirroring exactly how
// the one-time local->server migration upload is meant to work (see
// api/migrate-upload.js's header).
async function enableCloudBackup() {
  if (isGuest || typeof SidekickBackend === 'undefined') return;
  const localUser = await dbGet('users', currentUser.id);
  if (!localUser) return;
  let result = await SidekickBackend.register({
    username: localUser.username, salt: localUser.salt, hash: localUser.hash,
    iters: localUser.iters, firstName: localUser.firstName,
  });
  if (!result.ok && result.status === 409) {
    // This account already exists server-side (a previous attempt, or
    // already enabled on another device) — the register endpoint never
    // sees a plaintext password, so there's no hash to "log in" with here;
    // ask for it once, this one time, same as any normal login would.
    const password = prompt(t('cloud_backup_reenter_password'));
    if (!password) return;
    result = await SidekickBackend.login({ username: localUser.username, password });
  }
  if (!result.ok) { toast(t('cloud_backup_failed')); return; }

  const uid = currentUser.id;
  const myClients = (await dbAll('clients')).filter(c => c.uid === uid);
  const upload = await SidekickBackend.migrateUpload(myClients);
  if (!upload.ok) { toast(t('cloud_backup_upload_failed')); renderCloudBackupSection(); return; }
  toast(t('cloud_backup_enabled_toast').replace('{n}', upload.data.inserted));
  renderCloudBackupSection();
}
window.enableCloudBackup = enableCloudBackup;

// ─── SUBSCRIPTION (Phase 0) ─────────────────────────────────────────────
// Deliberately reads live from api/auth-session.js rather than trusting a
// long-lived cache — subscription state can change from a Stripe webhook
// at any moment (a payment succeeding/failing). Guest and any account that
// hasn't enabled cloud backup yet has no backend `users` row at all (see
// renderCloudBackupSection() above) — there's nothing to subscribe against
// yet, so this renders nothing beyond a short hint pointing at the Cloud
// backup section right above it.
//
// `__entitlements` is a same-tab, in-memory cache of the last fetch
// (refreshed at boot via finishAppBoot(), and again every time Settings
// renders this section) — the Phase 1 feature gates below
// (planHasFeature()/planClientCap()) read this synchronously rather than
// awaiting a fresh network round trip on every "+ Add client"/booking-save
// tap. A few minutes of staleness on a plan/lock change is an acceptable
// trade for that — same "good enough, not perfectly live" bar this app
// already accepts elsewhere (e.g. the mirror-not-authoritative backend
// writes). `null` means "not tracked" (guest, or a registered account that
// never enabled cloud backup) — every gate below treats that as
// unrestricted, matching Phase 0's own framing: the paywall only applies
// once an account opts into the backend/subscription system at all, never
// to purely local usage.
let __entitlements = null;
async function refreshEntitlements() {
  if (isGuest || typeof SidekickBackend === 'undefined' || !SidekickBackend.isEnabled()) {
    __entitlements = null;
    return null;
  }
  const r = await SidekickBackend.session();
  __entitlements = r.ok ? r.data.user : null;
  return __entitlements;
}
// key is one of lib/entitlements.js's FEATURE_KEYS (cloudSync/lineBooking/
// recurringBookings/researchPremium/docBranding) — see that file for the
// authoritative plan->feature mapping this only ever mirrors, never
// recomputes.
function planHasFeature(key) {
  const e = __entitlements;
  if (!e) return true;
  if (e.locked) return false;
  return !!(e.features && e.features[key]);
}
// null clientCap from the server means unlimited (JSON has no Infinity). A
// locked account's cap is 0 — matches "read-only until you subscribe again"
// rather than letting a locked-but-under-cap account keep adding clients.
function planClientCap() {
  const e = __entitlements;
  if (!e) return Infinity;
  if (e.locked) return 0;
  return e.clientCap == null ? Infinity : e.clientCap;
}
const SUBSCRIPTION_PRICE_THB = { basic: 149, pro: 349 };
async function renderSubscriptionSection() {
  const el = document.getElementById('subscription-body');
  if (!el || typeof SidekickBackend === 'undefined') return;
  if (isGuest) { el.innerHTML = ''; return; }
  if (!SidekickBackend.isEnabled()) {
    __entitlements = null;
    el.innerHTML = `<p style="font-size:12px;color:var(--text3);margin:0 16px 14px">${htmlEsc(t('subscription_needs_account_hint'))}</p>`;
    return;
  }
  const u = await refreshEntitlements();
  if (!u) { el.innerHTML = ''; return; }
  const statusKey = u.locked ? 'subscription_status_locked'
    : u.subscriptionStatus === 'trialing' ? 'subscription_status_trialing'
    : u.subscriptionStatus === 'past_due' ? 'subscription_status_past_due'
    : u.subscriptionStatus === 'canceled' ? 'subscription_status_canceled'
    : 'subscription_status_active';
  const statusText = (statusKey === 'subscription_status_trialing')
    ? t('subscription_status_trialing').replace('{n}', u.trialDaysLeft)
    : t(statusKey);

  const upgradeBtns = [];
  if (u.plan !== 'pro') {
    upgradeBtns.push(`<button type="button" class="qc-btn" style="width:100%" onclick="startSubscriptionCheckout('pro')">${htmlEsc(t('subscription_upgrade_pro_btn').replace('{price}', SUBSCRIPTION_PRICE_THB.pro))}</button>`);
  }
  if (u.plan === 'basic' && (u.locked || u.subscriptionStatus !== 'active')) {
    upgradeBtns.push(`<button type="button" class="qc-btn" style="width:100%" onclick="startSubscriptionCheckout('basic')">${htmlEsc(t('subscription_subscribe_basic_btn').replace('{price}', SUBSCRIPTION_PRICE_THB.basic))}</button>`);
  }
  if (u.hasStripeCustomer) {
    upgradeBtns.push(`<button type="button" class="qc-btn" style="width:100%" onclick="openBillingPortal()">${htmlEsc(t('subscription_manage_billing_btn'))}</button>`);
  }

  el.innerHTML = `<div class="list-card">
      ${u.locked ? `<div style="padding:12px 16px;background:color-mix(in srgb,var(--overdue) 12%,var(--card));color:var(--overdue);font-size:12px;font-weight:700">${htmlEsc(t('subscription_locked_banner'))}</div>` : ''}
      <div class="list-row" style="cursor:default">
        <div class="list-icon">💳</div>
        <div class="list-main">
          <div class="list-title">${htmlEsc(t('subscription_plan_' + u.plan))}</div>
          <div class="list-sub">${htmlEsc(statusText)}</div>
        </div>
      </div>
      ${upgradeBtns.length ? `<div style="padding:0 16px 14px;display:flex;flex-direction:column;gap:8px">${upgradeBtns.join('')}</div>` : ''}
    </div>`;
}

// ─── DOCUMENT BRANDING (Phase 1, Pro+) ──────────────────────────────────
// Same FileReader/dataURL-into-a-setting pattern portfolio.js already uses
// for item images (see saveItem()/onImagePick() there), just persisted via
// saveSetting() as `settings.sellerLogoDataUrl` instead of a per-item
// IndexedDB field — one logo per account, not one per document. Reads
// planHasFeature('docBranding') the same synchronous, cached way every
// other Phase 1 gate does (see planHasFeature() above); the upload UI
// itself is only shown once entitled, but sellerLogoDataUrl() (used by
// docgen.js/invoices.js at render time) re-checks the same gate rather
// than trusting whatever was true when the logo was uploaded — a downgrade
// stops the logo from appearing on new documents without deleting the
// stored image, so re-upgrading brings it straight back.
let __pickedLogo = undefined; // undefined = "use settings.sellerLogoDataUrl as-is", null = "explicitly removed this render"
function sellerLogoDataUrl() {
  if (typeof planHasFeature === 'function' && !planHasFeature('docBranding')) return '';
  return (settings && settings.sellerLogoDataUrl) || '';
}
function renderSellerLogoSection() {
  const el = document.getElementById('seller-logo-body');
  if (!el) return;
  const entitled = typeof planHasFeature !== 'function' || planHasFeature('docBranding');
  if (!entitled) {
    el.innerHTML = `<div class="settings-row" style="cursor:default">
        <span class="settings-label">${htmlEsc(t('business_logo'))}</span>
        <span style="font-size:12px;color:var(--text3)">${htmlEsc(t('doc_branding_locked'))}</span>
      </div>`;
    return;
  }
  __pickedLogo = settings.sellerLogoDataUrl || null;
  el.innerHTML = `
    <div class="field" style="padding:0 16px">
      <label for="seller-logo-input" style="display:block;font-size:12px;font-weight:700;color:var(--text3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.3px">${htmlEsc(t('business_logo'))}</label>
      <input type="file" id="seller-logo-input" accept="image/*" style="padding:8px 0;font-size:13px">
    </div>
    <div id="seller-logo-preview-wrap" style="padding:0 16px 14px"></div>`;
  document.getElementById('seller-logo-input').addEventListener('change', onSellerLogoPick);
  renderSellerLogoPreview();
}
function renderSellerLogoPreview() {
  const wrap = document.getElementById('seller-logo-preview-wrap');
  if (!wrap) return;
  if (!__pickedLogo) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `<div style="display:flex;align-items:center;gap:12px">
      <img src="${attrEsc(__pickedLogo)}" alt="" style="width:64px;height:64px;border-radius:var(--radius-sm);object-fit:contain;background:var(--card);border:0.5px solid var(--border)">
      <button type="button" id="seller-logo-remove" class="qc-btn" style="width:auto;padding:0 14px">${htmlEsc(t('remove_logo_btn'))}</button>
    </div>`;
  document.getElementById('seller-logo-remove').addEventListener('click', async () => {
    __pickedLogo = null;
    const input = document.getElementById('seller-logo-input');
    if (input) input.value = '';
    await saveSetting('sellerLogoDataUrl', '');
    renderSellerLogoPreview();
  });
}
function onSellerLogoPick(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    toast(t('image_too_large'));
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    __pickedLogo = reader.result;
    await saveSetting('sellerLogoDataUrl', __pickedLogo);
    renderSellerLogoPreview();
  };
  reader.onerror = () => toast(t('image_read_failed'));
  reader.readAsDataURL(file);
}
async function startSubscriptionCheckout(plan) {
  const r = await SidekickBackend.billingCheckout(plan);
  if (!r.ok || !r.data.url) { toast(t('subscription_checkout_failed')); return; }
  window.location.href = r.data.url;
}
window.startSubscriptionCheckout = startSubscriptionCheckout;
async function openBillingPortal() {
  const r = await SidekickBackend.billingPortal();
  if (!r.ok || !r.data.url) { toast(t('subscription_portal_failed')); return; }
  window.location.href = r.data.url;
}
window.openBillingPortal = openBillingPortal;

// The migration plan's actual "back up your existing data" first-login
// prompt — surfaced proactively instead of requiring a user to notice the
// Settings row above on their own. Shown at most once per local account
// (localStorage flag, not the server's users.migrated_at — this account may
// not even exist server-side yet), and never blocks app use either way:
// "Not now" and "Enable" both dismiss it for good, Settings still has the
// same row for anyone who changes their mind later.
async function maybeShowCloudBackupModal() {
  if (isGuest || typeof SidekickBackend === 'undefined' || SidekickBackend.isEnabled()) return;
  const seenKey = 'sidekick_backup_modal_seen_' + currentUser.id;
  if (localStorage.getItem(seenKey)) return;
  localStorage.setItem(seenKey, '1');
  const localUser = await dbGet('users', currentUser.id);
  // LINE-only accounts have no password hash to register with server-side
  // (Phase 1's register endpoint requires one) — an "Enable" button that's
  // guaranteed to fail would be worse than no prompt at all.
  if (!localUser || !localUser.hash) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.id = 'cloud-backup-modal';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${attrEsc(t('cloud_backup_title'))}">
      <div class="modal-handle"></div>
      <div class="modal-title">${htmlEsc(t('cloud_backup_title'))}</div>
      <div class="form-body" style="padding:0 20px 4px">
        <p style="color:var(--text2);font-size:14px;line-height:1.5;margin:0 0 16px">${htmlEsc(t('cloud_backup_modal_body'))}</p>
      </div>
      <button type="button" class="btn-submit" id="cloud-backup-modal-enable">${htmlEsc(t('cloud_backup_enable_btn'))}</button>
      <button type="button" class="btn-danger" id="cloud-backup-modal-later" style="border-color:var(--border-mid);color:var(--text3)">${htmlEsc(t('cloud_backup_later_btn'))}</button>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('cloud-backup-modal-later').addEventListener('click', () => overlay.remove());
  document.getElementById('cloud-backup-modal-enable').addEventListener('click', async () => {
    overlay.remove();
    await enableCloudBackup();
  });
}

// ─── Notifications (in-app Action Queue + OS-level, app-triggered) ─────
// App-triggered, not server-triggered: everything here only fires while
// this tab is open (or freshly backgrounded) — there's no backend, so
// nothing can wake the app up to check conditions while it's fully
// closed. A real server-triggered version (synced data + a scheduled job,
// so e.g. an overdue invoice notifies you even days after you last opened
// the app) is a deliberate next milestone, not attempted here.
const NOTIFY_STALE_DAYS = 3;         // engagement sitting in one stage this long -> nudge
const NOTIFY_BOOKING_LEAD_MIN = 60;  // booking starting within this many minutes -> nudge
function hhmmToMin(hhmm) {
  if (!hhmm) return 0;
  const p = String(hhmm).split(':');
  return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
}
// Single source of truth for "what needs attention right now" — used by
// both the in-app Action Queue (renderHome) and the OS-notification check
// (checkAndFireNotifications), so the two can never disagree.
async function computeNotificationConditions() {
  const uid = isGuest ? 'guest' : currentUser.id;
  const todayStr = todayISO();
  const [allInvoices, allBookings] = await Promise.all([dbAll('invoices'), dbAll('bookings')]);

  const overdueInvoices = allInvoices.filter(i => i.uid === uid && i.status !== 'paid' && i.dueDate && i.dueDate < todayStr);

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const upcomingBookings = allBookings
    .filter(b => b.uid === uid && b.status === 'scheduled' && b.date === todayStr)
    .filter(b => { const start = hhmmToMin(b.startTime); return start >= nowMin && start - nowMin <= NOTIFY_BOOKING_LEAD_MIN; });

  const staleJobs = jobs.filter(j => !jobComplete(j) && daysSinceISO((j.updatedAt || '').slice(0, 10)) >= NOTIFY_STALE_DAYS);

  return { overdueInvoices, upcomingBookings, staleJobs };
}
function notifyConditionKey(kind, id, extra) {
  return kind + ':' + id + (extra ? ':' + extra : '');
}
async function showOsNotification(title, body, tag) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (!navigator.serviceWorker) return;
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, { body, tag, icon: 'icons/icon.svg' });
  } catch (e) { console.error('showNotification failed', e); }
}
// Fires an OS notification for each condition that's newly true since the
// last check, and — just as importantly — forgets conditions that have
// since resolved (invoice paid, booking passed, stage advanced), so the
// SAME kind of event can notify again the next time it happens.
async function checkAndFireNotifications() {
  if (!settings.notificationsEnabled) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  let cond;
  try { cond = await computeNotificationConditions(); } catch (e) { console.error(e); return; }
  const notified = settings.notifiedIds || {};
  const nextNotified = {};
  const toFire = [];

  cond.overdueInvoices.forEach(i => {
    const k = notifyConditionKey('inv', i.id);
    nextNotified[k] = true;
    if (!notified[k]) toFire.push({ title: 'Invoice overdue', body: `${i.number || 'Invoice'} · ${i.clientName || 'Client'} — ${money(i.clientPays)}`, tag: k });
  });
  cond.upcomingBookings.forEach(b => {
    const k = notifyConditionKey('bk', b.id);
    nextNotified[k] = true;
    if (!notified[k]) toFire.push({ title: 'Upcoming booking', body: `${b.title || 'Booking'} at ${b.startTime}`, tag: k });
  });
  cond.staleJobs.forEach(j => {
    const st = (typeof jobStage === 'function') ? jobStage(j) : '';
    const k = notifyConditionKey('job', j.id, st);
    nextNotified[k] = true;
    if (!notified[k]) toFire.push({ title: 'Engagement needs attention', body: `${j.client || 'Client'} has been in ${t((STAGE_META[st] || {}).label) || st} for a few days`, tag: k });
  });

  for (const n of toFire) await showOsNotification(n.title, n.body, n.tag);
  if (JSON.stringify(nextNotified) !== JSON.stringify(notified)) await saveSetting('notifiedIds', nextNotified);
}
async function onNotificationsToggle(checked) {
  if (checked) {
    if (typeof Notification === 'undefined') { toast('Notifications are not supported on this device'); document.getElementById('set-notifications').checked = false; return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notification permission was not granted'); document.getElementById('set-notifications').checked = false; return; }
  }
  await saveSetting('notificationsEnabled', checked);
  if (checked) checkAndFireNotifications();
}

async function renderHome() {
  // greeting
  const greetEl = document.getElementById('home-greeting');
  if (greetEl) greetEl.textContent = `${t('greeting_' + greetingPeriod())}, ${displayName()}`;

  const mj = jobsThisMonth();
  const gross = mj.reduce((s,j)=> s + (Number(j.amount)||0) + (Number(j.tip)||0), 0);
  const exp = mj.reduce((s,j)=> s + (Number(j.expense)||0), 0);
  const net = gross - exp;
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('hero-label', t('earned_this_month'));
  setTxt('hero-amt', money(net));
  setTxt('stat-jobs-val', mj.length);
  setTxt('stat-avg-val', money(mj.length ? net / mj.length : 0));
  setTxt('stat-exp-val', money(exp));

  renderGoal();
  renderHomeAlert();
  updateMoreNavBadge();
  renderIncomingPipeline();
}
// Amber alert card — surfaces the single highest-priority "needs attention"
// item (same computeClientsNeedingAttention() source as the Clients screen's
// own list) right on Home, with one action button, instead of making the
// user go find it. Tapping the card body (not the button) jumps to Clients
// to see the rest.
async function renderHomeAlert() {
  const card = document.getElementById('home-alert-card');
  if (!card) return;
  const items = await computeClientsNeedingAttention();
  if (!items.length) { card.style.display = 'none'; return; }
  card.style.display = 'flex';
  const top = items[0];
  const extra = items.length - 1;
  document.getElementById('home-alert-text').textContent = `${top.client.name} — ${top.reason}` + (extra > 0 ? ` (+${extra} more)` : '');
  const btn = document.getElementById('home-alert-btn');
  btn.textContent = top.actionLabel;
  btn.onclick = (e) => { e.stopPropagation(); top.action(); };
}
// Incoming pipeline: replaces the old Action Queue nudge list with a direct
// preview of active engagements, so Home shows what's actually moving through
// the pipeline instead of a separate notification-style summary. Overdue
// invoices / imminent bookings / stale engagements still drive OS-level
// notifications (checkAndFireNotifications(), unaffected by this) — this is
// just Home's own in-app view.
const INCOMING_PIPELINE_LIMIT = 6;
function incomingPipelineRowHtml(j) {
  const stage = jobStage(j);
  const meta = STAGE_META[stage] || {};
  const pkg = j.packageId != null ? packages.find(p => p.id === j.packageId) : null;
  const subParts = [htmlEsc((meta.label && t(meta.label)) || stage || '')];
  if (pkg) subParts.push(`${packageUsed(pkg)} ${t('goal_of')} ${htmlEsc(pkg.totalSessions)}`);
  else if (j.serviceName) subParts.push(htmlEsc(j.serviceName));
  return `<div class="list-row" onclick="openPipelineAt('${stage}')">
      <div class="list-icon" style="background:${meta.dot}22;color:${meta.dot}">${meta.icon || ''}</div>
      <div class="list-main">
        <div class="list-title">${htmlEsc(j.client || 'Client')}</div>
        <div class="list-sub">${subParts.join(' · ')}</div>
      </div>
      <div class="list-right"><div class="list-amt tnum">${htmlEsc(money(j.amount))}</div></div>
    </div>`;
}
function renderIncomingPipeline() {
  const el = document.getElementById('incoming-pipeline-body');
  if (!el) return;
  const uid = isGuest ? 'guest' : currentUser.id;
  const order = getStageOrder();
  // Earliest stage first (newest leads read as most "incoming"), then oldest
  // updatedAt within the same stage (surfaces stalled engagements first —
  // keeps the one thing the old stale-engagement nudge was good for).
  const active = jobs.filter(j => j.uid === uid && !jobComplete(j)).sort((a, b) => {
    const ai = order.indexOf(jobStage(a)), bi = order.indexOf(jobStage(b));
    if (ai !== bi) return ai - bi;
    return (a.updatedAt || '').localeCompare(b.updatedAt || '');
  });
  const shown = active.slice(0, INCOMING_PIPELINE_LIMIT);
  if (!shown.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">✅</div>
        <p data-i18n="incoming_pipeline_empty">${t('incoming_pipeline_empty')}</p>
        <span data-i18n="incoming_pipeline_empty_sub">${t('incoming_pipeline_empty_sub')}</span></div>`;
    return;
  }
  let html = '<div class="list-card">' + shown.map(incomingPipelineRowHtml).join('') + '</div>';
  if (active.length > shown.length) {
    html += `<div style="text-align:center;padding:12px;color:var(--brand);font-weight:700;font-size:13px;cursor:pointer" onclick="switchScreen('pipeline')">+${active.length - shown.length} more in Pipeline →</div>`;
  }
  el.innerHTML = html;
}
window.renderIncomingPipeline = renderIncomingPipeline;
// My Task Goal — replaces the old single daily-goal card with a Month /
// Quarter / Year switch, each period tracking its own target and net-income
// progress. settings.goalTargets = {month, quarter, year} (migrated once
// from the old single dailyGoal in enterApp()); settings.goalPeriod is the
// persisted switch selection.
const GOAL_PERIODS = ['month', 'quarter', 'year'];
function goalPeriodJobs(period) {
  return period === 'quarter' ? jobsThisQuarter() : period === 'year' ? jobsThisYear() : jobsThisMonth();
}
function renderGoal() {
  const card = document.getElementById('goal-card');
  if (!card) return;
  const period = GOAL_PERIODS.includes(settings.goalPeriod) ? settings.goalPeriod : 'month';
  const targets = settings.goalTargets || {};
  const goal = Number(targets[period]) || 0;

  const switchEl = document.getElementById('goal-period-switch');
  if (switchEl) {
    switchEl.querySelectorAll('.goal-period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === period));
  }
  if (!goal) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  const net = goalPeriodJobs(period).reduce((s, j) => s + netOf(j), 0);
  const pct = Math.max(0, Math.min(100, Math.round((net / goal) * 100)));
  const reached = net >= goal;
  const fill = document.getElementById('goal-fill');
  fill.style.width = pct + '%';
  fill.classList.toggle('reached', reached);
  document.getElementById('goal-pct').textContent = pct + '%';
  document.getElementById('goal-amt-of').textContent = `${money(net)} ${t('goal_of')} ${money(goal)}`;
  document.getElementById('goal-sub').textContent = reached ? t('goal_reached')
    : `${t('goal_pace_on')}${money(goal - net)}${t('goal_to_go_' + period)}`;
}
async function onGoalPeriodChange(period) {
  if (!GOAL_PERIODS.includes(period)) return;
  await saveSetting('goalPeriod', period);
  renderGoal();
}
async function onGoalTargetChange(period, v) {
  if (!GOAL_PERIODS.includes(period)) return;
  const n = parseFloat(v);
  const targets = { ...(settings.goalTargets || {}) };
  targets[period] = isNaN(n) ? 0 : n;
  await saveSetting('goalTargets', targets);
  renderGoal();
}

// ─── JOBS LIST ────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
}
// ─── JOB FORM (modal) ─────────────────────────────────────────────────
// Populate the job form's customer + service dropdowns (per-uid lists) and set
// the current selection.
function populateJobSelects(selCustomerId, selServiceId) {
  const cs = document.getElementById('j-customer');
  if (cs) {
    cs.innerHTML = `<option value="">${htmlEsc(t('none_option'))}</option>` +
      customers.map(c => `<option value="${c.id}">${htmlEsc(c.name)}</option>`).join('') +
      `<option value="__new__">${htmlEsc(t('add_new_client_option'))}</option>`;
    cs.value = selCustomerId != null ? String(selCustomerId) : '';
  }
  const ss = document.getElementById('j-service');
  if (ss) {
    ss.innerHTML = `<option value="">${htmlEsc(t('none_option'))}</option>` +
      services.map(s => `<option value="${s.id}">${htmlEsc(s.name)} · ${htmlEsc(money(s.rate))}</option>`).join('') +
      `<option value="__new__">${htmlEsc(t('add_new_service_option'))}</option>`;
    ss.value = selServiceId != null ? String(selServiceId) : '';
  }
}
// Picking "+ Add a new client" opens the Customer modal stacked on top of the
// job form (never closed underneath); saveCustomer() links the new record back
// into this form once it's created — see __pendingJobCustomerLink below.
function onJobCustomerChange(v) {
  const cs = document.getElementById('j-customer');
  if (v === '__new__') {
    if (cs) cs.value = '';
    window.__pendingJobCustomerLink = true;
    openAddCustomer();
    return;
  }
  refreshJobPackageRow(v, null);
}
// Shows/hides the job form's "Apply to package" row depending on whether the
// selected client has a session package with sessions left. `existingPackageId`
// (a job's own stored packageId, on edit) takes precedence over whatever's
// currently active, so editing a session already linked to a now-exhausted
// package still shows that same package rather than silently switching it.
function refreshJobPackageRow(clientId, existingPackageId) {
  const row = document.getElementById('j-package-row');
  const checkbox = document.getElementById('j-apply-package');
  const label = document.getElementById('j-package-label');
  const hidden = document.getElementById('j-package-id');
  if (!row || !checkbox || !label || !hidden) return;
  const cid = clientId ? parseInt(clientId) : null;
  let pkg = null;
  if (cid != null) {
    if (existingPackageId != null) pkg = packages.find(p => p.id === existingPackageId) || null;
    if (!pkg) pkg = activePackageFor(cid);
  }
  if (!pkg) {
    row.style.display = 'none';
    hidden.value = '';
    checkbox.checked = false;
    return;
  }
  row.style.display = 'flex';
  hidden.value = pkg.id;
  label.textContent = `${t('apply_to_package')} (${packageRemaining(pkg)} ${t('of_label')} ${pkg.totalSessions} ${t('left_label')})`;
  checkbox.checked = existingPackageId != null ? existingPackageId === pkg.id : true;
  const countLabel = document.getElementById('j-count-label');
  if (countLabel) countLabel.textContent = packageUnitLabel();
  refreshPackageFastPathButton(cid);
}
// "Ship remaining service" fast path — for a client who already has an
// active package, redeeming today's visit shouldn't require re-entering a
// service/fee that isn't relevant (it was paid for up front). Add-mode
// only: editing an existing job already has its own path into Delivery via
// Task flow's confirm card, and jumping an in-flight job's stage here too
// would let two different mechanisms disagree about where it is.
function refreshPackageFastPathButton(cid) {
  const wrap = document.getElementById('j-package-fastpath');
  if (!wrap) return;
  const isAddMode = !document.getElementById('j-edit-id').value;
  const pkg = isAddMode && cid != null ? activePackageFor(cid) : null;
  if (!pkg) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  const remaining = packageRemaining(pkg);
  const btn = document.getElementById('j-fastpath-btn');
  if (btn) btn.textContent = t('log_delivery_btn').replace('{n}', remaining).replace('{total}', pkg.totalSessions).replace('{unit}', packageUnitLabel());
}
function resetPackageFastPath() {
  const standard = document.getElementById('j-standard-fields');
  const btnWrap = document.getElementById('j-package-fastpath');
  const confirmWrap = document.getElementById('j-fastpath-confirm');
  if (standard) standard.style.display = '';
  if (btnWrap) btnWrap.style.display = 'none';
  if (confirmWrap) { confirmWrap.style.display = 'none'; confirmWrap.innerHTML = ''; }
}
function startPackageFastPath() {
  const cid = parseInt(document.getElementById('j-customer').value);
  const pkg = activePackageFor(cid);
  if (!pkg) return;
  const remaining = packageRemaining(pkg);
  const unit = packageUnitLabel();
  document.getElementById('j-standard-fields').style.display = 'none';
  document.getElementById('j-package-fastpath').style.display = 'none';
  const confirmWrap = document.getElementById('j-fastpath-confirm');
  confirmWrap.style.display = 'block';
  confirmWrap.innerHTML = `
    <div class="confirm-card">
      <div class="confirm-title">${htmlEsc(t('confirm_delivered_title').replace('{unit}', unit))}</div>
      <div class="confirm-context tnum">${htmlEsc(t('confirm_delivered_context').replace('{n}', remaining).replace('{total}', pkg.totalSessions).replace('{unit}', unit))}</div>
      <div class="confirm-input-row">
        <input type="number" class="confirm-input tnum" id="jfp-qty" min="1" oninput="validateFastPathQty(${remaining})">
        <span class="confirm-unit">${htmlEsc(unit)}</span>
      </div>
      <div class="confirm-error" id="jfp-error" style="display:none"></div>
      <div class="confirm-btns">
        <button type="button" class="confirm-btn-cancel" onclick="cancelPackageFastPath()">${htmlEsc(t('confirm_cancel'))}</button>
        <button type="button" class="confirm-btn-save disabled" id="jfp-save" onclick="saveFastPathDelivery()">${htmlEsc(t('confirm_and_advance'))}</button>
      </div>
    </div>
  `;
}
window.startPackageFastPath = startPackageFastPath;
function cancelPackageFastPath() {
  resetPackageFastPath();
  refreshPackageFastPathButton(parseInt(document.getElementById('j-customer').value) || null);
}
window.cancelPackageFastPath = cancelPackageFastPath;
function validateFastPathQty(remaining) {
  const input = document.getElementById('jfp-qty');
  const errEl = document.getElementById('jfp-error');
  const saveBtn = document.getElementById('jfp-save');
  if (!input) return;
  const val = parseInt(input.value, 10);
  const over = isFinite(val) && val > remaining;
  const invalid = !(val > 0) || over;
  input.classList.toggle('blocked', over);
  if (errEl) {
    errEl.style.display = over ? 'flex' : 'none';
    if (over) errEl.textContent = t('confirm_overdraft_error').replace(/\{n\}/g, remaining);
  }
  if (saveBtn) saveBtn.classList.toggle('disabled', invalid);
}
window.validateFastPathQty = validateFastPathQty;
async function saveFastPathDelivery() {
  const cid = parseInt(document.getElementById('j-customer').value);
  const pkg = activePackageFor(cid);
  if (!pkg) return;
  const remaining = packageRemaining(pkg);
  const input = document.getElementById('jfp-qty');
  const val = input ? parseInt(input.value, 10) : NaN;
  if (!(val > 0) || val > remaining) { validateFastPathQty(remaining); return; }
  const uid = isGuest ? 'guest' : currentUser.id;
  const custRec = customers.find(c => c.id === cid);
  const client = (custRec && custRec.name) || '';
  const date = document.getElementById('j-date').value || todayISO();
  const unit = packageUnitLabel();
  const obj = {
    uid, date, client, clientId: cid, serviceId: null, serviceName: '',
    jobType: settings.workType || '',
    amount: 0, tip: 0, expense: 0, count: val, notes: '', netAmount: 0,
    cuid: cuid(), stageOrder: getStageOrder().slice(), stage: 'delivery', complete: false,
    invoiceId: null, quoteDocId: null, packageId: pkg.id, updatedAt: nowISO(),
  };
  await dbPut('jobs', obj);
  logEvent('session_logged');
  closeJobModal();
  await reload();
  toast(t('delivery_logged').replace('{n}', val).replace('{unit}', unit));
}
window.saveFastPathDelivery = saveFastPathDelivery;
// Picking "+ Add a new service" opens the Service modal stacked on top of
// the job form (never closed underneath); saveService() links the new
// record back into this form once it's created — see
// __pendingJobServiceLink below, mirroring onJobCustomerChange() above.
function onJobServiceChange(v) {
  const ss = document.getElementById('j-service');
  if (v === '__new__') {
    if (ss) ss.value = '';
    window.__pendingJobServiceLink = true;
    openAddService();
    return;
  }
  if (!v) return;
  const s = services.find(x => x.id === parseInt(v));
  if (s) { document.getElementById('j-amount').value = s.rate; calcNet(); }
}
function openAddJob(dateISO) {
  document.getElementById('modal-title').textContent = t('add_job');
  document.getElementById('j-edit-id').value = '';
  document.getElementById('j-date').value = dateISO || todayISO();
  ['j-amount','j-tip','j-expense','j-count','j-notes'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  populateJobSelects('', '');
  resetPackageFastPath();
  refreshJobPackageRow(null, null);
  document.getElementById('j-delete').style.display = 'none';
  // Sub-tasks/milestones/time tracking all need a saved job id to attach to.
  document.getElementById('job-tracking-section').style.display = 'none';
  clearFieldErrors();
  calcNet();
  openJobModal();
}
function openEditJob(id) {
  const j = jobs.find(x => x.id === id);
  if (!j) return;
  document.getElementById('modal-title').textContent = t('edit_job');
  document.getElementById('j-edit-id').value = String(id);
  resetPackageFastPath();
  const set = (i,v)=>{ const el=document.getElementById(i); if(el) el.value = (v==null?'':v); };
  set('j-date', j.date);
  set('j-amount', j.amount); set('j-tip', j.tip);
  set('j-expense', j.expense); set('j-count', j.count); set('j-notes', j.notes);
  populateJobSelects(j.clientId != null ? j.clientId : '', j.serviceId != null ? j.serviceId : '');
  refreshJobPackageRow(j.clientId, j.packageId != null ? j.packageId : null);
  document.getElementById('j-delete').style.display = 'block';
  window.__milestoneFormOpen = false;
  document.getElementById('job-tracking-section').style.display = 'block';
  renderJobTracking(id);
  clearFieldErrors();
  calcNet();
  openJobModal();
}
function openJobModal() { document.getElementById('modal-job').classList.add('open'); }
function closeJobModal() {
  document.getElementById('modal-job').classList.remove('open');
  clearInterval(_jobTimerTickHandle);
}

function calcNet() {
  const num = id => parseFloat(document.getElementById(id).value) || 0;
  const net = num('j-amount') + num('j-tip') - num('j-expense');
  document.getElementById('j-net').textContent = money(net, 0);
}
function clearFieldErrors() {
  document.querySelectorAll('.field-invalid').forEach(el => el.classList.remove('field-invalid'));
  document.querySelectorAll('.field-err').forEach(el => el.remove());
}
function markFieldError(inputId, msgKey) {
  const input = document.getElementById(inputId);
  if (!input) { toast(t(msgKey)); return; }
  const wrap = input.closest('.field, .field-half') || input.parentElement;
  wrap.classList.add('field-invalid');
  if (!wrap.querySelector('.field-err')) {
    const m = document.createElement('div');
    m.className = 'field-err'; m.textContent = t(msgKey);
    wrap.appendChild(m);
  }
  input.addEventListener('input', function clr() {
    wrap.classList.remove('field-invalid');
    const e = wrap.querySelector('.field-err'); if (e) e.remove();
    input.removeEventListener('input', clr);
  });
  try { input.focus({preventScroll:false}); } catch(e) { input.focus(); }
}
async function saveJob() {
  const num = id => parseFloat(document.getElementById(id).value) || 0;
  const date = document.getElementById('j-date').value;
  const amount = num('j-amount'), tip = num('j-tip'), expense = num('j-expense');
  const count = parseInt(document.getElementById('j-count').value) || 0;
  const notes = (document.getElementById('j-notes').value || '').trim();
  clearFieldErrors();
  if (!date) { markFieldError('j-date', 'err_enter_date'); return; }
  const custVal = document.getElementById('j-customer').value;
  if (!custVal || custVal === '__new__') { markFieldError('j-customer', 'err_select_client'); return; }
  if (amount < 0) { markFieldError('j-amount', 'err_neg'); return; }
  for (const [fid, val, max] of [['j-amount',amount,100000000],['j-tip',tip,100000000],['j-expense',expense,100000000],['j-count',count,100000]]) {
    if (val < 0) { markFieldError(fid, 'err_neg'); return; }
    if (val > max) { markFieldError(fid, 'err_too_big'); return; }
  }
  const uid = isGuest ? 'guest' : currentUser.id;
  // The Client dropdown is the only "who" input now (Member Tags merged into
  // Client) — client is always derived from the selected Customer record.
  const clientId = parseInt(custVal);
  const custRec = customers.find(c => c.id === clientId);
  const client = (custRec && custRec.name) || '';
  const svcVal = document.getElementById('j-service').value;
  const serviceId = svcVal ? parseInt(svcVal) : null;
  const svc = serviceId != null ? services.find(s => s.id === serviceId) : null;
  const serviceName = svc ? svc.name : '';
  const obj = {uid, date, client, clientId, serviceId, serviceName,
    jobType: settings.workType || '',
    amount, tip, expense, count, notes, netAmount: amount + tip - expense};
  const editId = document.getElementById('j-edit-id').value;
  if (editId) {
    const id = parseInt(editId);
    const prev = jobs.find(j => j.id === id);
    if (!prev) return;
    obj.id = id; obj.cuid = prev.cuid || cuid();
    obj.jobType = prev.jobType || settings.workType || '';   // preserve the job's original work type on edit
    // Preserve the engagement's own stage progress on edit — editing details
    // (fee, notes, date) shouldn't reset or advance where it is in the pipeline.
    obj.stageOrder = prev.stageOrder != null ? prev.stageOrder : getStageOrder().slice();
    obj.stage = prev.stage != null ? prev.stage : obj.stageOrder[0];
    obj.complete = prev.complete || false;
    obj.invoiceId = prev.invoiceId != null ? prev.invoiceId : null;
    obj.quoteDocId = prev.quoteDocId != null ? prev.quoteDocId : null;
  } else {
    obj.cuid = cuid();
    // New engagements snapshot the active stage order and start at its first stage.
    obj.stageOrder = getStageOrder().slice();
    obj.stage = obj.stageOrder[0];
    obj.complete = false;
    obj.invoiceId = null;
    obj.quoteDocId = null;
  }
  const applyPkgEl = document.getElementById('j-apply-package');
  const pkgIdEl = document.getElementById('j-package-id');
  obj.packageId = (applyPkgEl && applyPkgEl.checked && pkgIdEl && pkgIdEl.value) ? parseInt(pkgIdEl.value) : null;
  obj.updatedAt = nowISO();
  const isNew = !editId;
  const key = await dbPut('jobs', obj);
  if (obj.id == null) obj.id = key;
  if (isNew) logEvent('session_logged');
  if (!isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
    SidekickBackend.mirrorJobSave(obj).catch(() => {});
  }
  closeJobModal();
  await reload();
  toast(t('job_saved'));
}
async function deleteJob() {
  const editId = document.getElementById('j-edit-id').value;
  if (!editId) return;
  if (!confirm(t('delete_job_confirm'))) return;
  const id = parseInt(editId);
  const prev = jobs.find(j => j.id === id);
  await dbDel('jobs', id);
  if (!isGuest && prev && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
    SidekickBackend.mirrorJobDelete(prev.cuid).catch(() => {});
  }
  closeJobModal();
  await reload();
  toast(t('job_deleted'));
}

// ─── PIPELINE BOARD (primary engagement view) ──────────────────────────
// A left-hand rail lists all 6 stages (icon + label + count); the main area
// renders only the currently-selected ("active") stage's cards — never all
// six at once — so there's no horizontal board to scroll through.
let _pipelineActiveStage = null;
function selectPipelineStage(stage) {
  _pipelineActiveStage = stage;
  renderPipeline();
}
window.selectPipelineStage = selectPipelineStage;
// Jump straight into Pipeline pre-focused on a given stage (used by Home's
// Pipeline-at-a-glance pills).
function openPipelineAt(stage) {
  _pipelineActiveStage = stage;
  switchScreen('pipeline');
}
window.openPipelineAt = openPipelineAt;
function renderPipeline() {
  const el = document.getElementById('pipeline-body');
  if (!el) return;
  const order = getStageOrder();
  const groups = {}; order.forEach(s => groups[s] = []);
  // Group each session under its own stage NAME. A session whose stage isn't
  // a current stage (e.g. after a Settings reorder) lands under the first.
  jobs.forEach(j => { let s = jobStage(j); if (!groups[s]) s = order[0]; groups[s].push(j); });

  if (!_pipelineActiveStage || !order.includes(_pipelineActiveStage)) _pipelineActiveStage = order[0];
  const activeStage = _pipelineActiveStage;
  const activeMeta = STAGE_META[activeStage] || {};
  const activeItems = groups[activeStage] || [];
  const activeIdx = order.indexOf(activeStage);
  const totalActive = order.reduce((s, stg) => s + (groups[stg] || []).length, 0);
  const countEl = document.getElementById('pl-active-count');
  if (countEl) countEl.textContent = `${totalActive} ${t('active_count')}`;

  // Horizontal chip rail (was a left-hand vertical rail — see the redesign
  // handoff's "replaces vertical pipeline") — one stage's cards render at a
  // time, same as before, just picked from a scrollable row of pill chips.
  const chips = order.map(stage => {
    const meta = STAGE_META[stage] || {};
    const isActive = stage === activeStage;
    return `<button type="button" class="pl-chip${isActive ? ' active' : ''}" onclick="selectPipelineStage('${stage}')" aria-current="${isActive ? 'true' : 'false'}">
      <span>${htmlEsc((meta.label && t(meta.label)) || stage)}</span>
      <span class="pl-chip-count">${(groups[stage] || []).length}</span>
    </button>`;
  }).join('');

  // Mini-map: a thin marigold-marked strip showing where the selected stage
  // sits in the whole chain, independent of the chip rail (which can scroll
  // out of sync on a narrow screen) — always the full, fixed-order chain.
  const minimap = order.map((stage, i) =>
    `<span class="pl-minimap-seg${i === activeIdx ? ' active' : i < activeIdx ? ' past' : ''}"></span>`
  ).join('');

  const list = activeItems.length
    ? activeItems.map(j => pipelineCard(j, activeStage)).join('')
    : `<div class="kb-empty">${htmlEsc(t('pl_nothing_here'))}</div>`;

  el.innerHTML = `
    <div class="pl-chip-rail" role="tablist" aria-label="Task flow stages">${chips}</div>
    <div class="pl-minimap">${minimap}</div>
    <p class="pl-stage-hint">${htmlEsc((activeMeta.hint && t(activeMeta.hint)) || (activeMeta.label && t(activeMeta.label)) || activeStage)}</p>
    <div class="pl-main-body">${list}</div>
  `;
  if (window.__kbMoved != null) setTimeout(() => { window.__kbMoved = null; }, 500);
}
window.renderPipeline = renderPipeline;

function pipelineCard(j, stage) {
  const meta = STAGE_META[stage] || {};
  const complete = jobComplete(j);
  const who = j.client || t('field_client');
  const svc = j.serviceName || unitWord();
  const amt = money(Number(j.amount) || 0);
  const order = jobOrder(j);
  const canBack = complete || order.indexOf(jobStage(j)) > 0;
  const enter = (window.__kbMoved === j.id) ? ' kb-enter' : '';
  const doneLabel = j.outcome === 'finished' ? t('mark_finished') : (t(meta.done) || 'Done');
  const foot = complete
    ? `<span class="pl-done">✓ ${htmlEsc(doneLabel)}</span>`
    : `<button type="button" class="pl-action" onclick="event.stopPropagation();pipelineAction(${j.id})">${htmlEsc(t(meta.action) || 'Advance')} →</button>`;
  const skip = (!complete && meta.skippable)
    ? `<button type="button" class="pl-skip" onclick="event.stopPropagation();skipJobStage(${j.id})">${htmlEsc(t('skip_stage'))}</button>`
    : '';
  const finish = (!complete && stage === 'extend')
    ? `<button type="button" class="pl-skip" onclick="event.stopPropagation();finishJobStage(${j.id})">${htmlEsc(t('mark_finished'))}</button>`
    : '';
  // Cash-job path: paid on the spot, no client-facing quote/invoice needed —
  // only offered at Inquiry (deciding this up front, before either document
  // exists, is the natural moment) rather than on every pre-Paid stage,
  // which would crowd this row with a 5th button.
  const cashJob = (!complete && stage === 'pitch')
    ? `<button type="button" class="pl-skip" onclick="event.stopPropagation();cashJobPath(${j.id})">${htmlEsc(t('cash_job'))}</button>`
    : '';
  const reschedule = !complete
    ? `<button type="button" class="pl-skip" onclick="event.stopPropagation();openEditJob(${j.id})">${htmlEsc(t('reschedule'))}</button>`
    : '';
  const back = canBack
    ? `<button type="button" class="kb-back" aria-label="Move back a stage" title="Move back" onclick="event.stopPropagation();moveJobStageBack(${j.id})">←</button>`
    : '';
  // Mid-confirm: swap the whole foot row for the quantity-confirm card so
  // there's no ambiguity about what state the card is in — Cancel is the
  // only way back to the normal actions.
  const confirming = window.__packageConfirmJobId === j.id;
  const footRow = confirming
    ? packageConfirmCardHtml(j)
    : `<div class="kb-card-foot">${back}${skip}${finish}${cashJob}${foot}${reschedule}</div>`;
  return `<div class="kb-card${enter}" onclick="openEditJob(${j.id})">
    <div class="kb-card-top">
      <div class="kb-card-main">
        <div class="kb-card-title">${htmlEsc(who)}</div>
        <div class="kb-card-sub">${htmlEsc(svc)} · ${htmlEsc(amt)}${fmtDate(j.date) ? ' · ' + htmlEsc(fmtDate(j.date)) : ''}</div>
      </div>
      <button type="button" class="pl-edit" aria-label="Edit engagement" onclick="event.stopPropagation();openEditJob(${j.id})">✎</button>
    </div>
    ${footRow}
  </div>`;
}

// The single next-action per stage: complete the current stage and advance
// (following settings.stageOrder, NOT a hardcoded order).
function pipelineAction(jobId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  const stage = jobStage(j);
  if (stage === 'quote') {
    // docgen.js fires window.onEngagementQuoteCreated(docId, jobId) on save,
    // which links quoteDocId and advances. If cancelled, stage stays put.
    openQuoteForJob(j);
  } else if (stage === 'invoice') {
    if (typeof openInvoiceForm === 'function') {
      // invoices.js fires window.onEngagementInvoiceCreated(id, jobId) on create,
      // which links invoiceId and advances. If cancelled, stage stays put.
      openInvoiceForm(jobId);
    } else {
      advanceJobStage(jobId);
    }
  } else if (stage === 'paid') {
    markJobPaid(jobId);
  } else if (j.packageId != null && entersDeliveryOnAdvance(j)) {
    // Stop for a required quantity confirmation instead of advancing
    // immediately — this is the moment the job first counts against its
    // package, and a fixed "1 unit per job" assumption doesn't hold once
    // packages apply to every business type (12 pieces this drop-off, not
    // always 1). Cancelling leaves the stage exactly where it was, same as
    // the quote/invoice hooks above.
    window.__packageConfirmJobId = jobId;
    renderPipeline();
  } else {
    advanceJobStage(jobId);   // 'pitch', 'delivery', 'extend': just advance, no linked record
  }
}
window.pipelineAction = pipelineAction;

// ── Package quantity confirmation (required before a package-linked job
// can advance into Delivery) ──
window.__packageConfirmJobId = null;
function validatePackageConfirmQty(jobId, remaining) {
  const input = document.getElementById('pkg-confirm-qty-' + jobId);
  const errEl = document.getElementById('pkg-confirm-error-' + jobId);
  const saveBtn = document.getElementById('pkg-confirm-save-' + jobId);
  if (!input) return;
  const val = parseInt(input.value, 10);
  const over = isFinite(val) && val > remaining;
  const invalid = !(val > 0) || over;
  input.classList.toggle('blocked', over);
  if (errEl) {
    errEl.style.display = over ? 'flex' : 'none';
    if (over) errEl.textContent = t('confirm_overdraft_error').replace(/\{n\}/g, remaining);
  }
  if (saveBtn) saveBtn.classList.toggle('disabled', invalid);
}
window.validatePackageConfirmQty = validatePackageConfirmQty;
function cancelPackageConfirm() {
  window.__packageConfirmJobId = null;
  renderPipeline();
}
window.cancelPackageConfirm = cancelPackageConfirm;
async function confirmPackageDelivery(jobId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j || j.packageId == null) return;
  const pkg = packages.find(p => p.id === j.packageId);
  const remaining = pkg ? packageRemaining(pkg) : 0;
  const input = document.getElementById('pkg-confirm-qty-' + jobId);
  const val = input ? parseInt(input.value, 10) : NaN;
  if (!(val > 0) || val > remaining) { validatePackageConfirmQty(jobId, remaining); return; }
  j.count = val;
  await dbPut('jobs', j);
  window.__packageConfirmJobId = null;
  await advanceJobStage(jobId);
}
window.confirmPackageDelivery = confirmPackageDelivery;
function packageConfirmCardHtml(j) {
  const pkg = packages.find(p => p.id === j.packageId);
  if (!pkg) return '';
  const remaining = packageRemaining(pkg);
  const unit = packageUnitLabel();
  const prefill = j.count > 0 ? j.count : '';
  const prefillValid = prefill > 0 && prefill <= remaining;
  return `<div class="confirm-card" onclick="event.stopPropagation()">
      <div class="confirm-title">${htmlEsc(t('confirm_delivered_title').replace('{unit}', unit))}</div>
      <div class="confirm-context tnum">${htmlEsc(t('confirm_delivered_context').replace('{n}', remaining).replace('{total}', pkg.totalSessions).replace('{unit}', unit))}</div>
      <div class="confirm-input-row">
        <input type="number" class="confirm-input tnum" id="pkg-confirm-qty-${j.id}" min="1" value="${prefill}" oninput="event.stopPropagation();validatePackageConfirmQty(${j.id},${remaining})" onclick="event.stopPropagation()">
        <span class="confirm-unit">${htmlEsc(unit)}</span>
      </div>
      <div class="confirm-error" id="pkg-confirm-error-${j.id}" style="display:none"></div>
      <div class="confirm-btns">
        <button type="button" class="confirm-btn-cancel" onclick="event.stopPropagation();cancelPackageConfirm()">${htmlEsc(t('confirm_cancel'))}</button>
        <button type="button" class="confirm-btn-save${prefillValid ? '' : ' disabled'}" id="pkg-confirm-save-${j.id}" onclick="event.stopPropagation();confirmPackageDelivery(${j.id})">${htmlEsc(t('confirm_and_advance'))}</button>
      </div>
    </div>`;
}

async function advanceJobStage(jobId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  const order = jobOrder(j);
  const idx = order.indexOf(jobStage(j));
  if (idx < 0) { j.stage = order[0]; j.complete = false; }
  else if (idx >= order.length - 1) { j.stage = order[idx]; j.complete = true; j.outcome = 'extended'; }
  else { j.stage = order[idx + 1]; j.complete = false; }
  j.updatedAt = nowISO();
  logEvent('pipeline_stage:' + (j.complete ? (j.outcome || 'done') : j.stage));
  _pipelineActiveStage = j.stage;   // rail follows the card to wherever it just landed
  window.__kbMoved = jobId;
  await dbPut('jobs', j);
  await reload();
  renderPipeline();
}

// Skip the current stage's linked action (no quote/invoice document required) and
// just move the card forward, same mechanics as advanceJobStage — only exposed
// on stages flagged skippable (Quote, Invoice) since those are paperwork, not
// money-received checkpoints. Paid is never skippable: it's what Home's earnings
// stats are built on.
async function skipJobStage(jobId) {
  const j = jobs.find(x => x.id === jobId);
  if (j) logEvent('pipeline_stage_skipped:' + jobStage(j));
  await advanceJobStage(jobId);
}
window.skipJobStage = skipJobStage;

// Cash-job path: skip both Quote and Invoice in one tap and land straight on
// Paid — for a session paid in cash on the spot, neither document is ever
// needed. Still uses the job's own order (jobOrder(j)), same as everywhere
// else, so a Settings reorder never strands this on a stage that doesn't
// precede Paid in that particular job's chain.
async function cashJobPath(jobId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  const order = jobOrder(j);
  const paidIdx = order.indexOf('paid');
  const curIdx = order.indexOf(jobStage(j));
  if (paidIdx < 0 || curIdx < 0 || curIdx >= paidIdx) return;
  logEvent('pipeline_stage_skipped:cash_job');
  j.stage = order[paidIdx];
  j.complete = false;
  j.updatedAt = nowISO();
  _pipelineActiveStage = j.stage;
  window.__kbMoved = jobId;
  await dbPut('jobs', j);
  await reload();
  renderPipeline();
}
window.cashJobPath = cashJobPath;

// Alt completion for the Extend stage: the engagement is over without a renewal.
// Distinct from the primary "Mark extended" action so the completed badge (and
// the Insights pipeline-activity breakdown) can tell "extended" and "finished"
// engagements apart.
async function finishJobStage(jobId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  j.complete = true;
  j.outcome = 'finished';
  j.updatedAt = nowISO();
  logEvent('pipeline_stage:finished');
  _pipelineActiveStage = j.stage;
  window.__kbMoved = jobId;
  await dbPut('jobs', j);
  await reload();
  renderPipeline();
}
window.finishJobStage = finishJobStage;

// Move a card back one stage (or re-open a completed engagement at its final stage).
async function moveJobStageBack(jobId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  const order = jobOrder(j);
  const idx = order.indexOf(jobStage(j));
  if (idx > 0) { j.stage = order[idx - 1]; }            // step back one column
  else if (!jobComplete(j)) return;                     // already at the first stage, nothing to undo
  j.complete = false;
  j.outcome = null;   // stepping back out of a completed engagement clears its extended/finished outcome
  j.updatedAt = nowISO();
  _pipelineActiveStage = j.stage;   // rail follows the card back
  window.__kbMoved = jobId;
  await dbPut('jobs', j);
  await reload();
  renderPipeline();
}
window.moveJobStageBack = moveJobStageBack;

async function markJobPaid(jobId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  if (j.invoiceId != null) {
    try {
      const inv = await dbGet('invoices', j.invoiceId);
      if (inv) { inv.status = 'paid'; inv.updatedAt = nowISO(); await dbPut('invoices', inv); }
    } catch (e) { /* non-fatal */ }
  }
  if (typeof renderInvoices === 'function') renderInvoices();
  toast('Marked paid');
  // Paid -> Delivery is exactly the transition that first counts a job
  // against its package (see jobDelivered()/entersDeliveryOnAdvance()) — the
  // invoice side effect above always happens, but the stage advance itself
  // routes through the same required-confirm check as every other path
  // into Delivery, instead of duplicating the advance here unconditionally.
  if (j.packageId != null && entersDeliveryOnAdvance(j)) {
    window.__packageConfirmJobId = jobId;
    renderPipeline();
    return;
  }
  const order = jobOrder(j);
  const idx = order.indexOf(jobStage(j));
  if (idx >= order.length - 1) { j.complete = true; }
  else { j.stage = order[idx + 1]; j.complete = false; }
  j.updatedAt = nowISO();
  logEvent('pipeline_stage:' + (j.complete ? 'done' : j.stage));
  _pipelineActiveStage = j.stage;
  await dbPut('jobs', j);
  await reload();
  renderPipeline();
}

// Open the doc-gen quote flow prefilled from this session's customer + service.
function openQuoteForJob(j) {
  if (typeof openGenerateForm !== 'function') { toast('Quote generator unavailable'); return; }
  openGenerateForm('quote', {
    clientId: j.clientId != null ? j.clientId : null,
    clientName: j.client || '',
    fields: {
      clientId: j.clientId != null ? j.clientId : null,
      lineItems: [{ description: j.serviceName || unitWord(), qty: (j.count > 0 ? j.count : 1), unitPrice: Number(j.amount) || 0 }],
    },
  });
  // Mark this engagement pending AFTER opening (openGenerateForm clears it first);
  // docgen.js links quoteDocId + advances only on a successful save. Cancelling
  // leaves the stage untouched.
  window.__pendingQuoteJobId = j.id;
}

// Called by invoices.js after an invoice is created from a pipeline session.
window.onEngagementInvoiceCreated = async function (invoiceId, jobId) {
  if (jobId == null) return;
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  j.invoiceId = invoiceId;
  const order = jobOrder(j);
  const idx = order.indexOf(jobStage(j));
  if (idx >= 0 && idx < order.length - 1) { j.stage = order[idx + 1]; j.complete = false; }
  else if (idx >= order.length - 1) { j.complete = true; }
  j.updatedAt = nowISO();
  logEvent('pipeline_stage:' + (j.complete ? 'done' : j.stage));
  _pipelineActiveStage = j.stage;
  await dbPut('jobs', j);
  await reload();
  renderPipeline();
};

// Called by docgen.js after a quote document is saved from a pipeline session:
// link the doc, then advance that session's stage. Cancelling never reaches here.
window.onEngagementQuoteCreated = async function (docId, jobId) {
  if (jobId == null) return;
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  j.quoteDocId = docId;
  const order = jobOrder(j);
  const idx = order.indexOf(jobStage(j));
  if (idx >= 0 && idx < order.length - 1) { j.stage = order[idx + 1]; j.complete = false; }
  else if (idx >= order.length - 1) { j.complete = true; }
  j.updatedAt = nowISO();
  logEvent('pipeline_stage:' + (j.complete ? 'done' : j.stage));
  _pipelineActiveStage = j.stage;
  await dbPut('jobs', j);
  await reload();
  renderPipeline();
};

// ─── WORKFLOW SETTINGS (reorder only) ───────────────────────────────────
// All 6 stages are mandatory and always present, so this is just a reorder
// list — no add/remove toggle (there's no optional stage anymore).
function renderWorkflowControls() {
  const wrap = document.getElementById('workflow-body');
  if (!wrap) return;
  const order = getStageOrder();
  const rows = order.map((stage, i) => {
    const meta = STAGE_META[stage] || {};
    const label = (meta.label && t(meta.label)) || stage;
    return `<div class="wf-row">
      <span class="wf-ico">${meta.icon || ''}</span>
      <span class="wf-name">${htmlEsc(label)}</span>
      <span class="wf-btns">
        <button type="button" class="wf-move" aria-label="Move ${htmlEsc(label)} up" ${i === 0 ? 'disabled' : ''} onclick="wfMove(${i},-1)">↑</button>
        <button type="button" class="wf-move" aria-label="Move ${htmlEsc(label)} down" ${i === order.length - 1 ? 'disabled' : ''} onclick="wfMove(${i},1)">↓</button>
      </span>
    </div>`;
  }).join('');
  wrap.innerHTML = `<div class="wf-list">${rows}</div>`;
}
window.renderWorkflowControls = renderWorkflowControls;

async function wfMove(i, delta) {
  const order = getStageOrder();
  const j = i + delta;
  if (j < 0 || j >= order.length) return;
  const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  // 'paid' must never precede 'invoice'.
  if (order.indexOf('paid') < order.indexOf('invoice')) {
    toast('Payment must come after the invoice');
    return;   // revert: order is a local copy, nothing saved
  }
  await saveSetting('stageOrder', order);
  renderWorkflowControls();
  renderPipeline();
}
window.wfMove = wfMove;

// ─── CUSTOMERS (records only — history/stats are BACKLOG) ──────────────
// Gym trainer intake fields shown on every customer form.
const CUSTOMER_INTAKE = [{id:'healthNotes', key:'field_health'}, {id:'allergies', key:'field_allergies'}, {id:'goals', key:'field_goals'}];
function intakeFields() { return CUSTOMER_INTAKE; }
// Stable, permanent per-customer ID (never reassigned, never reused) — unlike
// the auto-increment DB `id`, this is the human-facing "Member ID" a trainer
// can reference on paperwork or when talking to the client. Sequential across
// this uid's whole customer list, never reset (unlike invoice numbers, which
// reset per year).
function nextMemberNo() {
  const prefix = 'SK-';
  let max = 0;
  customers.forEach(c => {
    if (typeof c.memberNo !== 'string') return;
    // Legacy 'M-' records are migrated to 'SK-' on boot (see enterApp()), but
    // backfillMemberNumbers() runs before that migration in the same boot —
    // scanning both prefixes here keeps the sequence collision-free either way.
    let seq = null;
    if (c.memberNo.indexOf(prefix) === 0) seq = parseInt(c.memberNo.slice(prefix.length), 10);
    else if (c.memberNo.indexOf('M-') === 0) seq = parseInt(c.memberNo.slice(2), 10);
    if (seq != null && isFinite(seq) && seq > max) max = seq;
  });
  return prefix + String(max + 1).padStart(4, '0');
}
// Shared year-scoped running document number (e.g. "INV-2026-0001",
// "QUO-2026-0001", "REC-2026-0001") — one implementation reused by every
// referable document type (invoices.js's own invoice numbering, and
// docgen.js's quote/receipt numbering) so they all behave identically and
// reset together each calendar year. `rows` should already be filtered to
// just the document type being numbered (so each type gets its own sequence).
function nextDocNumber(rows, prefix) {
  const year = todayISO().slice(0, 4);
  const p = `${prefix}-${year}-`;
  let max = 0;
  rows.forEach(r => {
    if (typeof r.number === 'string' && r.number.indexOf(p) === 0) {
      const seq = parseInt(r.number.slice(p.length), 10);
      if (isFinite(seq) && seq > max) max = seq;
    }
  });
  return p + String(max + 1).padStart(4, '0');
}
// One-time backfill for customers saved before this feature existed — assigns
// each a permanent Member ID in creation order so the whole list is covered
// immediately, not just customers the trainer happens to re-save later.
async function backfillMemberNumbers() {
  const missing = customers.filter(c => !c.memberNo).sort((a,b) => (a.id||0) - (b.id||0));
  for (const c of missing) {
    c.memberNo = nextMemberNo();
    await dbPut('clients', c);
  }
}
// "Needs attention" — an overdue invoice takes priority over a nearly-used
// package if a client somehow has both, since money owed is more urgent than
// a renewal offer. Packages apply to every business type now, same as the
// overdue-invoice half.
const PACKAGE_ALMOST_DONE_THRESHOLD = 2;
const PACKAGE_EXPIRY_WARNING_DAYS = 7;
async function computeClientsNeedingAttention() {
  const uid = isGuest ? 'guest' : currentUser.id;
  const todayStr = todayISO();
  const allInvoices = (await dbAll('invoices')).filter(i => i.uid === uid);
  const items = [];
  customers.forEach(c => {
    const overdue = allInvoices
      .filter(i => i.clientId === c.id && i.status !== 'paid' && i.dueDate && i.dueDate < todayStr)
      .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
    if (overdue.length) {
      const inv = overdue[0];
      const days = daysSinceISO(inv.dueDate);
      items.push({
        client: c,
        reason: `Invoice ${days} day${days === 1 ? '' : 's'} overdue · ${money(inv.clientPays)}`,
        actionLabel: t('remind_action'),
        action: () => remindAboutInvoice(inv.id),
      });
      return; // one attention item per client — overdue takes priority
    }
    {
      const pkg = activePackageFor(c.id);
      if (pkg) {
        const remaining = packageRemaining(pkg);
        const daysToExpiry = pkg.expiresAt ? -daysSinceISO(pkg.expiresAt) : null;
        // Expiring soon takes priority over merely "almost done" — a package
        // with plenty left that's about to be forfeited is the bigger risk
        // (real money about to be lost), not just a heads-up to plan ahead.
        if (remaining > 0 && daysToExpiry != null && daysToExpiry >= 0 && daysToExpiry <= PACKAGE_EXPIRY_WARNING_DAYS) {
          items.push({
            client: c,
            reason: `Package expires in ${daysToExpiry} day${daysToExpiry === 1 ? '' : 's'} · ${remaining} ${packageUnitLabel()} left`,
            actionLabel: t('offer_renewal_action'),
            action: () => offerRenewalForClient(c.id),
          });
        } else if (remaining > 0 && remaining <= PACKAGE_ALMOST_DONE_THRESHOLD) {
          items.push({
            client: c,
            reason: `Package almost done · ${remaining} ${packageUnitLabel()} left`,
            actionLabel: t('offer_renewal_action'),
            action: () => offerRenewalForClient(c.id),
          });
        }
      }
    }
  });
  return items;
}
function remindAboutInvoice(invoiceId) {
  switchScreen('invoices');
}
window.remindAboutInvoice = remindAboutInvoice;
function offerRenewalForClient(clientId) {
  openEditCustomer(clientId);
  togglePackageForm(true, clientId);
}
window.offerRenewalForClient = offerRenewalForClient;
window.__clientAttentionActions = [];
function needsAttentionRowHtml(item, idx) {
  const initial = (item.client.name || '?').charAt(0).toUpperCase();
  return `<div class="list-row" style="cursor:default">
      <div class="list-icon" style="background:var(--marigold-tint);color:var(--marigold-ink)">${htmlEsc(initial)}</div>
      <div class="list-main">
        <div class="list-title">${htmlEsc(item.client.name)}</div>
        <div class="list-sub">${item.reason}</div>
      </div>
      <div class="list-right"><button type="button" class="qc-btn" style="width:auto;padding:0 10px;color:var(--marigold-ink);font-size:12px;font-weight:700" onclick="window.__clientAttentionActions[${idx}]()">${htmlEsc(item.actionLabel)}</button></div>
    </div>`;
}
async function renderCustomers() {
  const wrap = document.getElementById('customers-body');
  if (!wrap) return;
  if (!customers.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-icon">👤</div>
      <p>${htmlEsc(t('no_customers'))}</p><span>${htmlEsc(t('no_customers_sub'))}</span></div>`;
    return;
  }
  const attention = await computeClientsNeedingAttention();
  window.__clientAttentionActions = attention.map(item => item.action);
  const attentionHtml = attention.length
    ? `<div class="section-title" style="font-size:12px;margin-bottom:8px">${htmlEsc(t('needs_attention_title'))}</div>
       <div class="list-card" style="margin-bottom:16px">${attention.map(needsAttentionRowHtml).join('')}</div>
       <div class="section-title" style="font-size:12px;margin-bottom:8px">${htmlEsc(t('all_clients_title'))}</div>`
    : '';
  wrap.innerHTML = attentionHtml + '<div class="list-card">' + customers.map(c => {
    const rest = c.company || c.phone || c.email || '';
    const sub = (c.memberNo ? `<span class="tnum">${htmlEsc(c.memberNo)}</span>` : '') + (c.memberNo && rest ? ' · ' : '') + htmlEsc(rest);
    const pkg = activePackageFor(c.id);
    const pkgBadge = pkg
      ? `<span class="pkg-badge">${packageRemaining(pkg)}/${htmlEsc(pkg.totalSessions)} left</span>` : '';
    return `<div class="list-row" onclick="openEditCustomer(${c.id})">
      <div class="list-icon">👤</div>
      <div class="list-main">
        <div class="list-title">${htmlEsc(c.name)}</div>
        <div class="list-sub">${sub}</div>
      </div>
      <div class="list-right">
        ${pkgBadge}
        <button type="button" class="qc-btn" title="Quick check-in" aria-label="Quick check-in for ${attrEsc(c.name)}" onclick="event.stopPropagation(); quickCheckIn(${c.id})">⚡</button>
        <span style="color:var(--text3);font-size:18px">›</span>
      </div>
    </div>`;
  }).join('') + '</div>';
}
function renderIntakeFields(c) {
  const wrap = document.getElementById('cust-intake');
  if (!wrap) return;
  wrap.innerHTML = intakeFields().map(f =>
    `<div class="field"><label for="ci-${f.id}">${htmlEsc(t(f.key))}</label>
      <input type="text" id="ci-${f.id}" value="${attrEsc(c[f.id] || '')}"></div>`).join('');
}

// ─── SESSION PACKAGES — shown within the Customer modal (edit mode only) ──
window.__pkgFormOpen = false;
function renderCustomerPackages(clientId) {
  const wrap = document.getElementById('cust-package-body');
  if (!wrap) return;
  const list = clientPackages(clientId);
  const active = activePackageFor(clientId);
  const unit = packageUnitLabel();
  let html = '';
  if (active) {
    const remaining = packageRemaining(active);
    const pct = active.totalSessions > 0 ? Math.round((remaining / active.totalSessions) * 100) : 0;
    const expiryLine = active.expiresAt ? `<div class="pkg-status-date">${htmlEsc(t('expires_label'))} ${htmlEsc(fmtDate(active.expiresAt))}</div>` : '';
    html += `<div class="pkg-status">
        <div class="pkg-status-row"><span>${remaining} ${htmlEsc(t('of_label'))} ${htmlEsc(active.totalSessions)} ${htmlEsc(unit)} ${htmlEsc(t('left_label'))}</span><span class="pkg-status-date">${htmlEsc(t('purchased_label'))} ${htmlEsc(fmtDate(active.purchasedDate))}</span></div>
        <div class="pkg-status-track"><div class="pkg-status-fill" style="width:${pct}%"></div></div>
        ${expiryLine}
      </div>`;
  } else if (list.length) {
    // "No units left" covers two different situations worth telling apart:
    // genuinely used up, vs. expired with a real balance forfeited — the
    // latter is confusing to read as "you used it all" when you didn't.
    const last = list[0];
    const rawRemaining = packageRemainingIgnoringExpiry(last);
    const msg = (packageIsExpired(last) && rawRemaining > 0)
      ? t('package_expired_forfeited').replace('{date}', fmtDate(last.expiresAt)).replace('{n}', rawRemaining).replace('{unit}', unit)
      : t('no_units_left').replace('{unit}', unit);
    html += `<div class="pkg-status"><span>${htmlEsc(msg)}</span></div>`;
  } else {
    html += `<div class="pkg-status"><span>${htmlEsc(t('no_package_yet'))}</span></div>`;
  }
  if (list.length > 1 || (list.length === 1 && !active)) {
    html += '<div class="list-card" style="margin-top:8px">' + list.map(p => {
      const rem = packageRemaining(p);
      const expSub = p.expiresAt ? ` · ${htmlEsc(t('expires_label'))} ${htmlEsc(fmtDate(p.expiresAt))}` : '';
      return `<div class="list-row" style="cursor:default">
          <div class="list-main"><div class="list-title">${htmlEsc(p.totalSessions)} ${htmlEsc(unit)}</div>
          <div class="list-sub">${htmlEsc(t('purchased_label'))} ${htmlEsc(fmtDate(p.purchasedDate))}${expSub}</div></div>
          <div class="list-right"><span class="list-amt tnum">${rem} ${htmlEsc(t('left_label'))}</span></div>
        </div>`;
    }).join('') + '</div>';
  }
  html += window.__pkgFormOpen ? `
      <div class="form-row" style="margin-top:10px">
        <div class="field-half"><label for="pkg-total">${htmlEsc(unit)}</label><input type="number" id="pkg-total" class="tnum" inputmode="numeric" min="1" placeholder="10"></div>
        <div class="field-half"><label for="pkg-price">${htmlEsc(t('field_price'))}</label><input type="number" id="pkg-price" class="tnum" inputmode="decimal" min="0" placeholder="0"></div>
      </div>
      <div class="form-row">
        <div class="field-half"><label for="pkg-date">${htmlEsc(t('purchased_label'))}</label><input type="date" id="pkg-date"></div>
        <div class="field-half"><label for="pkg-expires">${htmlEsc(t('expires_label'))}</label><input type="date" id="pkg-expires" placeholder="${attrEsc(t('expires_ph'))}"></div>
      </div>
      <button type="button" class="btn-submit" style="margin-top:6px" onclick="savePackage(${clientId})">${htmlEsc(t('save_package'))}</button>
    ` : `<button type="button" class="btn-submit" style="margin-top:10px" onclick="togglePackageForm(true, ${clientId})">${active ? htmlEsc(t('renew_package')) : htmlEsc(t('new_package'))}</button>`;
  wrap.innerHTML = html;
  if (window.__pkgFormOpen) {
    const dateEl = document.getElementById('pkg-date');
    if (dateEl && !dateEl.value) dateEl.value = todayISO();
  }
}
function togglePackageForm(open, clientId) {
  window.__pkgFormOpen = open;
  renderCustomerPackages(clientId);
}
window.togglePackageForm = togglePackageForm;
async function savePackage(clientId) {
  const total = parseInt(document.getElementById('pkg-total').value) || 0;
  const price = parseFloat(document.getElementById('pkg-price').value) || 0;
  const date = document.getElementById('pkg-date').value || todayISO();
  const expiresEl = document.getElementById('pkg-expires');
  const expiresAt = (expiresEl && expiresEl.value) || null;
  if (total <= 0) { toast(t('enter_package_total').replace('{unit}', packageUnitLabel())); return; }
  if (expiresAt && expiresAt < date) { toast(t('expiry_before_purchase')); return; }
  const uid = isGuest ? 'guest' : currentUser.id;
  const obj = { uid, clientId, totalSessions: total, price, purchasedDate: date, expiresAt, notes: '', cuid: cuid(), updatedAt: nowISO() };
  await dbAdd('packages', obj);
  if (!isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
    SidekickBackend.mirrorPackageSave(obj).catch(() => {});
  }
  window.__pkgFormOpen = false;
  await reload();
  renderCustomerPackages(clientId);
  toast(t('package_saved'));
}
window.savePackage = savePackage;

// ─── PROGRESS LOG — weight/notes over time, shown within the Customer modal ──
window.__progressFormOpen = false;
async function renderCustomerProgress(clientId) {
  const wrap = document.getElementById('cust-progress-body');
  if (!wrap) return;
  const uid = isGuest ? 'guest' : currentUser.id;
  const entries = (await dbAll('progressLogs')).filter(p => p.uid === uid && p.clientId === clientId)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.id || 0) - (a.id || 0));
  let html = '';
  if (!entries.length) {
    html += `<div class="pkg-status"><span>No entries yet.</span></div>`;
  } else {
    html += '<div class="list-card">' + entries.map((e, i) => {
      const prev = entries[i + 1];
      let delta = '';
      if (prev && e.weight != null && prev.weight != null) {
        const d = Number(e.weight) - Number(prev.weight);
        if (d !== 0) delta = ` <span class="${d > 0 ? 'progress-up' : 'progress-down'}">(${d > 0 ? '+' : ''}${fmt(d, 1)})</span>`;
      }
      return `<div class="list-row" style="cursor:default">
          <div class="list-main"><div class="list-title">${e.weight != null ? htmlEsc(fmt(e.weight, 1)) + ' kg' + delta : htmlEsc(fmtDate(e.date))}</div>
          <div class="list-sub">${e.weight != null ? htmlEsc(fmtDate(e.date)) + (e.notes ? ' · ' + htmlEsc(e.notes) : '') : htmlEsc(e.notes || '')}</div></div>
          <div class="list-right"><button type="button" class="qc-btn" aria-label="Delete entry" onclick="deleteProgressEntry(${e.id}, ${clientId})">✕</button></div>
        </div>`;
    }).join('') + '</div>';
  }
  html += window.__progressFormOpen ? `
      <div class="form-row" style="margin-top:10px">
        <div class="field-half"><label for="pl-date">Date</label><input type="date" id="pl-date"></div>
        <div class="field-half"><label for="pl-weight">Weight (kg)</label><input type="number" id="pl-weight" class="tnum" inputmode="decimal" min="0" step="0.1" placeholder="0"></div>
      </div>
      <div class="field"><label for="pl-notes">Notes</label><input type="text" id="pl-notes" placeholder="e.g. chest 96cm, waist 82cm"></div>
      <button type="button" class="btn-submit" style="margin-top:6px" onclick="saveProgressEntry(${clientId})">Save entry</button>
    ` : `<button type="button" class="btn-submit" style="margin-top:10px" onclick="toggleProgressForm(true, ${clientId})">+ Add entry</button>`;
  wrap.innerHTML = html;
  if (window.__progressFormOpen) {
    const dateEl = document.getElementById('pl-date');
    if (dateEl && !dateEl.value) dateEl.value = todayISO();
  }
}
function toggleProgressForm(open, clientId) {
  window.__progressFormOpen = open;
  renderCustomerProgress(clientId);
}
window.toggleProgressForm = toggleProgressForm;

// ─── CLIENT PERSONA TRACKER (redesign handoff, non-trainer business types) ──
// Trainer keeps its existing package + progress-log sections above (real,
// established features) — this is the registry for the other four. A
// deliberately lean first pass: a handful of auto-saving fields directly on
// the client record, not the full richness the design brief describes (a
// structured viewing log with verdicts, a real multi-policy list, full
// service history) — those are each their own small CRUD system, and
// building four of them in one pass wasn't realistic alongside everything
// else in this redesign. Real and useful, just simpler than the ideal.
async function saveClientField(clientId, field, value) {
  const c = customers.find(x => x.id === clientId);
  if (!c) return;
  c[field] = value;
  c.updatedAt = nowISO();
  await dbPut('clients', c);
}
window.saveClientField = saveClientField;

const PERSONA_TRACKER_TITLES = {
  trainer: 'tracker_mealplan_title',
  realestate: 'tracker_deal_title',
  laundry: 'tracker_order_title',
  insurance: 'tracker_policy_title',
  garage: 'tracker_vehicle_title',
};
// Generic list CRUD shared by every persona tracker's repeatable rows (meal
// plan, viewing log, service history) — each item just an object with its
// own cuid(), stored as an array field directly on the client record (no
// new IndexedDB store).
function addClientListItem(clientId, field, item) {
  const c = customers.find(x => x.id === clientId);
  if (!c) return;
  c[field] = c[field] || [];
  c[field].push({ id: cuid(), ...item });
  c.updatedAt = nowISO();
  return dbPut('clients', c).then(() => renderClientPersonaTracker(clientId));
}
window.addClientListItem = addClientListItem;
function deleteClientListItem(clientId, field, itemId) {
  const c = customers.find(x => x.id === clientId);
  if (!c) return;
  c[field] = (c[field] || []).filter(r => r.id !== itemId);
  c.updatedAt = nowISO();
  return dbPut('clients', c).then(() => renderClientPersonaTracker(clientId));
}
window.deleteClientListItem = deleteClientListItem;
// In-place edit of one field on one item within a client-list array (e.g. a
// single vehicle's plate/mileage) — the array-item counterpart to
// saveClientField() above, which only handles flat top-level client fields.
function saveClientListItemField(clientId, field, itemId, key, value) {
  const c = customers.find(x => x.id === clientId);
  if (!c) return;
  const item = (c[field] || []).find(r => r.id === itemId);
  if (!item) return;
  item[key] = value;
  c.updatedAt = nowISO();
  return dbPut('clients', c);
}
window.saveClientListItemField = saveClientListItemField;

function addMealPlanRow(clientId) {
  const input = document.getElementById('meal-plan-new-' + clientId);
  const text = ((input && input.value) || '').trim();
  if (!text) return;
  addClientListItem(clientId, 'mealPlan', { text });
  if (input) input.value = '';
}
window.addMealPlanRow = addMealPlanRow;

const VIEWING_VERDICTS = ['interested', 'maybe', 'passed'];
// A deal's own viewings are a nested array (deal.viewings), not a top-level
// client-list field — addClientListItem/deleteClientListItem/
// saveClientListItemField only reach c[field] directly, so these two are the
// deal-scoped equivalents, following the exact same shape.
function addDealViewing(clientId, dealId, viewing) {
  const c = customers.find(x => x.id === clientId);
  if (!c) return;
  const deal = (c.deals || []).find(d => d.id === dealId);
  if (!deal) return;
  deal.viewings = deal.viewings || [];
  deal.viewings.push({ id: cuid(), ...viewing });
  c.updatedAt = nowISO();
  return dbPut('clients', c).then(() => renderClientPersonaTracker(clientId));
}
window.addDealViewing = addDealViewing;
function deleteDealViewing(clientId, dealId, viewingId) {
  const c = customers.find(x => x.id === clientId);
  if (!c) return;
  const deal = (c.deals || []).find(d => d.id === dealId);
  if (!deal) return;
  deal.viewings = (deal.viewings || []).filter(v => v.id !== viewingId);
  c.updatedAt = nowISO();
  return dbPut('clients', c).then(() => renderClientPersonaTracker(clientId));
}
window.deleteDealViewing = deleteDealViewing;
function addViewingRowToDeal(clientId, dealId) {
  const date = (document.getElementById('viewing-date-' + dealId) || {}).value || '';
  const verdict = (document.getElementById('viewing-verdict-' + dealId) || {}).value || 'interested';
  addDealViewing(clientId, dealId, { date, verdict });
}
window.addViewingRowToDeal = addViewingRowToDeal;

function addServiceHistoryRow(clientId) {
  const date = (document.getElementById('svc-date-' + clientId) || {}).value || '';
  const noteEl = document.getElementById('svc-note-' + clientId);
  const note = ((noteEl && noteEl.value) || '').trim();
  if (!note) return;
  const vehicleEl = document.getElementById('svc-vehicle-' + clientId);
  const vehicleId = (vehicleEl && vehicleEl.value) || null;
  addClientListItem(clientId, 'serviceHistory', { date, note, vehicleId });
  if (noteEl) noteEl.value = '';
}
window.addServiceHistoryRow = addServiceHistoryRow;

// Sum of what a garage client has actually paid (amount+tip on jobs that
// reached the 'paid' stage or later) — a computed display stat, not stored,
// so it always reflects the live job list.
function clientLifetimeSpend(clientId) {
  const order = getStageOrder();
  const paidIdx = order.indexOf('paid');
  return jobs
    .filter(j => j.clientId === clientId && order.indexOf(jobStage(j)) >= paidIdx && paidIdx >= 0)
    .reduce((s, j) => s + (Number(j.amount) || 0) + (Number(j.tip) || 0), 0);
}

function listRowsHtml(rows, clientId, field, lineFn) {
  if (!rows || !rows.length) return '';
  return '<div class="list-card" style="margin-bottom:8px">' + rows.map(r => `
      <div class="list-row" style="cursor:default">
        <div class="list-main">${lineFn(r)}</div>
        <div class="list-right"><button type="button" class="qc-btn" aria-label="Delete" onclick="deleteClientListItem(${clientId},'${field}','${r.id}')">✕</button></div>
      </div>`).join('') + '</div>';
}

// A structured deal-stage pipeline, replacing the old flat activity log:
// each deal is one property pursuit moving through these stages, rather
// than one undifferentiated list of viewings across however many
// properties a client happens to be looking at.
const DEAL_STAGES = ['searching', 'viewing', 'offer', 'negotiating', 'closing', 'closed'];
// One-time, non-destructive: pre-deal-pipeline real estate clients had a flat
// searchBrief/offerStatus/estCommission per client plus one undifferentiated
// viewings[] log (no notion of which property a viewing was for, or where
// the deal stood). Folds them into a single deal[0] the first time this
// client's tracker renders: offerStatus becomes the deal's free-text notes
// (it was already free text, e.g. "Offer submitted, awaiting reply" — not a
// stage enum, so it can't map onto DEAL_STAGES automatically), estCommission
// becomes the deal's commission, and every existing viewing carries over
// as-is (its own `property` field dropped only going forward — see the
// render side below). searchBrief stays flat: it's the client's general
// search criteria, not any one deal's.
function migrateRealEstateDealsIfNeeded(c) {
  if (Array.isArray(c.deals)) return c.deals;
  const hadFlatFields = c.offerStatus || c.estCommission || (c.viewings && c.viewings.length);
  c.deals = hadFlatFields
    ? [{ id: cuid(), property: '', stage: 'searching', commission: c.estCommission || 0, notes: c.offerStatus || '', viewings: c.viewings || [] }]
    : [];
  delete c.offerStatus; delete c.estCommission; delete c.viewings;
  dbPut('clients', c);
  return c.deals;
}
// One-time, non-destructive: pre-multi-policy insurance clients had one flat
// policyName/policyRenewalDate per client (no second policy possible).
// Folds them into policies[0] the first time this client's tracker renders,
// then drops the flat fields so they can never drift out of sync with the
// new array — same treatment as migrateGarageVehiclesIfNeeded() below.
function migrateInsurancePoliciesIfNeeded(c) {
  if (Array.isArray(c.policies)) return c.policies;
  const hadFlatFields = c.policyName || c.policyRenewalDate;
  c.policies = hadFlatFields
    ? [{ id: cuid(), name: c.policyName || '', renewalDate: c.policyRenewalDate || '' }]
    : [];
  delete c.policyName; delete c.policyRenewalDate;
  dbPut('clients', c);
  return c.policies;
}
// One-time, non-destructive: pre-multi-vehicle garage clients had one flat
// vehiclePlate/vehicleMileage/nextServiceDate per client instead of a
// vehicles[] array. Folds them into vehicles[0] the first time this
// client's tracker renders, then drops the flat fields so they can never
// drift out of sync with the new array.
function migrateGarageVehiclesIfNeeded(c) {
  if (Array.isArray(c.vehicles)) return c.vehicles;
  const hadFlatFields = c.vehiclePlate || c.vehicleMileage || c.nextServiceDate;
  c.vehicles = hadFlatFields
    ? [{ id: cuid(), plate: c.vehiclePlate || '', mileage: c.vehicleMileage || 0, nextServiceDate: c.nextServiceDate || '' }]
    : [];
  delete c.vehiclePlate; delete c.vehicleMileage; delete c.nextServiceDate;
  dbPut('clients', c);
  return c.vehicles;
}
// One-time, non-destructive: pre-order-history laundry clients had one live
// orderStatus scalar and no history at all. Folds it into a single active
// order the first time this client's tracker renders, then drops the flat
// field so it can never drift out of sync with the new array.
function migrateLaundryOrdersIfNeeded(c) {
  if (Array.isArray(c.orders)) return c.orders;
  c.orders = c.orderStatus
    ? [{ id: cuid(), date: '', kg: 0, status: c.orderStatus, notes: '' }]
    : [];
  delete c.orderStatus;
  dbPut('clients', c);
  return c.orders;
}
// Closes out the current active order into history — a dedicated function
// (not an inline saveClientListItemField() call) because, unlike every
// other field edit on an order, this one needs the tracker to actually
// re-render: the "current order" editor disappears and the order moves
// into the read-only history list below it.
async function completeLaundryOrder(clientId, orderId) {
  await saveClientListItemField(clientId, 'orders', orderId, 'status', 'completed');
  renderClientPersonaTracker(clientId);
}
window.completeLaundryOrder = completeLaundryOrder;
function renderClientPersonaTracker(clientId) {
  const wrap = document.getElementById('cust-persona-body');
  const titleEl = document.getElementById('cust-persona-title');
  if (!wrap) return;
  const c = customers.find(x => x.id === clientId);
  if (!c) return;
  const bt = businessType();
  if (titleEl) titleEl.textContent = PERSONA_TRACKER_TITLES[bt] ? t(PERSONA_TRACKER_TITLES[bt]) : '';

  if (bt === 'trainer') {
    const rows = c.mealPlan || [];
    wrap.innerHTML = `
      ${listRowsHtml(rows, clientId, 'mealPlan', r => `<div class="list-title">${htmlEsc(r.text)}</div>`) || `<div class="pkg-status"><span>${htmlEsc(t('no_meal_plan_rows'))}</span></div>`}
      <div class="form-row" style="margin-top:8px">
        <input type="text" id="meal-plan-new-${clientId}" placeholder="${attrEsc(t('meal_plan_add_ph'))}" style="flex:1;padding:11px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card);color:var(--text);font-family:inherit;font-size:14px">
        <button type="button" class="qc-btn" style="width:auto;padding:0 14px" onclick="addMealPlanRow(${clientId})">${htmlEsc(t('btn_add'))}</button>
      </div>
    `;
  } else if (bt === 'realestate') {
    const deals = migrateRealEstateDealsIfNeeded(c);
    const dealHtml = d => {
      const viewingRows = (d.viewings || []).slice().reverse();
      return `<div class="list-card" style="margin-bottom:8px;padding:10px 14px">
          <div class="field"><label>${htmlEsc(t('field_viewing_property'))}</label><input type="text" value="${attrEsc(d.property || '')}" onchange="saveClientListItemField(${clientId},'deals','${d.id}','property',this.value)"></div>
          <div class="field"><label>${htmlEsc(t('field_deal_stage'))}</label><select onchange="saveClientListItemField(${clientId},'deals','${d.id}','stage',this.value)">
            ${DEAL_STAGES.map(s => `<option value="${s}"${s === d.stage ? ' selected' : ''}>${htmlEsc(t('deal_stage_' + s))}</option>`).join('')}
          </select></div>
          <div class="field"><label>${htmlEsc(t('field_est_commission'))}</label><input type="number" class="tnum" inputmode="decimal" min="0" value="${d.commission || ''}" onchange="saveClientListItemField(${clientId},'deals','${d.id}','commission',parseFloat(this.value)||0)"></div>
          <div class="field"><label>${htmlEsc(t('field_notes'))}</label><textarea rows="2" onchange="saveClientListItemField(${clientId},'deals','${d.id}','notes',this.value)">${htmlEsc(d.notes || '')}</textarea></div>
          <div class="section-title" style="font-size:11px;margin:10px 0 6px">${htmlEsc(t('viewing_log_title'))}</div>
          ${viewingRows.length ? '<div class="list-card" style="margin-bottom:8px">' + viewingRows.map(v => `
            <div class="list-row" style="cursor:default">
              <div class="list-main"><div class="list-sub">${v.date ? htmlEsc(fmtDate(v.date)) + ' · ' : ''}${htmlEsc(t('viewing_verdict_' + (v.verdict || 'interested')))}</div></div>
              <div class="list-right"><button type="button" class="qc-btn" aria-label="Delete" onclick="deleteDealViewing(${clientId},'${d.id}','${v.id}')">✕</button></div>
            </div>`).join('') + '</div>' : `<div class="pkg-status"><span>${htmlEsc(t('no_viewings'))}</span></div>`}
          <div class="form-row" style="margin-top:8px">
            <input type="date" id="viewing-date-${d.id}" style="flex:1;padding:11px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card);color:var(--text);font-family:inherit;font-size:14px">
            <select id="viewing-verdict-${d.id}" style="padding:11px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card);color:var(--text);font-family:inherit;font-size:14px">
              ${VIEWING_VERDICTS.map(v => `<option value="${v}">${htmlEsc(t('viewing_verdict_' + v))}</option>`).join('')}
            </select>
            <button type="button" class="qc-btn" style="width:auto;padding:0 14px" onclick="addViewingRowToDeal(${clientId},'${d.id}')">${htmlEsc(t('btn_add'))}</button>
          </div>
          <button type="button" class="qc-btn" style="width:100%;margin-top:8px;color:var(--overdue)" onclick="deleteClientListItem(${clientId},'deals','${d.id}')">${htmlEsc(t('delete_deal_btn'))}</button>
        </div>`;
    };
    wrap.innerHTML = `
      <div class="field"><label>${htmlEsc(t('field_search_brief'))}</label><textarea rows="2" onchange="saveClientField(${clientId},'searchBrief',this.value)">${htmlEsc(c.searchBrief || '')}</textarea></div>
      <div class="section-title" style="font-size:12px;margin:14px 0 8px">${htmlEsc(t('deals_title'))}</div>
      ${deals.length ? deals.map(dealHtml).join('') : `<div class="pkg-status"><span>${htmlEsc(t('no_deals'))}</span></div>`}
      <button type="button" class="qc-btn" style="width:100%" onclick="addClientListItem(${clientId},'deals',{property:'',stage:'searching',commission:0,notes:'',viewings:[]})">${htmlEsc(t('add_deal_btn'))}</button>
    `;
  } else if (bt === 'laundry') {
    const orders = migrateLaundryOrdersIfNeeded(c);
    const steps = ['received', 'washing', 'drying', 'ready'];
    const active = orders.find(o => o.status !== 'completed');
    const history = orders.filter(o => o.status === 'completed').slice().reverse();
    wrap.innerHTML = `
      <div class="section-title" style="font-size:12px;margin:0 0 8px">${htmlEsc(t('current_order_title'))}</div>
      ${active ? `
        <div class="pkg-status">
          <div class="field"><label>${htmlEsc(t('field_order_status'))}</label><select onchange="saveClientListItemField(${clientId},'orders','${active.id}','status',this.value)">
            ${steps.map(s => `<option value="${s}"${s === active.status ? ' selected' : ''}>${htmlEsc(t('order_step_' + s))}</option>`).join('')}
          </select></div>
          <div class="field"><label>${htmlEsc(t('field_order_date'))}</label><input type="date" value="${attrEsc(active.date || '')}" onchange="saveClientListItemField(${clientId},'orders','${active.id}','date',this.value)"></div>
          <div class="field"><label>${htmlEsc(t('field_order_kg'))}</label><input type="number" class="tnum" inputmode="decimal" min="0" value="${active.kg || ''}" onchange="saveClientListItemField(${clientId},'orders','${active.id}','kg',parseFloat(this.value)||0)"></div>
          <div class="field"><label>${htmlEsc(t('field_order_notes'))}</label><textarea rows="2" onchange="saveClientListItemField(${clientId},'orders','${active.id}','notes',this.value)">${htmlEsc(active.notes || '')}</textarea></div>
        </div>
        <button type="button" class="qc-btn" style="width:100%;margin-top:8px" onclick="completeLaundryOrder(${clientId},'${active.id}')">${htmlEsc(t('mark_picked_up_btn'))}</button>
      ` : `
        <div class="pkg-status"><span>${htmlEsc(t('no_active_order'))}</span></div>
        <button type="button" class="qc-btn" style="width:100%;margin-top:8px" onclick="addClientListItem(${clientId},'orders',{date:todayISO(),kg:0,status:'received',notes:''})">${htmlEsc(t('start_new_order_btn'))}</button>
      `}
      <div class="field" style="margin-top:14px"><label>${htmlEsc(t('field_monthly_kg_plan'))}</label><input type="number" class="tnum" inputmode="decimal" min="0" value="${c.monthlyKgPlan || ''}" onchange="saveClientField(${clientId},'monthlyKgPlan',parseFloat(this.value)||0)"></div>
      <div class="field"><label>${htmlEsc(t('field_preferences'))}</label><textarea rows="2" onchange="saveClientField(${clientId},'preferences',this.value)">${htmlEsc(c.preferences || '')}</textarea></div>
      <div class="section-title" style="font-size:12px;margin:14px 0 8px">${htmlEsc(t('order_history_title'))}</div>
      ${listRowsHtml(history, clientId, 'orders', r => `<div class="list-title">${htmlEsc(fmt(r.kg, 1))} kg</div><div class="list-sub">${[r.date ? htmlEsc(fmtDate(r.date)) : '', htmlEsc(r.notes || '')].filter(Boolean).join(' · ')}</div>`) || `<div class="pkg-status"><span>${htmlEsc(t('no_order_history'))}</span></div>`}
    `;
  } else if (bt === 'insurance') {
    const policies = migrateInsurancePoliciesIfNeeded(c);
    const countdownHtml = p => {
      if (!p.renewalDate) return '';
      const days = daysSinceISO(p.renewalDate);
      return days > 0
        ? `<div class="pkg-status"><span style="color:var(--overdue)">${days} ${days === 1 ? t('day_singular') : t('day_plural')} ${t('overdue_for_renewal')}</span></div>`
        : `<div class="pkg-status"><span>${-days} ${-days === 1 ? t('day_singular') : t('day_plural')} ${t('until_renewal')}</span></div>`;
    };
    wrap.innerHTML = `
      <div class="section-title" style="font-size:12px;margin:0 0 8px">${htmlEsc(t('policies_title'))}</div>
      ${policies.length ? policies.map(p => `
        <div class="list-card" style="margin-bottom:8px;padding:10px 14px">
          <div class="field"><label>${htmlEsc(t('field_policy_name'))}</label><input type="text" value="${attrEsc(p.name || '')}" onchange="saveClientListItemField(${clientId},'policies','${p.id}','name',this.value)"></div>
          <div class="field"><label>${htmlEsc(t('field_renewal_date'))}</label><input type="date" value="${attrEsc(p.renewalDate || '')}" onchange="saveClientListItemField(${clientId},'policies','${p.id}','renewalDate',this.value)"></div>
          ${countdownHtml(p)}
          <button type="button" class="qc-btn" style="width:100%;margin-top:6px;color:var(--overdue)" onclick="deleteClientListItem(${clientId},'policies','${p.id}')">${htmlEsc(t('delete_policy_btn'))}</button>
        </div>
      `).join('') : `<div class="pkg-status"><span>${htmlEsc(t('no_policies'))}</span></div>`}
      <button type="button" class="qc-btn" style="width:100%;margin-bottom:14px" onclick="addClientListItem(${clientId},'policies',{name:'',renewalDate:''})">${htmlEsc(t('add_policy_btn'))}</button>

      <div class="field"><label>${htmlEsc(t('field_birthday'))}</label><input type="date" value="${attrEsc(c.birthday || '')}" onchange="saveClientField(${clientId},'birthday',this.value)"></div>
      <div class="field"><label>${htmlEsc(t('field_referred_by'))}</label><input type="text" value="${attrEsc(c.referredBy || '')}" onchange="saveClientField(${clientId},'referredBy',this.value)"></div>
    `;
  } else if (bt === 'garage') {
    const vehicles = migrateGarageVehiclesIfNeeded(c);
    const rows = (c.serviceHistory || []).slice().reverse();
    const spend = clientLifetimeSpend(clientId);
    const vehicleLabel = v => v.plate || t('unnamed_vehicle');
    wrap.innerHTML = `
      <div class="section-title" style="font-size:12px;margin:0 0 8px">${htmlEsc(t('vehicles_title'))}</div>
      ${vehicles.length ? vehicles.map(v => `
        <div class="list-card" style="margin-bottom:8px;padding:10px 14px">
          <div class="form-row">
            <div class="field-half"><label>${htmlEsc(t('field_plate'))}</label><input type="text" value="${attrEsc(v.plate || '')}" onchange="saveClientListItemField(${clientId},'vehicles','${v.id}','plate',this.value)"></div>
            <div class="field-half"><label>${htmlEsc(t('field_mileage'))}</label><input type="number" class="tnum" inputmode="decimal" min="0" value="${v.mileage || ''}" onchange="saveClientListItemField(${clientId},'vehicles','${v.id}','mileage',parseFloat(this.value)||0)"></div>
          </div>
          <div class="field"><label>${htmlEsc(t('field_next_service_due'))}</label><input type="date" value="${attrEsc(v.nextServiceDate || '')}" onchange="saveClientListItemField(${clientId},'vehicles','${v.id}','nextServiceDate',this.value)"></div>
          <button type="button" class="qc-btn" style="width:100%;margin-top:6px;color:var(--overdue)" onclick="deleteClientListItem(${clientId},'vehicles','${v.id}')">${htmlEsc(t('delete_vehicle_btn'))}</button>
        </div>
      `).join('') : `<div class="pkg-status"><span>${htmlEsc(t('no_vehicles'))}</span></div>`}
      <button type="button" class="qc-btn" style="width:100%;margin-bottom:14px" onclick="addClientListItem(${clientId},'vehicles',{plate:'',mileage:0,nextServiceDate:''})">${htmlEsc(t('add_vehicle_btn'))}</button>

      <div class="pkg-status-row"><span>${htmlEsc(t('lifetime_spend_label'))}</span><span class="tnum">${htmlEsc(money(spend))}</span></div>
      <div class="section-title" style="font-size:12px;margin:14px 0 8px">${htmlEsc(t('service_history_title'))}</div>
      ${listRowsHtml(rows, clientId, 'serviceHistory', r => {
        const v = vehicles.find(x => x.id === r.vehicleId);
        const sub = [v ? vehicleLabel(v) : '', r.date ? fmtDate(r.date) : ''].filter(Boolean).join(' · ');
        return `<div class="list-title">${htmlEsc(r.note)}</div>${sub ? `<div class="list-sub">${htmlEsc(sub)}</div>` : ''}`;
      }) || `<div class="pkg-status"><span>${htmlEsc(t('no_service_history'))}</span></div>`}
      ${vehicles.length ? `<div class="form-row" style="margin-top:8px">
        <select id="svc-vehicle-${clientId}" style="flex:1;padding:11px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card);color:var(--text);font-family:inherit;font-size:14px">
          <option value="">${htmlEsc(t('svc_vehicle_none_option'))}</option>
          ${vehicles.map(v => `<option value="${v.id}">${htmlEsc(vehicleLabel(v))}</option>`).join('')}
        </select>
      </div>` : ''}
      <div class="form-row" style="margin-top:8px">
        <input type="date" id="svc-date-${clientId}" style="flex:1;padding:11px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card);color:var(--text);font-family:inherit;font-size:14px">
      </div>
      <div class="form-row" style="margin-top:8px">
        <input type="text" id="svc-note-${clientId}" placeholder="${attrEsc(t('field_service_note'))}" style="flex:1;padding:11px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card);color:var(--text);font-family:inherit;font-size:14px">
        <button type="button" class="qc-btn" style="width:auto;padding:0 14px" onclick="addServiceHistoryRow(${clientId})">${htmlEsc(t('btn_add'))}</button>
      </div>
    `;
  } else {
    wrap.innerHTML = '';
  }
}

// ─── SUB-TASKS, MILESTONES, TIME TRACKING (redesign handoff, client-side) ──
// All three live directly on the job record (subTasks[]/milestones[]/
// timeEntries[]) — no new IndexedDB store, matching "no backend needed" per
// the handoff's BACKEND-REQUIREMENTS.md. The 6-stage Task flow stays the
// spine; these live inside a job's own edit modal, never as extra columns.
function renderJobTracking(jobId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  renderSubTasks(jobId);
  renderMilestones(jobId);
  renderJobTimer(jobId);
}

// ── Sub-tasks ──
function renderSubTasks(jobId) {
  const wrap = document.getElementById('job-subtasks-body');
  if (!wrap) return;
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  const subs = j.subTasks || [];
  if (!subs.length) { wrap.innerHTML = `<div class="pkg-status"><span>${htmlEsc(t('no_subtasks'))}</span></div>`; return; }
  const done = subs.filter(s => s.done).length;
  wrap.innerHTML = `
    <div class="pkg-status-row" style="margin-bottom:8px"><span>${done} of ${subs.length} done</span></div>
    <div class="pkg-status-track" style="margin-bottom:10px"><div class="pkg-status-fill" style="width:${subs.length ? Math.round(done / subs.length * 100) : 0}%"></div></div>
    <div class="list-card">${subs.map(s => `
      <div class="list-row" style="cursor:pointer" onclick="toggleSubTask(${jobId},'${s.id}')">
        <input type="checkbox" style="width:20px;height:20px;flex-shrink:0;pointer-events:none" ${s.done ? 'checked' : ''}>
        <div class="list-main"><div class="list-title" style="${s.done ? 'text-decoration:line-through;color:var(--text3)' : ''}">${htmlEsc(s.text)}</div></div>
        <button type="button" class="qc-btn" aria-label="Delete sub-task" onclick="event.stopPropagation();deleteSubTask(${jobId},'${s.id}')">✕</button>
      </div>`).join('')}</div>
  `;
}
async function addSubTask(jobId) {
  jobId = parseInt(jobId, 10);
  const input = document.getElementById('job-subtask-new');
  const text = (input.value || '').trim();
  if (!text) return;
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  j.subTasks = j.subTasks || [];
  j.subTasks.push({ id: cuid(), text, done: false });
  await dbPut('jobs', j);
  input.value = '';
  input.focus();   // stay focused so adding several in a row doesn't need re-tapping the field
  renderJobTracking(jobId);
}
window.addSubTask = addSubTask;
async function toggleSubTask(jobId, subId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j || !j.subTasks) return;
  const s = j.subTasks.find(x => x.id === subId);
  if (!s) return;
  s.done = !s.done;
  await dbPut('jobs', j);
  renderJobTracking(jobId);
}
window.toggleSubTask = toggleSubTask;
async function deleteSubTask(jobId, subId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j || !j.subTasks) return;
  j.subTasks = j.subTasks.filter(x => x.id !== subId);
  await dbPut('jobs', j);
  renderJobTracking(jobId);
}
window.deleteSubTask = deleteSubTask;

// ── Milestone payments ──
// "Draft invoice" opens a pre-filled invoice form; the resulting invoiceId
// links back onto the milestone via window.onMilestoneInvoiceCreated below
// only once the invoice is actually saved (cancelling leaves the milestone
// untouched). Deliberately NOT routed through onEngagementInvoiceCreated /
// fromJobId — that hook also advances the Pipeline stage, which would be
// wrong here since a job can have several milestones before it's actually done.
window.__milestoneFormOpen = false;
function renderMilestones(jobId) {
  const wrap = document.getElementById('job-milestones-body');
  if (!wrap) return;
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  const subs = j.subTasks || [];
  const miles = j.milestones || [];
  let html = miles.length ? '<div class="list-card">' + miles.map(m => {
    const gate = subs.find(s => s.id === m.gatingSubTaskId);
    const ready = !gate || gate.done;
    return `<div class="list-row" style="cursor:default">
        <div class="list-main">
          <div class="list-title">${fmt(m.pct, 0)}% · ${htmlEsc(money(m.amount))}</div>
          <div class="list-sub">${gate ? htmlEsc(t('unlocks_with')) + htmlEsc(gate.text) : htmlEsc(t('no_gating_subtask'))}</div>
        </div>
        <div class="list-right">
          ${m.invoiceId != null
            ? `<span class="chip" style="background:var(--brand-tint);color:var(--brand)">${htmlEsc(t('time_invoiced_label'))}</span>`
            : ready
              ? `<button type="button" class="qc-btn" style="width:auto;padding:0 10px;color:var(--brand)" onclick="draftMilestoneInvoice(${jobId},'${m.id}')">${htmlEsc(t('draft_invoice'))}</button>`
              : `<span class="chip" style="background:var(--border);color:var(--text3)">${htmlEsc(t('milestone_locked'))}</span>`}
          <button type="button" class="qc-btn" aria-label="Delete milestone" onclick="deleteMilestone(${jobId},'${m.id}')">✕</button>
        </div>
      </div>`;
  }).join('') + '</div>' : `<div class="pkg-status"><span>${htmlEsc(t('no_milestones'))}</span></div>`;

  if (window.__milestoneFormOpen) {
    html += `
      <div class="form-row" style="margin-top:10px">
        <div class="field-half"><label for="ms-pct">%</label><input type="number" id="ms-pct" class="tnum" inputmode="decimal" min="0" max="100" placeholder="50"></div>
        <div class="field-half"><label for="ms-amount">${htmlEsc(t('ms_amount_label'))}</label><input type="number" id="ms-amount" class="tnum" inputmode="decimal" min="0" placeholder="0"></div>
      </div>
      <div class="field"><label for="ms-gate">${htmlEsc(t('ms_gate_label'))}</label>
        <select id="ms-gate"><option value="">${htmlEsc(t('ms_gate_none'))}</option>${subs.map(s => `<option value="${s.id}">${htmlEsc(s.text)}</option>`).join('')}</select>
      </div>
      <button type="button" class="btn-submit" style="margin-top:6px" onclick="saveMilestone(${jobId})">${htmlEsc(t('save_milestone'))}</button>
    `;
  }
  wrap.innerHTML = html;
}
function addMilestone(jobId) {
  window.__milestoneFormOpen = true;
  renderMilestones(parseInt(jobId, 10));
}
window.addMilestone = addMilestone;
async function saveMilestone(jobId) {
  const pct = parseFloat(document.getElementById('ms-pct').value) || 0;
  const amount = parseFloat(document.getElementById('ms-amount').value) || 0;
  const gatingSubTaskId = document.getElementById('ms-gate').value || null;
  if (amount <= 0) { toast('Enter the milestone amount'); return; }
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  j.milestones = j.milestones || [];
  j.milestones.push({ id: cuid(), pct, amount, gatingSubTaskId });
  await dbPut('jobs', j);
  window.__milestoneFormOpen = false;
  renderMilestones(jobId);
}
window.saveMilestone = saveMilestone;
async function deleteMilestone(jobId, msId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j || !j.milestones) return;
  j.milestones = j.milestones.filter(x => x.id !== msId);
  await dbPut('jobs', j);
  renderMilestones(jobId);
}
window.deleteMilestone = deleteMilestone;
function draftMilestoneInvoice(jobId, msId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  const m = (j.milestones || []).find(x => x.id === msId);
  if (!m) return;
  const client = customers.find(c => c.id === j.clientId);
  if (typeof openInvoiceForm !== 'function') return;
  openInvoiceForm(null, {
    clientId: j.clientId,
    clientName: (client && client.name) || j.client || '',
    lineItems: [{ description: `Milestone (${fmt(m.pct, 0)}%)`, qty: 1, unitPrice: m.amount }],
    linkMeta: { type: 'milestone', jobId, milestoneId: msId },
  });
}
window.draftMilestoneInvoice = draftMilestoneInvoice;

// Called by invoices.js only once a milestone-draft invoice is actually saved
// (never on cancel) — see invoices.js's file header for the linkMeta contract.
// Deliberately not routed through onEngagementInvoiceCreated: this must NOT
// advance the Pipeline stage, since a job can have several milestones before
// it's actually done.
window.onMilestoneInvoiceCreated = async function (invoiceId, jobId, milestoneId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j || !j.milestones) return;
  const m = j.milestones.find(x => x.id === milestoneId);
  if (!m) return;
  m.invoiceId = invoiceId;
  j.updatedAt = nowISO();
  await dbPut('jobs', j);
  renderMilestones(jobId);
};

// ── Time tracking + Focus mode ──
// One timer per job at a time (job.timerStartedAt, an ISO timestamp — null
// when nothing's running), persisted so it survives the modal being closed
// and reopened. Focus mode (the full-screen Pomodoro view) shares this same
// underlying timer state; it's a presentation, not a separate clock.
function unbilledMinutes(j) {
  return (j.timeEntries || []).filter(e => !e.invoiced).reduce((s, e) => s + (Number(e.minutes) || 0), 0);
}
function fmtHM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60), m = Math.round(totalMinutes % 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}
let _jobTimerTickHandle = null;
function renderJobTimer(jobId) {
  const wrap = document.getElementById('job-timer-body');
  if (!wrap) return;
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  clearInterval(_jobTimerTickHandle);
  const running = !!j.timerStartedAt;
  const unbilled = unbilledMinutes(j);
  const entries = j.timeEntries || [];

  const liveRow = () => {
    const el = document.getElementById('job-timer-live');
    if (el && j.timerStartedAt) {
      const mins = (Date.now() - new Date(j.timerStartedAt).getTime()) / 60000;
      el.textContent = fmtHM(unbilled + mins);
    }
  };

  wrap.innerHTML = `
    <div class="pkg-status">
      <div class="pkg-status-row"><span>${htmlEsc(t('unbilled_time'))}</span><span class="tnum" id="job-timer-live">${fmt(unbilled, 2)}</span></div>
    </div>
    <div class="form-row" style="margin-top:10px">
      <button type="button" class="btn-submit" style="flex:1" onclick="${running ? `stopJobTimer(${jobId})` : `startJobTimer(${jobId})`}">${htmlEsc(running ? t('stop_timer') : t('start_timer'))}</button>
      ${running ? `<button type="button" class="qc-btn" style="width:auto;padding:0 14px" onclick="openFocusMode(${jobId})">${htmlEsc(t('focus_mode_btn'))}</button>` : ''}
    </div>
    ${unbilled > 0 ? `<button type="button" class="btn-submit" style="margin-top:8px;background:var(--card);color:var(--brand);border:1.5px solid var(--border)" onclick="convertUnbilledToInvoice(${jobId})">${htmlEsc(t('add_unbilled_to_invoice'))}</button>` : ''}
    ${entries.length ? `<div class="list-card" style="margin-top:10px">${entries.slice().reverse().map(e => `
      <div class="list-row" style="cursor:default">
        <div class="list-main"><div class="list-title">${fmt((e.minutes||0)/60, 2)} h</div>
        <div class="list-sub">${htmlEsc(fmtDate((e.endedAt||'').slice(0,10)))}${e.invoiced ? ' · ' + htmlEsc(t('time_invoiced_label')) : ''}</div></div>
      </div>`).join('')}</div>` : ''}
  `;
  if (running) {
    liveRow();
    _jobTimerTickHandle = setInterval(liveRow, 1000);
  }
}
async function startJobTimer(jobId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j || j.timerStartedAt) return;
  j.timerStartedAt = new Date().toISOString();
  await dbPut('jobs', j);
  renderJobTracking(jobId);
}
window.startJobTimer = startJobTimer;
async function stopJobTimer(jobId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j || !j.timerStartedAt) return;
  const minutes = (Date.now() - new Date(j.timerStartedAt).getTime()) / 60000;
  j.timeEntries = j.timeEntries || [];
  if (minutes >= 1) j.timeEntries.push({ id: cuid(), minutes, startedAt: j.timerStartedAt, endedAt: new Date().toISOString(), invoiced: false });
  j.timerStartedAt = null;
  await dbPut('jobs', j);
  renderJobTracking(jobId);
}
window.stopJobTimer = stopJobTimer;
function convertUnbilledToInvoice(jobId) {
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  const minutes = unbilledMinutes(j);
  if (minutes <= 0) return;
  const client = customers.find(c => c.id === j.clientId);
  const svc = services.find(s => s.id === j.serviceId);
  const rate = (svc && Number(svc.rate)) || 0;
  const hours = minutes / 60;
  if (typeof openInvoiceForm !== 'function') return;
  // Snapshot exactly which entries are unbilled right now — marked invoiced
  // only once the invoice is actually saved (onUnbilledTimeInvoiceCreated
  // below), not a new entry that might get logged while the form is still open.
  const entryIds = (j.timeEntries || []).filter(e => !e.invoiced).map(e => e.id);
  openInvoiceForm(null, {
    clientId: j.clientId,
    clientName: (client && client.name) || j.client || '',
    lineItems: [{ description: 'Unbilled time', qty: Math.round(hours * 100) / 100, unitPrice: rate }],
    linkMeta: { type: 'unbilled', jobId, timeEntryIds: entryIds },
  });
}
window.convertUnbilledToInvoice = convertUnbilledToInvoice;

// Called by invoices.js only once an unbilled-time invoice is actually saved
// (never on cancel) — marks exactly the entries that were unbilled at
// draft-time, not whatever happens to be unbilled by the time save occurs.
// Same non-stage-advancing treatment as onMilestoneInvoiceCreated above.
window.onUnbilledTimeInvoiceCreated = async function (invoiceId, jobId, timeEntryIds) {
  const j = jobs.find(x => x.id === jobId);
  if (!j || !j.timeEntries) return;
  const ids = new Set(timeEntryIds || []);
  j.timeEntries.forEach(e => { if (ids.has(e.id)) { e.invoiced = true; e.invoiceId = invoiceId; } });
  j.updatedAt = nowISO();
  await dbPut('jobs', j);
  renderJobTracking(jobId);
};

// Focus mode — full-screen Pomodoro view over whichever job's timer is
// running. Ring is 25:00 counting down purely for pacing; hitting 0 just
// wraps back to 25:00 rather than doing anything to the real timer.
const FOCUS_DURATION_SEC = 25 * 60;
let _focusJobId = null, _focusTickHandle = null, _focusPaused = false, _focusPauseStartedAt = null, _focusRingStartedAt = null;
function openFocusMode(jobId) {
  _focusJobId = jobId;
  _focusPaused = false;
  _focusRingStartedAt = Date.now();
  document.getElementById('focus-overlay').classList.add('open');
  document.getElementById('focus-pause-btn').textContent = t('focus_pause');
  _focusTickHandle = setInterval(focusTick, 250);
  focusTick();
}
window.openFocusMode = openFocusMode;
function focusTick() {
  const j = jobs.find(x => x.id === _focusJobId);
  if (!j || !j.timerStartedAt) { closeFocusMode(); return; }
  if (!_focusPaused) {
    const ringElapsed = Math.floor((Date.now() - _focusRingStartedAt) / 1000) % FOCUS_DURATION_SEC;
    const remaining = FOCUS_DURATION_SEC - ringElapsed;
    document.getElementById('focus-ring-time').textContent = fmtMinSec(remaining);
    const pct = Math.round((1 - remaining / FOCUS_DURATION_SEC) * 360);
    document.getElementById('focus-ring').style.background = `conic-gradient(var(--marigold) ${pct}deg, color-mix(in srgb, var(--marigold) 18%, transparent) 0)`;
  }
  const unbilled = unbilledMinutes(j);
  const liveMin = (Date.now() - new Date(j.timerStartedAt).getTime()) / 60000;
  document.getElementById('focus-billable-time').textContent = fmtHM(unbilled + liveMin);
}
function fmtMinSec(totalSeconds) {
  const m = Math.floor(totalSeconds / 60), s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function toggleFocusPause() {
  _focusPaused = !_focusPaused;
  document.getElementById('focus-pause-btn').textContent = _focusPaused ? t('focus_resume') : t('focus_pause');
  if (!_focusPaused) _focusRingStartedAt = Date.now(); // resume ring pacing from here, not where it left off
}
window.toggleFocusPause = toggleFocusPause;
function closeFocusMode() {
  clearInterval(_focusTickHandle);
  document.getElementById('focus-overlay').classList.remove('open');
  if (_focusJobId != null) renderJobTracking(_focusJobId);
  _focusJobId = null;
}
window.closeFocusMode = closeFocusMode;
function stopFocusMode() {
  const jobId = _focusJobId;
  closeFocusMode();
  if (jobId != null) stopJobTimer(jobId);
}
window.stopFocusMode = stopFocusMode;

async function saveProgressEntry(clientId) {
  const date = document.getElementById('pl-date').value || todayISO();
  const weightVal = document.getElementById('pl-weight').value;
  const weight = weightVal !== '' ? parseFloat(weightVal) : null;
  const notes = (document.getElementById('pl-notes').value || '').trim();
  if (weight == null && !notes) { toast('Enter a weight or a note'); return; }
  const uid = isGuest ? 'guest' : currentUser.id;
  const obj = { uid, clientId, date, weight, notes, cuid: cuid(), updatedAt: nowISO() };
  await dbAdd('progressLogs', obj);
  if (!isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
    SidekickBackend.mirrorProgressLogSave(obj).catch(() => {});
  }
  window.__progressFormOpen = false;
  await renderCustomerProgress(clientId);
  toast('Entry saved');
}
window.saveProgressEntry = saveProgressEntry;
async function deleteProgressEntry(id, clientId) {
  if (!confirm('Delete this entry?')) return;
  const prev = await dbGet('progressLogs', id);
  await dbDel('progressLogs', id);
  if (!isGuest && prev && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
    SidekickBackend.mirrorProgressLogDelete(prev.cuid).catch(() => {});
  }
  await renderCustomerProgress(clientId);
}
window.deleteProgressEntry = deleteProgressEntry;

// ─── QUICK SESSION CHECK-IN — one-tap log for a recurring client ──────────
// Reuses the client's most recent session's service/amount so a routine
// repeat visit doesn't need the full Add Session form; goes straight to the
// Delivery stage (skipping Pitch/Quote/Invoice/Paid) since this is a repeat
// client, not a new sale, and auto-applies their active package if they have
// one — this IS the "did the package session happen" moment those exist for.
async function quickCheckIn(clientId) {
  const c = customers.find(x => x.id === clientId);
  if (!c) return;
  const uid = isGuest ? 'guest' : currentUser.id;
  const priorJobs = jobs.filter(j => j.clientId === clientId)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const last = priorJobs[0];
  const order = getStageOrder();
  const pkg = activePackageFor(clientId);
  const job = {
    uid, date: todayISO(), client: c.name, clientId: c.id,
    serviceId: last ? last.serviceId : null, serviceName: last ? last.serviceName : '',
    jobType: settings.workType || '',
    amount: last ? last.amount : 0, tip: 0, expense: 0, count: 1, notes: '',
    netAmount: last ? last.amount : 0,
    cuid: cuid(), stageOrder: order, stage: 'delivery', complete: false,
    invoiceId: null, quoteDocId: null,
    packageId: pkg ? pkg.id : null,
    updatedAt: nowISO(),
  };
  await dbAdd('jobs', job);
  logEvent('quick_checkin');
  await reload();
  toast(`Checked in ${c.name}`);
}
window.quickCheckIn = quickCheckIn;

function openCustomerModal() { document.getElementById('modal-customer').classList.add('open'); }
// Always resets the pending job->customer link flag: cancelling (or clicking
// outside) the "add a new client" flow started from the session form must not
// leave a stale flag that could mis-link some unrelated later save.
function closeCustomerModal() { window.__pendingJobCustomerLink = false; document.getElementById('modal-customer').classList.remove('open'); }
function openAddCustomer() {
  document.getElementById('cust-modal-title').textContent = t('add_customer');
  document.getElementById('c-edit-id').value = '';
  ['c-name','c-phone','c-email','c-tags','c-notes','c-taxid','c-billing'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  const memberNoEl = document.getElementById('c-memberno');
  if (memberNoEl) memberNoEl.value = t('assigned_on_save');
  renderIntakeFields({});
  // Package/progress/persona tracking all need a saved client id to attach
  // records to — hidden on Add, shown once the client actually exists
  // (openEditCustomer).
  document.getElementById('cust-package-section').style.display = 'none';
  document.getElementById('cust-progress-section').style.display = 'none';
  document.getElementById('cust-persona-section').style.display = 'none';
  document.getElementById('c-delete').style.display = 'none';
  clearFieldErrors();
  openCustomerModal();
}
function openEditCustomer(id) {
  const c = customers.find(x => x.id === id);
  if (!c) return;
  document.getElementById('cust-modal-title').textContent = t('edit_customer');
  document.getElementById('c-edit-id').value = String(id);
  const set = (i,v)=>{ const el=document.getElementById(i); if(el) el.value = (v==null?'':v); };
  set('c-name', c.name); set('c-phone', c.phone); set('c-email', c.email);
  set('c-tags', c.tags); set('c-notes', c.notes); set('c-taxid', c.taxId); set('c-billing', c.billingAddress);
  set('c-memberno', c.memberNo || t('assigned_on_save'));
  renderIntakeFields(c);
  window.__pkgFormOpen = false; window.__progressFormOpen = false;
  // Packages apply to every business type (any persona can sell "N units"
  // up front — sessions, pieces, policies, whatever packageUnitLabel() is
  // set to). The weight/measurement progress log stays trainer-only — a
  // different, unrelated feature this generalization doesn't touch. Every
  // persona also gets its own tracker section below (see the registry
  // above renderClientPersonaTracker()).
  const isTrainer = businessType() === 'trainer';
  const isCustom = businessType() === 'custom';
  document.getElementById('cust-package-section').style.display = 'block';
  document.getElementById('cust-progress-section').style.display = isTrainer ? 'block' : 'none';
  // 'custom' has no persona-specific tracker (see PERSONA_TRACKER_TITLES) —
  // hide the section entirely rather than render it empty.
  document.getElementById('cust-persona-section').style.display = isCustom ? 'none' : 'block';
  renderCustomerPackages(id);
  if (isTrainer) renderCustomerProgress(id);
  if (!isCustom) renderClientPersonaTracker(id);
  document.getElementById('c-delete').style.display = 'block';
  clearFieldErrors();
  openCustomerModal();
}
async function saveCustomer() {
  const name = (document.getElementById('c-name').value || '').trim();
  clearFieldErrors();
  if (!name) { markFieldError('c-name', 'err_name_required'); return; }
  const uid = isGuest ? 'guest' : currentUser.id;
  const editId = document.getElementById('c-edit-id').value;
  const prev = editId ? customers.find(c => c.id === parseInt(editId)) : null;
  if (editId && !prev) return;
  // Plan client cap (Phase 1) — only ever blocks a brand-new client, never
  // an edit to one that already exists (so nobody's existing data becomes
  // unreachable just for going over a cap after the fact). No-op (Infinity)
  // for guest/local-only/unlimited-plan accounts — see planClientCap().
  if (!prev && customers.length >= planClientCap()) {
    toast(t('client_cap_reached'));
    return;
  }
  const obj = {
    ...(prev || {}),
    uid, name,
    phone: (document.getElementById('c-phone').value || '').trim(),
    email: (document.getElementById('c-email').value || '').trim(),
    tags: (document.getElementById('c-tags').value || '').trim(),
    notes: (document.getElementById('c-notes').value || '').trim(),
    taxId: (document.getElementById('c-taxid').value || '').trim(),
    billingAddress: (document.getElementById('c-billing').value || '').trim(),
  };
  intakeFields().forEach(f => { const el = document.getElementById('ci-'+f.id); obj[f.id] = el ? el.value.trim() : ''; });
  if (prev) {
    obj.id = prev.id; obj.cuid = prev.cuid || cuid();
    obj.memberNo = prev.memberNo || nextMemberNo();   // legacy record predating this feature
  } else {
    obj.cuid = cuid();
    obj.memberNo = nextMemberNo();
  }
  obj.updatedAt = nowISO();
  const linkToJob = !!window.__pendingJobCustomerLink && !prev;
  const newId = await dbPut('clients', obj);
  if (!prev) logEvent('client_added');
  // Best-effort cloud-backup mirror (Phase 1 of the local->backend
  // migration) — local IndexedDB above is already the write of record by
  // this point, so a mirror failure here never blocks or reverts the save.
  if (!isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
    SidekickBackend.mirrorClientSave(obj).catch(() => {});
  }
  closeCustomerModal();
  await reload();
  toast(t('customer_saved'));
  if (linkToJob) {
    const linkedId = obj.id != null ? obj.id : newId;
    populateJobSelects(linkedId, document.getElementById('j-service')?.value || '');
  }
}
async function deleteCustomer() {
  const editId = document.getElementById('c-edit-id').value;
  if (!editId) return;
  if (!confirm(t('delete_customer_confirm'))) return;
  const prev = customers.find(c => c.id === parseInt(editId));
  await dbDel('clients', parseInt(editId));
  if (prev && prev.cuid && !isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
    SidekickBackend.mirrorClientDelete(prev.cuid).catch(() => {});
  }
  closeCustomerModal();
  await reload();
  toast(t('customer_deleted'));
}

// ─── SERVICES (catalog + default rates) ───────────────────────────────
// Default services seeded once per business type (editable/deletable after).
// Numbers are currency-agnostic. Flag is keyed per type so switching
// Settings ▸ Business type later can seed that type's defaults too, without
// re-seeding (or touching) whatever the user already has.
async function seedServicesIfEmpty() {
  const bt = businessType();
  const flag = 'servicesSeeded_' + bt;
  if (settings[flag]) return;                       // already seeded for this type
  const uid = isGuest ? 'guest' : currentUser.id;
  const existing = (await dbAll('services')).filter(s => s.uid === uid);
  if (existing.length) { await saveSetting(flag, true); return; }   // never overwrite user data
  for (const [name, rate, unit] of BUSINESS_TYPES[bt].seedServices) {
    await dbAdd('services', {uid, name, rate, unit, cuid: cuid(), updatedAt: nowISO()});
  }
  await saveSetting(flag, true);
  await reload();
}
function renderServices() {
  const wrap = document.getElementById('services-body');
  if (!wrap) return;
  if (!services.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-icon">🏷️</div>
      <p>${htmlEsc(t('no_services'))}</p><span>${htmlEsc(t('no_services_sub'))}</span></div>`;
    return;
  }
  wrap.innerHTML = '<div class="list-card">' + services.map(s => `
    <div class="list-row" onclick="openEditService(${s.id})">
      <div class="list-icon">🏷️</div>
      <div class="list-main">
        <div class="list-title">${htmlEsc(s.name)}</div>
        <div class="list-sub">${htmlEsc(s.unit || '')}</div>
      </div>
      <div class="list-right"><div class="list-amt tnum">${htmlEsc(money(s.rate))}</div></div>
    </div>`).join('') + '</div>';
}
function openServiceModal() { document.getElementById('modal-service').classList.add('open'); }
function closeServiceModal() { window.__pendingJobServiceLink = false; document.getElementById('modal-service').classList.remove('open'); }
function openAddService() {
  document.getElementById('svc-modal-title').textContent = t('add_service');
  document.getElementById('sv-edit-id').value = '';
  ['sv-name','sv-rate','sv-unit'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('sv-usage-qty').value = '1';
  document.getElementById('sv-delete').style.display = 'none';
  clearFieldErrors();
  openServiceModal();
}
function openEditService(id) {
  const s = services.find(x => x.id === id);
  if (!s) return;
  document.getElementById('svc-modal-title').textContent = t('edit_service');
  document.getElementById('sv-edit-id').value = String(id);
  const set = (i,v)=>{ const el=document.getElementById(i); if(el) el.value = (v==null?'':v); };
  set('sv-name', s.name); set('sv-rate', s.rate); set('sv-unit', s.unit);
  set('sv-usage-qty', s.usageQty > 0 ? s.usageQty : 1);
  document.getElementById('sv-delete').style.display = 'block';
  clearFieldErrors();
  openServiceModal();
}
async function saveService() {
  const name = (document.getElementById('sv-name').value || '').trim();
  clearFieldErrors();
  if (!name) { markFieldError('sv-name', 'err_name_required'); return; }
  const rate = parseFloat(document.getElementById('sv-rate').value) || 0;
  const unit = (document.getElementById('sv-unit').value || '').trim();
  const usageQty = parseInt(document.getElementById('sv-usage-qty').value, 10) || 1;
  const uid = isGuest ? 'guest' : currentUser.id;
  const obj = {uid, name, rate, unit, usageQty};
  const editId = document.getElementById('sv-edit-id').value;
  if (editId) {
    const id = parseInt(editId);
    const prev = services.find(s => s.id === id);
    if (!prev) return;
    obj.id = id; obj.cuid = prev.cuid || cuid();
  } else { obj.cuid = cuid(); }
  obj.updatedAt = nowISO();
  const linkToJob = !!window.__pendingJobServiceLink && !editId;
  const key = await dbPut('services', obj);
  if (obj.id == null) obj.id = key;
  if (!isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
    SidekickBackend.mirrorServiceSave(obj).catch(() => {});
  }
  closeServiceModal();
  await reload();
  toast(t('service_saved'));
  if (linkToJob) {
    populateJobSelects(document.getElementById('j-customer')?.value || '', obj.id);
    onJobServiceChange(String(obj.id));
  }
}
async function deleteService() {
  const editId = document.getElementById('sv-edit-id').value;
  if (!editId) return;
  if (!confirm(t('delete_service_confirm'))) return;
  const id = parseInt(editId);
  const prev = services.find(s => s.id === id);
  await dbDel('services', id);
  if (!isGuest && prev && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
    SidekickBackend.mirrorServiceDelete(prev.cuid).catch(() => {});
  }
  closeServiceModal();
  await reload();
  toast(t('service_deleted'));
}

// ─── SETTINGS ─────────────────────────────────────────────────────────
async function saveSetting(key, val) {
  settings[key] = val;
  const prefix = isGuest ? 'guest:' : (currentUser.id + ':');
  await dbPut('settings', {key: prefix + key, value: val});
  if (!isGuest && typeof SidekickBackend !== 'undefined' && SidekickBackend.isEnabled()) {
    SidekickBackend.mirrorSettingSave(prefix + key, val).catch(() => {});
  }
  if (key === 'lang') localStorage.setItem('sidekick_ui_lang', val);
}
async function onCurrencyChange(v) { await saveSetting('currency', v); applyLang(); }
// Switching business type never touches existing services/clients — only
// changes the unit word, seeds that type's defaults if the account has no
// services at all yet, and swaps which tracker card renders on a client.
async function onBusinessTypeChange(v) {
  if (!BUSINESS_TYPES[v]) return;
  // Re-seed the package unit label to the new type's default, but only if it
  // was never customized away from the old type's default — an explicit
  // "Pieces" a laundry account typed in shouldn't silently flip back on a
  // later persona switch.
  const oldDefault = PACKAGE_UNIT_DEFAULTS[businessType()];
  if (!settings.packageUnitLabel || settings.packageUnitLabel === oldDefault) {
    await saveSetting('packageUnitLabel', PACKAGE_UNIT_DEFAULTS[v] || 'Units');
    const el = document.getElementById('set-package-unit');
    if (el) el.value = packageUnitLabel();
  }
  await saveSetting('businessType', v);
  document.body.setAttribute('data-work-type', v);
  await seedServicesIfEmpty();
  applyLang();
  renderHome();
}
async function onPackageUnitLabelChange(v) {
  await saveSetting('packageUnitLabel', (v || '').trim() || PACKAGE_UNIT_DEFAULTS[businessType()] || 'Units');
}
async function onLangChange(v) { await saveSetting('lang', v === 'th' ? 'th' : 'en'); applyLang(); }
async function onWhtChange(v) { const n = parseFloat(v); await saveSetting('wht', isNaN(n)?null:n); }
async function onVatChange(v) { const n = parseFloat(v); await saveSetting('vat', isNaN(n)?null:n); }
async function onPageSizeChange(v) { await saveSetting('docPageSize', v === 'A5' ? 'A5' : 'A4'); }
// Shared by invoices.js/docgen.js's print flows so both document types honor
// the same Settings ▸ Preferences ▸ "Document page size" choice.
function docPageSizeCss() {
  const size = (typeof settings !== 'undefined' && settings && settings.docPageSize === 'A5') ? 'A5' : 'A4';
  const margin = size === 'A5' ? '10mm' : '16mm';
  return `@page{ size: ${size}; margin: ${margin}; }`;
}
window.docPageSizeCss = docPageSizeCss;
// ─── PAYMENT CHANNELS (Settings) ──────────────────────────────────────
// Generalizes the old single "PromptPay ID" field into a saved list of
// payment methods — only 'promptpay' ever renders a scannable QR
// (invoices.js); the rest are shown to clients as plain reference text.
// Legacy single-field installs are migrated once in enterApp().
const PAYMENT_CHANNEL_TYPES = {
  promptpay: { label: 'PromptPay', detailLabel: 'PromptPay ID', ph: 'Phone or 13-digit national ID' },
  bank:      { label: 'Bank transfer', detailLabel: 'Account details', ph: 'Bank name, account number, account name' },
  cash:      { label: 'Cash', detailLabel: 'Note (optional)', ph: 'e.g. Pay in cash at the session' },
  other:     { label: 'Other', detailLabel: 'Instructions', ph: 'Payment instructions' },
};
const PAYMENT_CHANNEL_ICONS = {
  promptpay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M15 15h2.5v2.5H15zM19.5 15V19M15 19.5h2M19.5 19.5h1.5"/></svg>',
  bank:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em"><path d="M3 10l9-7 9 7"/><path d="M4 10v10M20 10v10M9 10v10M15 10v10"/><path d="M2 20h20"/></svg>',
  cash:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 9h.01M18 15h.01"/></svg>',
  other:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em"><path d="M20.6 13.4L11 3.8A2 2 0 0 0 9.5 3H4a1 1 0 0 0-1 1v5.5c0 .5.2 1 .6 1.4l9.6 9.6a2 2 0 0 0 2.8 0l4.4-4.4a2 2 0 0 0 .2-2.7z"/><circle cx="7.5" cy="7.5" r="1.3"/></svg>',
};
let editingPaymentChannelId = null;

function paymentChannels() { return Array.isArray(settings.paymentChannels) ? settings.paymentChannels : []; }

function renderPaymentChannels() {
  const wrap = document.getElementById('payment-channels-list');
  if (!wrap) return;
  const chans = paymentChannels();
  if (!chans.length) {
    wrap.innerHTML = `<div class="empty" style="padding:20px 12px">
        <p style="font-size:13px;font-weight:700">${htmlEsc(t('no_payment_channels'))}</p>
        <span style="font-size:12px">${htmlEsc(t('no_payment_channels_sub'))}</span>
      </div>`;
    return;
  }
  wrap.innerHTML = '<div class="list-card">' + chans.map(c => {
    const meta = PAYMENT_CHANNEL_TYPES[c.type] || PAYMENT_CHANNEL_TYPES.other;
    return `<div class="list-row" onclick="openEditPaymentChannel('${c.id}')">
        <div class="list-icon">${PAYMENT_CHANNEL_ICONS[c.type] || PAYMENT_CHANNEL_ICONS.other}</div>
        <div class="list-main">
          <div class="list-title">${htmlEsc(c.label || meta.label)}</div>
          <div class="list-sub">${htmlEsc(c.detail || '—')}</div>
        </div>
      </div>`;
  }).join('') + '</div>';
}

function openAddPaymentChannel() {
  editingPaymentChannelId = null;
  buildPaymentChannelModal({ type: 'promptpay', label: '', detail: '' }, false);
}
function openEditPaymentChannel(id) {
  const c = paymentChannels().find(x => x.id === id);
  if (!c) return;
  editingPaymentChannelId = id;
  buildPaymentChannelModal(c, true);
}
function buildPaymentChannelModal(v, isEdit) {
  closePaymentChannelModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-paychannel';
  const typeOpts = Object.keys(PAYMENT_CHANNEL_TYPES).map(k =>
    `<option value="${k}"${k === v.type ? ' selected' : ''}>${htmlEsc(PAYMENT_CHANNEL_TYPES[k].label)}</option>`).join('');
  const meta = PAYMENT_CHANNEL_TYPES[v.type] || PAYMENT_CHANNEL_TYPES.promptpay;
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-handle"></div>
      <div class="modal-title">${isEdit ? 'Edit payment channel' : 'Add payment channel'}</div>
      <div class="form-section">
        <div class="field"><label for="pc-type">Type</label>
          <select id="pc-type" onchange="onPaymentChannelTypeChange(this.value)">${typeOpts}</select>
        </div>
        <div class="field"><label for="pc-label">Label</label>
          <input type="text" id="pc-label" value="${attrEsc(v.label || '')}" placeholder="${attrEsc(meta.label)}"></div>
        <div class="field"><label for="pc-detail" id="pc-detail-label">${htmlEsc(meta.detailLabel)}</label>
          <input type="text" id="pc-detail" value="${attrEsc(v.detail || '')}" placeholder="${attrEsc(meta.ph)}"></div>
      </div>
      <button class="btn-submit" onclick="savePaymentChannel()">Save channel</button>
      ${isEdit ? `<button class="btn-danger" onclick="deletePaymentChannel()">Delete channel</button>` : ''}
      <button class="btn-danger" style="border-color:var(--border-mid);color:var(--text3)" onclick="closePaymentChannelModal()">Cancel</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.classList.add('open');
}
function onPaymentChannelTypeChange(type) {
  const meta = PAYMENT_CHANNEL_TYPES[type] || PAYMENT_CHANNEL_TYPES.other;
  const labelInput = document.getElementById('pc-label');
  const detailInput = document.getElementById('pc-detail');
  const detailLabelEl = document.getElementById('pc-detail-label');
  if (labelInput) labelInput.placeholder = meta.label;
  if (detailInput) detailInput.placeholder = meta.ph;
  if (detailLabelEl) detailLabelEl.textContent = meta.detailLabel;
}
async function savePaymentChannel() {
  const type = document.getElementById('pc-type').value;
  const meta = PAYMENT_CHANNEL_TYPES[type] || PAYMENT_CHANNEL_TYPES.other;
  const label = document.getElementById('pc-label').value.trim() || meta.label;
  const detail = document.getElementById('pc-detail').value.trim();
  const chans = paymentChannels().slice();
  if (editingPaymentChannelId) {
    const idx = chans.findIndex(c => c.id === editingPaymentChannelId);
    if (idx >= 0) chans[idx] = { ...chans[idx], type, label, detail };
  } else {
    chans.push({ id: cuid(), type, label, detail });
  }
  await saveSetting('paymentChannels', chans);
  closePaymentChannelModal();
  renderPaymentChannels();
  toast('Payment channel saved');
}
async function deletePaymentChannel() {
  if (!editingPaymentChannelId) return;
  const chans = paymentChannels().filter(c => c.id !== editingPaymentChannelId);
  await saveSetting('paymentChannels', chans);
  closePaymentChannelModal();
  renderPaymentChannels();
  toast('Payment channel deleted');
}
function closePaymentChannelModal() {
  const el = document.getElementById('modal-paychannel');
  if (el) el.remove();
}

async function onSellerBusinessNameChange(v) { await saveSetting('sellerBusinessName', (v||'').trim()); }
async function onSellerTaxIdChange(v) { await saveSetting('sellerTaxId', (v||'').trim()); }
async function onSellerAddressChange(v) { await saveSetting('sellerAddress', (v||'').trim()); }

// ─── EXPORT: CSV + JSON backup/restore ────────────────────────────────
// Neutralize spreadsheet formula injection in free-text cells and always quote.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
function exportCSV() {
  const sym = curSym();
  let csv = `Date,End date,Start,End,Client,Amount (${sym}),Tip (${sym}),Expense (${sym}),Count,Net (${sym}),Notes\n`;
  jobs.forEach(j => {
    csv += `${csvCell(j.date)},${csvCell(j.endDate||j.date)},${csvCell(j.startTime||'')},${csvCell(j.endTime||'')},`
        +  `${csvCell(j.client||'')},${Number(j.amount)||0},${Number(j.tip)||0},${Number(j.expense)||0},`
        +  `${Number(j.count)||0},${netOf(j)},${csvCell(j.notes||'')}\n`;
  });
  // UTF-8 BOM so Excel detects UTF-8 (฿ header + any non-ASCII text stay intact).
  const blob = new Blob(['﻿' + csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sidekick-jobs-${(currentUser&&currentUser.username)||'guest'}-${todayISO()}.csv`;
  a.click();
  toast(t('exported'));
}
function exportCustomersCSV() {
  let csv = 'Member ID,Name,Phone,Email,Tags,Tax ID,Billing address,Notes\n';
  customers.forEach(c => {
    csv += `${csvCell(c.memberNo||'')},${csvCell(c.name||'')},${csvCell(c.phone||'')},${csvCell(c.email||'')},${csvCell(c.tags||'')},`
        +  `${csvCell(c.taxId||'')},${csvCell(c.billingAddress||'')},${csvCell(c.notes||'')}\n`;
  });
  const blob = new Blob(['﻿' + csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sidekick-customers-${(currentUser&&currentUser.username)||'guest'}-${todayISO()}.csv`;
  a.click();
  toast(t('exported'));
}
async function exportInvoicesCSV() {
  const sym = curSym();
  const uid = isGuest ? 'guest' : currentUser.id;
  const rows = (await dbAll('invoices')).filter(r => r.uid === uid);
  rows.sort((a, b) => String(a.number||'').localeCompare(String(b.number||'')));
  let csv = `Number,Issue date,Due date,Client,Status,Subtotal (${sym}),VAT (${sym}),WHT (${sym}),Client pays (${sym}),You receive (${sym})\n`;
  rows.forEach(inv => {
    csv += `${csvCell(inv.number||'')},${csvCell(inv.issueDate||'')},${csvCell(inv.dueDate||'')},${csvCell(inv.clientName||'')},`
        +  `${csvCell(inv.status||'')},${Number(inv.subtotal)||0},${Number(inv.vat)||0},${Number(inv.wht)||0},`
        +  `${Number(inv.clientPays)||0},${Number(inv.youReceive)||0}\n`;
  });
  const blob = new Blob(['﻿' + csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sidekick-invoices-${(currentUser&&currentUser.username)||'guest'}-${todayISO()}.csv`;
  a.click();
  toast(t('exported'));
}
// Year-end P.N.D. 90/94 filing summary: assessable income (subtotal, before
// tax) and WHT credits withheld, grouped by the year each invoice was
// issued. A rollup of exportInvoicesCSV()'s same per-invoice figures, not a
// separate data source — this is a summary export to help with filing, not
// an authoritative tax document.
async function exportPndSummary() {
  const sym = curSym();
  const uid = isGuest ? 'guest' : currentUser.id;
  const rows = (await dbAll('invoices')).filter(r => r.uid === uid && r.status !== 'draft');
  const byYear = {};
  rows.forEach(inv => {
    const y = (inv.issueDate || '').slice(0, 4) || 'Unknown';
    if (!byYear[y]) byYear[y] = { income: 0, credits: 0, count: 0 };
    byYear[y].income += Number(inv.subtotal) || 0;
    byYear[y].credits += Number(inv.wht) || 0;
    byYear[y].count++;
  });
  let csv = `Year,Invoices,Assessable income (${sym}),WHT credits (${sym})\n`;
  Object.keys(byYear).sort().forEach(y => {
    const r = byYear[y];
    csv += `${csvCell(y)},${r.count},${r.income},${r.credits}\n`;
  });
  const blob = new Blob(['﻿' + csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sidekick-pnd-summary-${(currentUser&&currentUser.username)||'guest'}-${todayISO()}.csv`;
  a.click();
  toast(t('exported'));
}
// All uid-scoped stores a full backup/restore round-trips. Kept in one place
// so a future new store (like bookings/followups/portfolio were for M3) only
// needs to be added here, not re-plumbed through export/import separately.
const BACKUP_STORES = ['jobs', 'expenses', 'clients', 'services', 'invoices', 'documents', 'bookings', 'followups', 'portfolio', 'research', 'packages', 'progressLogs'];

async function exportBackup() {
  const uid = isGuest ? 'guest' : currentUser.id;
  const allByStore = await Promise.all(BACKUP_STORES.map(s => dbAll(s)));
  const backup = {
    app: 'Sidekick', version: APP_VERSION, exportedAt: nowISO(),
    user: (currentUser && currentUser.username) || 'guest',
    settings: settings, theme: 'light',   // dark mode paused in M1.5; restore never flips theme
  };
  BACKUP_STORES.forEach((s, i) => { backup[s] = allByStore[i].filter(r => r.uid === uid); });
  const blob = new Blob([JSON.stringify(backup, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sidekick-backup-${backup.user}-${todayISO()}.json`;
  a.click();
  logEvent('backup_exported');
  await saveSetting('lastBackupAt', nowISO());
  renderBackupReminder(); updateMoreNavBadge();   // clears the reminder immediately, no reload needed
  toast(t('exported'));
}
function pickBackupFile() { const inp = document.getElementById('backup-file'); if (inp) inp.click(); }
async function importBackup(inputEl) {
  const file = inputEl && inputEl.files && inputEl.files[0];
  inputEl.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch(e) { toast(t('restore_bad_file')); return; }
  // Accepts backups from either the current 'Sidekick' tag or the pre-rebrand
  // 'FreelanzGym' one, so a backup file exported before the rename still restores.
  if (!data || (data.app !== 'Sidekick' && data.app !== 'FreelanzGym') || !Array.isArray(data.jobs)) { toast(t('restore_bad_file')); return; }
  // Validate the ENTIRE payload before touching the DB: every row in every
  // store must be a plain, non-null object. Reject malformed backups up front
  // so a bad file (e.g. jobs:[null]) can never delete data mid-import. A
  // backup from an older app version simply won't have the newer stores'
  // keys — Array.isArray(undefined) is false, so those default to [].
  const isPlainObj = o => o != null && typeof o === 'object' && !Array.isArray(o);
  const byStore = {};
  for (const s of BACKUP_STORES) {
    const rows = Array.isArray(data[s]) ? data[s] : [];
    if (!rows.every(isPlainObj)) { toast(t('restore_bad_file')); return; }
    byStore[s] = rows;
  }
  const n = BACKUP_STORES.reduce((sum, s) => sum + byStore[s].length, 0);
  if (!confirm(t('restore_confirm').replace('{n}', n))) return;
  const uid = isGuest ? 'guest' : currentUser.id;
  const savedByStore = {};
  await Promise.all(BACKUP_STORES.map(async s => {
    savedByStore[s] = (await dbAll(s)).filter(r => r.uid === uid);
  }));
  try {
    // Delete every existing row across every store first, then add every new
    // row across every store — matches the original jobs/expenses swap so a
    // failed add always rolls back cleanly (every old id was already gone).
    for (const s of BACKUP_STORES) { for (const row of savedByStore[s]) await dbDel(s, row.id); }
    for (const s of BACKUP_STORES) { for (const row of byStore[s]) { const {id, ...rest} = row; await dbAdd(s, {...rest, uid}); } }
  } catch (err) {
    // Roll back: restore the pre-import rows so a failed swap doesn't lose data.
    for (const s of BACKUP_STORES) {
      for (const row of savedByStore[s]) { const {id, ...rest} = row; await dbAdd(s, {...rest, uid}).catch(()=>{}); }
    }
    await reload();
    toast(t('restore_failed'));
    return;
  }
  // Do NOT import device-global prefs from another account's backup: the
  // top-level data.theme is intentionally ignored (no setTheme call) and the
  // 'lang' setting is skipped, so restoring never changes this device's
  // theme/language.
  if (data.settings && typeof data.settings === 'object') {
    for (const key of Object.keys(data.settings)) {
      if (key === 'lang' || key === 'workType') continue;
      await saveSetting(key, data.settings[key]);
    }
  }
  await reload();
  applyLang();
  toast(t('restore_done').replace('{n}', n));
}

// ─── NAV / SCREENS ────────────────────────────────────────────────────
function switchScreen(name) {
  if (name === 'insights' && !settings.insightsUnlocked) name = 'more';   // hidden dev-only screen — bounce direct navigation
  logEvent('screen_view:' + name);
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => { b.classList.remove('active'); b.removeAttribute('aria-current'); });
  document.getElementById('s-'+name)?.classList.add('active');
  const navBtn = document.getElementById('nav-'+name);
  if (navBtn) { navBtn.classList.add('active'); navBtn.setAttribute('aria-current','page'); }
  const fab = document.getElementById('fab');
  if (fab) fab.style.display = (name === 'home' || name === 'pipeline') ? 'flex' : 'none';
  if (name === 'home') renderHome();
  if (name === 'customers') renderCustomers();
  if (name === 'services') renderServices();
  if (name === 'pipeline' && typeof renderPipeline === 'function') renderPipeline();
  if (name === 'more' && typeof renderWorkflowControls === 'function') renderWorkflowControls();
  if (name === 'more') applyInsightsVisibility();
  if (name === 'more') renderBackupReminder();
  if (name === 'more') renderCloudBackupSection();
  if (name === 'more') renderSubscriptionSection();
  if (name === 'more') renderSellerLogoSection();
  if (name === 'insights') renderInsights();
  // M2 modules (tax.js / invoices.js / docgen.js). Guarded so a not-yet-loaded
  // module can't crash navigation.
  if (name === 'invoices' && typeof renderInvoices === 'function') renderInvoices();
  if (name === 'tax' && typeof renderTax === 'function') renderTax();
  if (name === 'docs' && typeof renderDocgen === 'function') renderDocgen();
  // M3 modules (bookings.js / followups.js / portfolio.js).
  if (name === 'book' && typeof renderBookings === 'function') renderBookings();
  if (name === 'followups' && typeof renderFollowups === 'function') renderFollowups();
  if (name === 'portfolio' && typeof renderPortfolio === 'function') renderPortfolio();
  // M5 module (research.js).
  if (name === 'research' && typeof renderResearch === 'function') renderResearch();
  window.scrollTo(0, 0);
}
// ─── i18n render pass ─────────────────────────────────────────────────
function applyLang() {
  const lang = curLang();
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
  const hintEl = document.getElementById('auth-hint-text');
  if (hintEl) hintEl.innerHTML = t('auth_hint');
  const submitBtn = document.getElementById('auth-submit');
  if (submitBtn) submitBtn.textContent = authMode === 'register' ? t('create_account') : t('login');
  try { if (currentUser) { renderHome(); applyUser(); renderPaymentChannels(); } } catch(e) {}
}

// ─── UTILS ────────────────────────────────────────────────────────────
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2500);
}

// ─── PWA: service worker (registered relatively) ──────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW register failed', err));
  });
}

// close modals on overlay click
document.getElementById('modal-job')?.addEventListener('click', function(e) {
  if (e.target === this) closeJobModal();
});
document.getElementById('modal-customer')?.addEventListener('click', function(e) {
  if (e.target === this) closeCustomerModal();
});
document.getElementById('modal-service')?.addEventListener('click', function(e) {
  if (e.target === this) closeServiceModal();
});
// submit auth with Enter (login.html)
['auth-user','auth-pass','auth-confirm'].forEach(id => {
  document.getElementById(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth(); });
});

// ─── START ────────────────────────────────────────────────────────────
boot();
