/* Freelanz — app.js  (all screens + logic + PWA boot)
 * Local-first freelance-admin PWA. Vanilla JS + IndexedDB + Service Worker.
 * NO backend, NO secrets, NO external CDNs. English-only MVP; i18n engine is
 * built so Thai (or any locale) can be added later by extending I18N.
 *
 * VERSION LOCKSTEP: APP_VERSION tracks sw.js SW_VERSION and the ?v= query on
 * the precached app.js / styles.css. Bump all three together on every deploy.
 */
const APP_VERSION = '0.9.0';          // <-> sw.js SW_VERSION 'freelanz-v0.9.0'

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
// 5→6 ('usageEvents' — local usage analytics). onupgradeneeded only CREATES
// missing stores (each guarded by !contains) — it never drops or clears
// existing stores, so guest jobs / clients / settings survive the upgrade.
// DB_NAME/storage keys below are namespaced 'gym' because this app co-hosts
// with the main Freelanz app on the same GitHub Pages origin (root vs /gym/):
// IndexedDB/localStorage/sessionStorage are scoped per-ORIGIN, not per-path,
// so an unprefixed name here would silently share the main app's database.
const DB_NAME = 'freelanz-gym-v1', DB_VER = 6;
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
    req.onblocked = () => rej(new Error('DB upgrade blocked — close other Freelanz tabs and reload.'));
  });
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
const SESSION_KEY = 'freelanz_gym_uid';
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
  let u = localStorage.getItem('gym_guest_username');
  if (!u) {
    const n = (parseInt(localStorage.getItem('gym_guest_counter') || '0', 10) + 1);
    localStorage.setItem('gym_guest_counter', String(n));
    u = 'Guest' + String(n).padStart(6, '0');
    localStorage.setItem('gym_guest_username', u);
  }
  return u;
}
async function loginGuest() {
  isGuest = true;
  currentUser = {id: 0, username: guestUsername()};
  localStorage.setItem(SESSION_KEY, 'guest');
  sessionStorage.setItem('gym_post_login_toast', t('welcome') + ', ' + t('guest_name') + '!');
  location.href = './';
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
    if (password !== document.getElementById('auth-confirm').value) { authError(t('err_pw_mismatch')); return; }
    if (await dbGetByUsername(id0)) { authError(t('err_account_exists')); return; }
    const salt = randomSalt();
    const iters = PBKDF2_ITERS;
    const hash = await hashPassword(password, salt, iters);
    const id = await dbAdd('users', {username:id0, salt, hash, iters, firstName, createdAt: nowISO()});
    currentUser = {id, username:id0, firstName};
    isGuest = false;
    localStorage.setItem(SESSION_KEY, String(id));
    sessionStorage.setItem('gym_post_login_toast', t('welcome') + (firstName ? ', ' + firstName : '') + '!');
    location.href = './';
  } else {
    const user = await dbGetByUsername(id0);
    if (!user) { authError(t('err_no_account')); return; }
    const hash = await hashPassword(password, user.salt, user.iters || PBKDF2_ITERS);
    if (hash !== user.hash) { authError(t('err_incorrect_pw')); return; }
    currentUser = {id: user.id, username: user.username, firstName: user.firstName || ''};
    isGuest = false;
    localStorage.setItem(SESSION_KEY, String(user.id));
    sessionStorage.setItem('gym_post_login_toast', t('welcome_back') + (user.firstName ? ', ' + user.firstName : '') + '!');
    location.href = './';
  }
}
async function logout() {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.setItem('gym_post_login_toast', t('logged_out'));
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
let jobs = [], expenses = [], customers = [], services = [], usageEvents = [], settings = {lang:'en', currency:'THB'};
let currentPeriod = 'month';

// HTML/attr escaping (shared by all list/form renderers)
function htmlEsc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function attrEsc(s) { return htmlEsc(s).replace(/"/g,'&quot;'); }

const CURRENCY_SYM = {THB:'฿', USD:'$', EUR:'€', GBP:'£', SGD:'S$', MYR:'RM'};
function curSym() { return CURRENCY_SYM[(settings && settings.currency) || 'THB'] || '฿'; }

// Freelanz — Personal Gym Trainer edition: single work type, no persona picker.
function unitWord() { return 'Session'; }

// ─── ENGAGEMENT PIPELINE ────────────────────────────────────────────────
// A session IS an engagement moving through a fixed 6-stage lifecycle:
//   pitch    → initial outreach to a prospective client
//   quote    → send a price quote for a session/package
//   invoice  → send the invoice
//   paid     → payment received
//   delivery → deliver the session(s) themselves
//   extend   → offer a renewal/extension once delivered
// All six are mandatory and always present (no optional/toggleable stage,
// unlike the general Freelanz app's per-persona presets) — this fixed order
// IS the business process for this edition. Still reorderable in Settings ▸
// Workflow for personal preference, guarded so Paid can't precede Invoice.
const STAGES = ['pitch', 'quote', 'invoice', 'paid', 'delivery', 'extend'];
const STAGE_META = {
  pitch:    {label:'Pitch',    icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:inline-block;vertical-align:middle"><path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4 20-7z"/></svg>', action:'Log pitch',       done:'Pitched'},
  quote:    {label:'Quote',    icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:inline-block;vertical-align:middle"><path d="M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-6.5A8 8 0 1 1 21 12z"/></svg>', action:'Send quote',       done:'Quote sent', skippable:true},
  invoice:  {label:'Invoice',  icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:inline-block;vertical-align:middle"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6"/><path d="M9 11h6"/><path d="M9 15h4"/></svg>', action:'Send invoice',      done:'Invoice sent', skippable:true},
  paid:     {label:'Paid',     icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:inline-block;vertical-align:middle"><circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M14.5 9.3C14.5 8.3 13.4 8 12 8s-2.5.6-2.5 1.7c0 2.4 5 1.2 5 3.6 0 1.1-1.1 1.7-2.5 1.7s-2.5-.4-2.5-1.4"/></svg>', action:'Mark paid',         done:'Paid'},
  delivery: {label:'Delivery', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:inline-block;vertical-align:middle"><path d="M14.5 5.5a3.5 3.5 0 0 0-4.6 4.4L4 15.8V20h4.2l5.9-5.9a3.5 3.5 0 0 0 4.4-4.6l-2.3 2.3-2-2z"/></svg>', action:'Mark delivered',  done:'Delivered'},
  extend:   {label:'Extend',   icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:inline-block;vertical-align:middle"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>', action:'Mark extended',    done:'Extended'},
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

// ─── I18N ─────────────────────────────────────────────────────────────
// t(key) resolves a persona-scoped `key@<workType>` variant first, then the
// base key, then the English fallback, then the raw key. Base (no workType) =
// "Job" wording. Add another locale later by adding I18N.<lang>.
const I18N = {
  en: {
    // auth
    login:'Log in', create_account:'Create account', email:'Email or username', password:'Password',
    confirm_password:'Confirm password', your_name:'Your name', login_guest:'Continue as guest',
    auth_hint:'Create an account to save your work on this device.<br>Everything stays local — no cloud, no tracking.<br>Guest mode is temporary.',
    tagline:'Freelance admin, handled.',
    // nav
    nav_home:'Home', nav_docs:'Docs', nav_pipeline:'Pipeline', nav_book:'Book', nav_more:'More',
    pipeline_title:'Pipeline', workflow_title:'Workflow', pipeline_glance_title:'Pipeline at a glance',
    skip_stage:'Skip', mark_finished:'Finished',
    // dashboard
    earned_this_month:'Earned this month', net_after_expenses:'net after expenses',
    stat_jobs:'Sessions', stat_avg:'Avg / session', stat_expenses:'Expenses',
    todays_goal:"Today's goal", goal_reached:'Goal reached! 🎉', goal_of:'of',
    action_queue:'Action queue', queue_empty:'You’re all caught up.', queue_empty_sub:'New tasks will appear here as you add sessions and invoices.',
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
    preferences:'Preferences', currency:'Currency', theme:'Theme',
    theme_auto:'Auto', theme_light:'Light', theme_dark:'Dark',
    business_info_title:'Business info (optional)', business_info_sub:'Fill these in to have them show up automatically on your quotes, invoices, and receipts — none of them are required.',
    business_name:'Business name', business_taxid:'Tax ID', business_address:'Address',
    tax_defaults:'Tax defaults (for M2)', wht:'Withholding tax %', vat:'VAT %',
    daily_goal:'Daily income goal', data:'Data', export_csv:'Export CSV', backup_json:'Backup JSON', restore_json:'Restore JSON',
    total_jobs:'Total jobs', app_word:'App', version:'Version', logout:'Log out', exit_guest:'Exit guest mode',
    // placeholder modules
    invoices_title:'Invoices', docs_title:'Documents', book_title:'Booking',
    module_soon_h:'Coming soon', mod_invoices_p:'Send branded invoices, track paid / due / overdue, and auto-fill tax. Arrives in M2.',
    mod_docs_p:'Store contracts, receipts and portfolio files — all on your device. Arrives in M2.',
    mod_book_p:'Share a booking link and let clients pick a slot. Arrives in M3.',
    pill_m2:'Ships in M2', pill_m3:'Ships in M3',
    // misc
    welcome:'Welcome', welcome_back:'Welcome back', guest_name:'Guest', logged_out:'Logged out',
    greeting_morning:'Good morning', greeting_afternoon:'Good afternoon', greeting_evening:'Good evening',
    cancel:'Cancel', saved:'Saved', deleted:'Deleted', job_saved:'Job saved', job_deleted:'Job deleted',
    exported:'Exported', restore_confirm:'Restore this backup? It REPLACES this account’s {n} current jobs + expenses. This cannot be undone.',
    restore_done:'Restored {n} records', restore_bad_file:'Not a valid Freelanz backup file',
    restore_failed:'Restore failed — your existing data was kept.',
    backup_reminder_title:'Back up your data', backup_reminder_sub:'Everything lives only on this device. Last backup: {date}.',
    backup_now:'Back up now', remind_later:'Remind me later', backup_snoozed:'Reminder snoozed for 2 weeks', backup_never:'never',
    delete_job_confirm:'Delete this job?', name_saved:'Name saved',
    err_id_min3:'Enter an email or username (3+ characters).', err_pw_min4:'Password must be at least 8 characters.',
    err_pw_mismatch:'Passwords do not match.', err_account_exists:'That account already exists on this device.',
    err_no_account:'No account with that email on this device.', err_incorrect_pw:'Incorrect password.',
    // M1.5 — customers (displayed as "client" throughout — the gym-trainer term)
    manage:'Manage', customers_title:'Clients', add_customer:'Add client', edit_customer:'Edit client',
    save_customer:'Save client', delete_customer:'Delete client', delete_customer_confirm:'Delete this client?',
    no_customers:'No clients yet', no_customers_sub:'Add your first client to reuse their details.',
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
    field_rate:'Default rate', field_unit:'Unit', field_unit_ph:'e.g. session, hour, project',
    // M1.5 — job form links
    field_customer:'Client', field_service:'Service', none_option:'— None —',
    add_new_client_option:'+ Add a new client…',
    export_customers_csv:'Export clients CSV',
    nav_customers:'Clients',
    // Usage insights (local-only analytics)
    insights_title:'Insights', no_insights:'No activity yet', no_insights_sub:'Insights build up as you use the app — nothing is sent anywhere, this stays on your device.',
    insights_sessions_logged:'Sessions logged', insights_clients_added:'Clients added', insights_active_days_30:'Active days (30d)',
    insights_feature_usage:'Feature usage', insights_pipeline_activity:'Pipeline activity', insights_no_pipeline_activity:'No pipeline activity yet',
    insights_stage_done:'Completed', insights_clear:'Clear usage data', insights_clear_confirm:'Clear all local usage data? This cannot be undone.',
    insights_cleared:'Usage data cleared', insights_unlocked:'Insights unlocked',
  }
};
function curLang() { return (settings && settings.lang) || localStorage.getItem('gym_ui_lang') || 'en'; }
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
// M1.5: dark mode is PAUSED. applyTheme always forces light regardless of OS
// (the [data-theme="light"] token block overrides the prefers-color-scheme dark
// media query). The dark-theme CSS tokens are kept in styles.css but dormant.
function applyTheme() {
  localStorage.setItem('gym_ui_theme', 'light');
  document.documentElement.dataset.theme = 'light';
}

// ─── BOOT ─────────────────────────────────────────────────────────────
function showPostLoginToast() {
  const msg = sessionStorage.getItem('gym_post_login_toast');
  if (msg) { sessionStorage.removeItem('gym_post_login_toast'); toast(msg); }
}
// login.html entry — already-authed devices skip to the app.
async function bootLogin() {
  applyTheme();
  await openDB();
  if (await restoreSession()) { location.replace('./'); return; }
  applyLang();
  showPostLoginToast();
}
// index.html entry — no session → bounce to login.
async function bootApp() {
  applyTheme();
  { const v = document.getElementById('app-version'); if (v) v.textContent = APP_VERSION; }
  await openDB();
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
      '<div style="padding:24px;max-width:34rem;margin:0 auto;font:15px/1.5 system-ui;color:#13201C">' +
      '<b>Couldn’t start Freelanz.</b><br>' + msg +
      '<br><br>Close any other Freelanz tabs and reload.</div>');
  });
}

async function enterApp() {
  document.body.classList.add('authed');
  settings = {lang:'en', currency:'THB'};
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
  set('set-currency', settings.currency || 'THB');
  set('set-goal', settings.dailyGoal || '');
  set('set-wht', settings.wht != null ? settings.wht : '');
  set('set-vat', settings.vat != null ? settings.vat : '');
  set('set-promptpay', settings.promptpayId || '');
  set('set-seller-name', settings.sellerBusinessName || '');
  set('set-seller-taxid', settings.sellerTaxId || '');
  set('set-seller-address', settings.sellerAddress || '');
  const notifCheckbox = document.getElementById('set-notifications');
  if (notifCheckbox) notifCheckbox.checked = !!(settings.notificationsEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted');

  // Personal Gym Trainer edition: single fixed work type, no onboarding picker.
  if (!settings.workType) await saveSetting('workType', 'gym');
  document.body.setAttribute('data-work-type', 'gym');
  await seedServicesIfEmpty();
  switchScreen('home');

  // App-triggered OS notifications: only fire while this tab stays open (no
  // backend to check conditions while fully closed — see the comment above
  // computeNotificationConditions()). reload() (already called above) fires
  // the first check; this just re-checks every minute after that, mainly for
  // the time-sensitive "booking starting soon" condition.
  setInterval(checkAndFireNotifications, 60000);
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
  home:'Home', pipeline:'Pipeline', customers:'Clients', book:'Booking', more:'Settings',
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
  const STAGE_DISPLAY_LABELS = { done: t('insights_stage_done'), extended: STAGE_META.extend && STAGE_META.extend.done, finished: t('mark_finished') };
  const stageRows = stageOrderForDisplay.filter(s => stageCounts[s]).map(s => {
    const label = STAGE_DISPLAY_LABELS[s] || (STAGE_META[s] && STAGE_META[s].label) || s;
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

// ─── Backup reminder (data-loss protection) ────────────────────────────
// Freelanz is local-only storage: clearing browser data or switching
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
    if (!notified[k]) toFire.push({ title: 'Engagement needs attention', body: `${j.client || 'Client'} has been in ${(STAGE_META[st] || {}).label || st} for a few days`, tag: k });
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
  renderPipelineGlance();
  updateMoreNavBadge();
  // Action queue: a list of independent nudges — overdue invoices, imminent
  // bookings, and stale pipeline engagements can all be true at once.
  // computeNotificationConditions() is the same function the OS-notification
  // checker uses, so the two can never show different things. The backup
  // reminder moved to the More screen (see renderBackupReminder()) — it's a
  // device-housekeeping nudge, not a pipeline/payment one, so it doesn't
  // compete with those for attention on Home.
  const q = document.getElementById('queue-body');
  if (!q) return;
  const rows = [];
  try {
    const { overdueInvoices, upcomingBookings, staleJobs } = await computeNotificationConditions();
    if (overdueInvoices.length) {
      rows.push(`<div class="list-row" onclick="switchScreen('invoices')">
          <div class="list-icon">⚠️</div>
          <div class="list-main">
            <div class="list-title">${overdueInvoices.length} invoice${overdueInvoices.length > 1 ? 's' : ''} overdue</div>
            <div class="list-sub">${htmlEsc(overdueInvoices.map(i => i.number).join(', '))}</div>
          </div>
          <div class="list-right"><span style="color:var(--text3)">›</span></div>
        </div>`);
    }
    if (upcomingBookings.length) {
      upcomingBookings.forEach(b => {
        rows.push(`<div class="list-row" onclick="switchScreen('book')">
            <div class="list-icon">⏰</div>
            <div class="list-main">
              <div class="list-title">${htmlEsc(b.title || 'Booking')} at ${htmlEsc(b.startTime)}</div>
              <div class="list-sub">Starting soon</div>
            </div>
            <div class="list-right"><span style="color:var(--text3)">›</span></div>
          </div>`);
      });
    }
    if (staleJobs.length) {
      rows.push(`<div class="list-row" onclick="switchScreen('pipeline')">
          <div class="list-icon">📌</div>
          <div class="list-main">
            <div class="list-title">${staleJobs.length} engagement${staleJobs.length > 1 ? 's need' : ' needs'} attention</div>
            <div class="list-sub">No movement for ${NOTIFY_STALE_DAYS}+ days</div>
          </div>
          <div class="list-right"><span style="color:var(--text3)">›</span></div>
        </div>`);
    }
  } catch (e) { console.error('renderHome notifications', e); }

  q.innerHTML = rows.length
    ? '<div class="list-card">' + rows.join('') + '</div>'
    : `<div class="empty"><div class="empty-icon">✅</div>
        <p data-i18n="queue_empty">${t('queue_empty')}</p>
        <span data-i18n="queue_empty_sub">${t('queue_empty_sub')}</span></div>`;
}
function renderPipelineGlance() {
  const wrap = document.getElementById('pipeline-glance');
  if (!wrap) return;
  const order = (typeof getStageOrder === 'function') ? getStageOrder() : [];
  const counts = {};
  order.forEach(s => counts[s] = 0);
  jobs.forEach(j => {
    if (typeof jobComplete === 'function' && jobComplete(j)) return;
    const s = (typeof jobStage === 'function') ? jobStage(j) : null;
    if (counts[s] != null) counts[s]++;
  });
  wrap.innerHTML = order.map(stage => {
    const meta = STAGE_META[stage] || {};
    const n = counts[stage] || 0;
    return `<button type="button" class="pg-pill" onclick="openPipelineAt('${stage}')">
      <span class="pg-pill-main">
        <span class="pg-ico">${meta.icon || ''}</span>
        <span class="pg-label">${htmlEsc(meta.label || stage)}</span>
      </span>
      <span class="pg-count">${n}</span>
    </button>`;
  }).join('');
}
function renderGoal() {
  const card = document.getElementById('goal-card');
  const goal = Number(settings.dailyGoal) || 0;
  if (!card) return;
  if (!goal) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const todayNet = jobsToday().reduce((s,j)=> s + netOf(j), 0);
  const pct = Math.max(0, Math.min(100, Math.round((todayNet / goal) * 100)));
  const reached = todayNet >= goal;
  const fill = document.getElementById('goal-fill');
  fill.style.width = pct + '%';
  fill.classList.toggle('reached', reached);
  document.getElementById('goal-pct').textContent = pct + '%';
  document.getElementById('goal-sub').textContent = reached ? t('goal_reached')
    : `${money(todayNet)} ${t('goal_of')} ${money(goal)}`;
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
      services.map(s => `<option value="${s.id}">${htmlEsc(s.name)} · ${htmlEsc(money(s.rate))}</option>`).join('');
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
}
function onJobServiceChange(v) {
  if (!v) return;
  const s = services.find(x => x.id === parseInt(v));
  if (s) { document.getElementById('j-amount').value = s.rate; calcNet(); }
}
function openAddJob() {
  document.getElementById('modal-title').textContent = t('add_job');
  document.getElementById('j-edit-id').value = '';
  document.getElementById('j-date').value = todayISO();
  ['j-amount','j-tip','j-expense','j-count','j-notes'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  populateJobSelects('', '');
  document.getElementById('j-delete').style.display = 'none';
  clearFieldErrors();
  calcNet();
  openJobModal();
}
function openEditJob(id) {
  const j = jobs.find(x => x.id === id);
  if (!j) return;
  document.getElementById('modal-title').textContent = t('edit_job');
  document.getElementById('j-edit-id').value = String(id);
  const set = (i,v)=>{ const el=document.getElementById(i); if(el) el.value = (v==null?'':v); };
  set('j-date', j.date);
  set('j-amount', j.amount); set('j-tip', j.tip);
  set('j-expense', j.expense); set('j-count', j.count); set('j-notes', j.notes);
  populateJobSelects(j.clientId != null ? j.clientId : '', j.serviceId != null ? j.serviceId : '');
  document.getElementById('j-delete').style.display = 'block';
  clearFieldErrors();
  calcNet();
  openJobModal();
}
function openJobModal() { document.getElementById('modal-job').classList.add('open'); }
function closeJobModal() { document.getElementById('modal-job').classList.remove('open'); }

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
  obj.updatedAt = nowISO();
  const isNew = !editId;
  const key = await dbPut('jobs', obj);
  if (obj.id == null) obj.id = key;
  if (isNew) logEvent('session_logged');
  closeJobModal();
  await reload();
  toast(t('job_saved'));
}
async function deleteJob() {
  const editId = document.getElementById('j-edit-id').value;
  if (!editId) return;
  if (!confirm(t('delete_job_confirm'))) return;
  await dbDel('jobs', parseInt(editId));
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

  const rail = order.map(stage => {
    const meta = STAGE_META[stage] || {};
    const isActive = stage === activeStage;
    return `<button type="button" class="pl-rail-item${isActive ? ' active' : ''}" onclick="selectPipelineStage('${stage}')" aria-current="${isActive ? 'true' : 'false'}">
      <span class="pl-rail-ico">${meta.icon || ''}</span>
      <span class="pl-rail-label">${htmlEsc(meta.label || stage)}</span>
      <span class="pl-rail-count">${(groups[stage] || []).length}</span>
    </button>`;
  }).join('');

  const list = activeItems.length
    ? activeItems.map(j => pipelineCard(j, activeStage)).join('')
    : '<div class="kb-empty">Nothing here yet</div>';

  el.innerHTML = `<div class="pl-layout">
    <div class="pl-rail" role="tablist" aria-label="Pipeline stages">${rail}</div>
    <div class="pl-main">
      <div class="pl-main-head">
        <span class="pl-rail-ico">${activeMeta.icon || ''}</span>
        <span>${htmlEsc(activeMeta.label || activeStage)}</span>
        <span class="kb-count">${activeItems.length}</span>
      </div>
      <div class="pl-main-body">${list}</div>
    </div>
  </div>`;
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
  const doneLabel = j.outcome === 'finished' ? t('mark_finished') : (meta.done || 'Done');
  const foot = complete
    ? `<span class="pl-done">✓ ${htmlEsc(doneLabel)}</span>`
    : `<button type="button" class="pl-action" onclick="event.stopPropagation();pipelineAction(${j.id})">${htmlEsc(meta.action || 'Advance')} →</button>`;
  const skip = (!complete && meta.skippable)
    ? `<button type="button" class="pl-skip" onclick="event.stopPropagation();skipJobStage(${j.id})">${htmlEsc(t('skip_stage'))}</button>`
    : '';
  const finish = (!complete && stage === 'extend')
    ? `<button type="button" class="pl-skip" onclick="event.stopPropagation();finishJobStage(${j.id})">${htmlEsc(t('mark_finished'))}</button>`
    : '';
  const back = canBack
    ? `<button type="button" class="kb-back" aria-label="Move back a stage" title="Move back" onclick="event.stopPropagation();moveJobStageBack(${j.id})">←</button>`
    : '';
  return `<div class="kb-card${enter}" onclick="openEditJob(${j.id})">
    <div class="kb-card-top">
      <div class="kb-card-main">
        <div class="kb-card-title">${htmlEsc(who)}</div>
        <div class="kb-card-sub">${htmlEsc(svc)} · ${htmlEsc(amt)}${fmtDate(j.date) ? ' · ' + htmlEsc(fmtDate(j.date)) : ''}</div>
      </div>
      <button type="button" class="pl-edit" aria-label="Edit engagement" onclick="event.stopPropagation();openEditJob(${j.id})">✎</button>
    </div>
    <div class="kb-card-foot">${back}${skip}${finish}${foot}</div>
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
  } else {
    advanceJobStage(jobId);   // 'pitch', 'delivery', 'extend': just advance, no linked record
  }
}
window.pipelineAction = pipelineAction;

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
  if (typeof renderInvoices === 'function') renderInvoices();
  toast('Marked paid');
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
    return `<div class="wf-row">
      <span class="wf-ico">${meta.icon || ''}</span>
      <span class="wf-name">${htmlEsc(meta.label || stage)}</span>
      <span class="wf-btns">
        <button type="button" class="wf-move" aria-label="Move ${htmlEsc(meta.label || stage)} up" ${i === 0 ? 'disabled' : ''} onclick="wfMove(${i},-1)">↑</button>
        <button type="button" class="wf-move" aria-label="Move ${htmlEsc(meta.label || stage)} down" ${i === order.length - 1 ? 'disabled' : ''} onclick="wfMove(${i},1)">↓</button>
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
  const prefix = 'M-';
  let max = 0;
  customers.forEach(c => {
    if (typeof c.memberNo === 'string' && c.memberNo.indexOf(prefix) === 0) {
      const seq = parseInt(c.memberNo.slice(prefix.length), 10);
      if (isFinite(seq) && seq > max) max = seq;
    }
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
function renderCustomers() {
  const wrap = document.getElementById('customers-body');
  if (!wrap) return;
  if (!customers.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-icon">👤</div>
      <p>${htmlEsc(t('no_customers'))}</p><span>${htmlEsc(t('no_customers_sub'))}</span></div>`;
    return;
  }
  wrap.innerHTML = '<div class="list-card">' + customers.map(c => {
    const sub = [c.memberNo, c.company || c.phone || c.email || ''].filter(Boolean).join(' · ');
    return `<div class="list-row" onclick="openEditCustomer(${c.id})">
      <div class="list-icon">👤</div>
      <div class="list-main">
        <div class="list-title">${htmlEsc(c.name)}</div>
        <div class="list-sub">${htmlEsc(sub)}</div>
      </div>
      <div class="list-right"><span style="color:var(--text3);font-size:18px">›</span></div>
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
  await dbDel('clients', parseInt(editId));
  closeCustomerModal();
  await reload();
  toast(t('customer_deleted'));
}

// ─── SERVICES (catalog + default rates) ───────────────────────────────
// Example gym services seeded once (editable/deletable). Numbers are currency-agnostic.
const SEED_SERVICES = [['1-on-1 session',800,'session'],['Group class',400,'session'],['Nutrition plan',2000,'plan']];
async function seedServicesIfEmpty() {
  const flag = 'servicesSeeded_gym';
  if (settings[flag]) return;                       // already seeded
  const uid = isGuest ? 'guest' : currentUser.id;
  const existing = (await dbAll('services')).filter(s => s.uid === uid);
  if (existing.length) { await saveSetting(flag, true); return; }   // never overwrite user data
  for (const [name, rate, unit] of SEED_SERVICES) {
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
function closeServiceModal() { document.getElementById('modal-service').classList.remove('open'); }
function openAddService() {
  document.getElementById('svc-modal-title').textContent = t('add_service');
  document.getElementById('sv-edit-id').value = '';
  ['sv-name','sv-rate','sv-unit'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
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
  const uid = isGuest ? 'guest' : currentUser.id;
  const obj = {uid, name, rate, unit};
  const editId = document.getElementById('sv-edit-id').value;
  if (editId) {
    const id = parseInt(editId);
    const prev = services.find(s => s.id === id);
    if (!prev) return;
    obj.id = id; obj.cuid = prev.cuid || cuid();
  } else { obj.cuid = cuid(); }
  obj.updatedAt = nowISO();
  await dbPut('services', obj);
  closeServiceModal();
  await reload();
  toast(t('service_saved'));
}
async function deleteService() {
  const editId = document.getElementById('sv-edit-id').value;
  if (!editId) return;
  if (!confirm(t('delete_service_confirm'))) return;
  await dbDel('services', parseInt(editId));
  closeServiceModal();
  await reload();
  toast(t('service_deleted'));
}

// ─── SETTINGS ─────────────────────────────────────────────────────────
async function saveSetting(key, val) {
  settings[key] = val;
  const prefix = isGuest ? 'guest:' : (currentUser.id + ':');
  await dbPut('settings', {key: prefix + key, value: val});
  if (key === 'lang') localStorage.setItem('gym_ui_lang', val);
}
async function onCurrencyChange(v) { await saveSetting('currency', v); applyLang(); }
async function onGoalChange(v) { const n = parseFloat(v); await saveSetting('dailyGoal', isNaN(n)?0:n); renderGoal(); }
async function onWhtChange(v) { const n = parseFloat(v); await saveSetting('wht', isNaN(n)?null:n); }
async function onVatChange(v) { const n = parseFloat(v); await saveSetting('vat', isNaN(n)?null:n); }
async function onPromptPayChange(v) { await saveSetting('promptpayId', (v||'').trim()); }
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
  a.download = `freelanz-jobs-${(currentUser&&currentUser.username)||'guest'}-${todayISO()}.csv`;
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
  a.download = `freelanz-customers-${(currentUser&&currentUser.username)||'guest'}-${todayISO()}.csv`;
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
  a.download = `freelanz-invoices-${(currentUser&&currentUser.username)||'guest'}-${todayISO()}.csv`;
  a.click();
  toast(t('exported'));
}
// All uid-scoped stores a full backup/restore round-trips. Kept in one place
// so a future new store (like bookings/followups/portfolio were for M3) only
// needs to be added here, not re-plumbed through export/import separately.
const BACKUP_STORES = ['jobs', 'expenses', 'clients', 'services', 'invoices', 'documents', 'bookings', 'followups', 'portfolio', 'research'];

async function exportBackup() {
  const uid = isGuest ? 'guest' : currentUser.id;
  const allByStore = await Promise.all(BACKUP_STORES.map(s => dbAll(s)));
  const backup = {
    app: 'FreelanzGym', version: APP_VERSION, exportedAt: nowISO(),
    user: (currentUser && currentUser.username) || 'guest',
    settings: settings, theme: 'light',   // dark mode paused in M1.5; restore never flips theme
  };
  BACKUP_STORES.forEach((s, i) => { backup[s] = allByStore[i].filter(r => r.uid === uid); });
  const blob = new Blob([JSON.stringify(backup, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `freelanz-gym-backup-${backup.user}-${todayISO()}.json`;
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
  if (!data || data.app !== 'FreelanzGym' || !Array.isArray(data.jobs)) { toast(t('restore_bad_file')); return; }
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
  try { if (currentUser) { renderHome(); applyUser(); } } catch(e) {}
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
