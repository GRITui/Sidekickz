/* Freelanz — app.js  (all screens + logic + PWA boot)
 * Local-first freelance-admin PWA. Vanilla JS + IndexedDB + Service Worker.
 * NO backend, NO secrets, NO external CDNs. English-only MVP; i18n engine is
 * built so Thai (or any locale) can be added later by extending I18N.
 *
 * VERSION LOCKSTEP: APP_VERSION tracks sw.js SW_VERSION and the ?v= query on
 * the precached app.js / styles.css. Bump all three together on every deploy.
 */
const APP_VERSION = '0.5.0';          // <-> sw.js SW_VERSION 'freelanz-v0.5.0'

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
// ('research'). onupgradeneeded only CREATES missing stores (each guarded by
// !contains) — it never drops or clears existing stores, so guest jobs /
// clients / settings survive the upgrade.
const DB_NAME = 'freelanz-v2', DB_VER = 4;   // DB_NAME kept as freelanz-v2 (no prior real users; only DB_VER bumps now)
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
const SESSION_KEY = 'freelanz_uid';
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
  let u = localStorage.getItem('guest_username');
  if (!u) {
    const n = (parseInt(localStorage.getItem('guest_counter') || '0', 10) + 1);
    localStorage.setItem('guest_counter', String(n));
    u = 'Guest' + String(n).padStart(6, '0');
    localStorage.setItem('guest_username', u);
  }
  return u;
}
async function loginGuest() {
  isGuest = true;
  currentUser = {id: 0, username: guestUsername()};
  localStorage.setItem(SESSION_KEY, 'guest');
  sessionStorage.setItem('post_login_toast', t('welcome') + ', ' + t('guest_name') + '!');
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
    sessionStorage.setItem('post_login_toast', t('welcome') + (firstName ? ', ' + firstName : '') + '!');
    location.href = './';
  } else {
    const user = await dbGetByUsername(id0);
    if (!user) { authError(t('err_no_account')); return; }
    const hash = await hashPassword(password, user.salt, user.iters || PBKDF2_ITERS);
    if (hash !== user.hash) { authError(t('err_incorrect_pw')); return; }
    currentUser = {id: user.id, username: user.username, firstName: user.firstName || ''};
    isGuest = false;
    localStorage.setItem(SESSION_KEY, String(user.id));
    sessionStorage.setItem('post_login_toast', t('welcome_back') + (user.firstName ? ', ' + user.firstName : '') + '!');
    location.href = './';
  }
}
async function logout() {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.setItem('post_login_toast', t('logged_out'));
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
let jobs = [], expenses = [], customers = [], services = [], settings = {lang:'en', currency:'THB'};
let currentPeriod = 'month';

// HTML/attr escaping (shared by all list/form renderers)
function htmlEsc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function attrEsc(s) { return htmlEsc(s).replace(/"/g,'&quot;'); }

// ─── PERSONAS (i18n @workType relabels + onboarding) ──────────────────
const PERSONAS = [
  {id:'creative',     icon:'🎨', label:'Creative',     sub:'Design, writing, video'},
  {id:'tech',         icon:'💻', label:'Tech',         sub:'Dev, IT, data'},
  {id:'service',      icon:'🎓', label:'Service',      sub:'Coaching, tutoring'},
  {id:'photographer', icon:'📷', label:'Photographer', sub:'Shoots, events'},
  {id:'sales',        icon:'🤝', label:'Sales',        sub:'Field sales, agents'},
  {id:'gym',          icon:'💪', label:'Personal gym trainer', sub:'Sessions, members'},
];
const CURRENCY_SYM = {THB:'฿', USD:'$', EUR:'€', GBP:'£', SGD:'S$', MYR:'RM'};
function curSym() { return CURRENCY_SYM[(settings && settings.currency) || 'THB'] || '฿'; }

// Singular unit word per persona (used for jobs-list row titles + custom relabels).
const UNIT_WORD = {creative:'Gig', tech:'Project', service:'Lesson', photographer:'Shoot', sales:'Visit', gym:'Session'};
function titleCase(w) { return w ? w.charAt(0).toUpperCase() + w.slice(1) : w; }
function pluralize(w) {
  if (!w) return w;
  if (/(ch|sh|[sxz])$/i.test(w)) return w + 'es';
  if (/[^aeiou]y$/i.test(w)) return w.slice(0,-1) + 'ies';
  return w + 's';
}
// Custom work-type: derive singular/plural + title/lower forms from settings.customUnit.
function customUnitForms() {
  const raw = ((settings && settings.customUnit) || 'job').trim() || 'job';
  const singular = raw, plural = pluralize(raw);
  return {singular, plural, titleS: titleCase(singular), titlePl: titleCase(plural)};
}
// Singular unit word for the CURRENT work type (jobs-list row title fallback).
function unitWord() {
  if (settings && settings.workType === 'custom') return customUnitForms().titleS;
  return UNIT_WORD[settings && settings.workType] || 'Job';
}
// For workType==='custom', substitute the custom unit word into the core relabel
// keys. Returns null for any key not in the relabel set (falls through to base).
function customLabelForKey(key) {
  const f = customUnitForms();
  switch (key) {
    case 'nav_jobs': case 'jobs_title': case 'stat_jobs': return f.titlePl;
    case 'stat_avg': return 'Avg / ' + f.singular.toLowerCase();
    case 'new_job':  return 'New '  + f.singular.toLowerCase();
    case 'add_job':  return 'Add '  + f.singular.toLowerCase();
    case 'edit_job': return 'Edit ' + f.singular.toLowerCase();
    case 'save_job': return 'Save ' + f.singular.toLowerCase();
    case 'delete_job': return 'Delete ' + f.singular.toLowerCase();
    case 'no_jobs':  return 'No ' + f.plural.toLowerCase() + ' yet';
    default: return null;
  }
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
    nav_home:'Home', nav_jobs:'Jobs', nav_docs:'Docs', nav_book:'Book', nav_more:'More',
    'nav_jobs@creative':'Gigs', 'nav_jobs@tech':'Projects', 'nav_jobs@service':'Lessons', 'nav_jobs@photographer':'Shoots', 'nav_jobs@sales':'Visits', 'nav_jobs@gym':'Sessions',
    // dashboard
    earned_this_month:'Earned this month', net_after_expenses:'net after expenses',
    stat_jobs:'Jobs', stat_avg:'Avg / job', stat_expenses:'Expenses',
    'stat_jobs@creative':'Gigs','stat_jobs@tech':'Projects','stat_jobs@service':'Lessons','stat_jobs@photographer':'Shoots','stat_jobs@sales':'Visits','stat_jobs@gym':'Sessions',
    'stat_avg@sales':'Avg / visit','stat_avg@creative':'Avg / gig','stat_avg@tech':'Avg / project','stat_avg@service':'Avg / lesson','stat_avg@photographer':'Avg / shoot','stat_avg@gym':'Avg / session',
    todays_goal:"Today's goal", goal_reached:'Goal reached! 🎉', goal_of:'of',
    action_queue:'Action queue', queue_empty:'You’re all caught up.', queue_empty_sub:'New tasks will appear here as you add jobs and invoices.',
    quick_actions:'Quick actions', new_job:'New job', new_invoice:'New invoice',
    'new_job@creative':'New gig','new_job@tech':'New project','new_job@service':'New lesson','new_job@photographer':'New shoot','new_job@sales':'New visit','new_job@gym':'New session',
    coming_m2:'Invoices ship in M2',
    // jobs list
    jobs_title:'Jobs',
    'jobs_title@creative':'Gigs','jobs_title@tech':'Projects','jobs_title@service':'Lessons','jobs_title@photographer':'Shoots','jobs_title@sales':'Visits','jobs_title@gym':'Sessions',
    no_jobs:'No jobs yet', no_jobs_sub:'Tap + to log your first job.',
    'no_jobs@creative':'No gigs yet','no_jobs@tech':'No projects yet','no_jobs@service':'No lessons yet','no_jobs@photographer':'No shoots yet','no_jobs@sales':'No visits yet','no_jobs@gym':'No sessions yet',
    'no_jobs_sub@creative':'Tap + to log your first gig.','no_jobs_sub@tech':'Tap + to log your first project.','no_jobs_sub@service':'Tap + to log your first lesson.','no_jobs_sub@photographer':'Tap + to log your first shoot.','no_jobs_sub@sales':'Tap + to log your first visit.','no_jobs_sub@gym':'Tap + to log your first session.',
    // job form
    add_job:'Add job', edit_job:'Edit job', save_job:'Save job', delete_job:'Delete job',
    'add_job@creative':'Add gig','add_job@tech':'Add project','add_job@service':'Add lesson','add_job@photographer':'Add shoot','add_job@sales':'Add visit','add_job@gym':'Add session',
    'edit_job@creative':'Edit gig','edit_job@tech':'Edit project','edit_job@service':'Edit lesson','edit_job@photographer':'Edit shoot','edit_job@sales':'Edit visit','edit_job@gym':'Edit session',
    'save_job@creative':'Save gig','save_job@tech':'Save project','save_job@service':'Save lesson','save_job@photographer':'Save shoot','save_job@sales':'Save visit','save_job@gym':'Save session',
    'delete_job@creative':'Delete gig','delete_job@tech':'Delete project','delete_job@service':'Delete lesson','delete_job@photographer':'Delete shoot','delete_job@sales':'Delete visit','delete_job@gym':'Delete session',
    field_date:'Date', field_start:'Start time', field_end:'End time',
    field_client:'Client', field_amount:'Amount', field_tip:'Tip', field_expense:'Expense', field_count:'Count', field_notes:'Notes',
    'field_client@service':'Student','field_client@sales':'Customer','field_client@gym':'Member',
    'field_amount@creative':'Fee','field_amount@tech':'Fee','field_amount@service':'Fee','field_amount@photographer':'Fee','field_amount@sales':'Earnings','field_amount@gym':'Fee',
    'field_count@creative':'Items','field_count@tech':'Tasks','field_count@service':'Sessions','field_count@photographer':'Photos','field_count@sales':'Calls','field_count@gym':'Sessions',
    field_client_ph:'e.g. Acme Co.', field_notes_ph:'Anything to remember…',
    net_take:'Net take', ends_next_day:'ends next day', duration:'Duration',
    // validation
    err_enter_date:'Please pick a date', err_amount:'Amount must be 0 or more', err_neg:'Values cannot be negative', err_too_big:'That value is too large',
    // settings
    more_title:'More', settings_title:'Settings', account:'Account', local_account:'Local account on this device',
    work_type:'Work type', preferences:'Preferences', currency:'Currency', theme:'Theme',
    theme_auto:'Auto', theme_light:'Light', theme_dark:'Dark',
    tax_defaults:'Tax defaults (for M2)', wht:'Withholding tax %', vat:'VAT %',
    daily_goal:'Daily income goal', data:'Data', export_csv:'Export CSV', backup_json:'Backup JSON', restore_json:'Restore JSON',
    total_jobs:'Total jobs', app_word:'App', version:'Version', logout:'Log out', exit_guest:'Exit guest mode',
    // placeholder modules
    invoices_title:'Invoices', docs_title:'Documents', book_title:'Booking',
    module_soon_h:'Coming soon', mod_invoices_p:'Send branded invoices, track paid / due / overdue, and auto-fill tax. Arrives in M2.',
    mod_docs_p:'Store contracts, receipts and portfolio files — all on your device. Arrives in M2.',
    mod_book_p:'Share a booking link and let clients pick a slot. Arrives in M3.',
    pill_m2:'Ships in M2', pill_m3:'Ships in M3',
    // onboarding
    onboard_title:'What kind of work do you do?', onboard_sub:'We’ll tailor labels and screens to fit. You can change this anytime in Settings.',
    // misc
    welcome:'Welcome', welcome_back:'Welcome back', guest_name:'Guest', logged_out:'Logged out',
    greeting_morning:'Good morning', greeting_afternoon:'Good afternoon', greeting_evening:'Good evening',
    cancel:'Cancel', saved:'Saved', deleted:'Deleted', job_saved:'Job saved', job_deleted:'Job deleted',
    exported:'Exported', restore_confirm:'Restore this backup? It REPLACES this account’s {n} current jobs + expenses. This cannot be undone.',
    restore_done:'Restored {n} records', restore_bad_file:'Not a valid Freelanz backup file',
    restore_failed:'Restore failed — your existing data was kept.',
    delete_job_confirm:'Delete this job?', name_saved:'Name saved',
    err_id_min3:'Enter an email or username (3+ characters).', err_pw_min4:'Password must be at least 8 characters.',
    err_pw_mismatch:'Passwords do not match.', err_account_exists:'That account already exists on this device.',
    err_no_account:'No account with that email on this device.', err_incorrect_pw:'Incorrect password.',
    // M1.5 — job type dropdown + custom
    whats_your_job:"What's your job?", choose_placeholder:'Choose…', custom_option:'Custom…',
    custom_name_label:'Name it', custom_name_ph:'e.g. Yoga instructor',
    custom_unit_label:'One unit is a', custom_unit_ph:'e.g. Class',
    custom_needs_both:'Enter both a name and a unit', continue_btn:'Continue',
    // M1.5 — customers
    manage:'Manage', customers_title:'Customers', add_customer:'Add customer', edit_customer:'Edit customer',
    save_customer:'Save customer', delete_customer:'Delete customer', delete_customer_confirm:'Delete this customer?',
    no_customers:'No customers yet', no_customers_sub:'Add your first customer to reuse their details.',
    customer_saved:'Customer saved', customer_deleted:'Customer deleted',
    field_name:'Name', field_phone:'Phone', field_email:'Email', field_tags:'Tags (comma-separated)',
    field_taxid:'Tax ID', field_billing:'Billing address', field_company:'Company',
    field_health:'Health notes', field_allergies:'Allergies', field_goals:'Goals', field_usage:'Usage rights',
    err_name_required:'Please enter a name',
    // M1.5 — services
    services_title:'Services', add_service:'Add service', edit_service:'Edit service', save_service:'Save service',
    delete_service:'Delete service', delete_service_confirm:'Delete this service?',
    no_services:'No services yet', no_services_sub:'Add services to prefill fees when logging work.',
    service_saved:'Service saved', service_deleted:'Service deleted',
    field_rate:'Default rate', field_unit:'Unit', field_unit_ph:'e.g. session, hour, project',
    // M1.5 — job form links
    field_customer:'Customer', field_service:'Service', none_option:'— None —',
    export_customers_csv:'Export customers CSV',
  }
};
function curLang() { return (settings && settings.lang) || localStorage.getItem('ui_lang') || 'en'; }
function t(key) {
  const l = curLang();
  const wt = settings && settings.workType;
  if (wt === 'custom') {
    const c = customLabelForKey(key);
    if (c != null) return c;
  } else if (wt) {
    const sk = key + '@' + wt;
    const scoped = (I18N[l] && I18N[l][sk]) ?? I18N.en[sk];
    if (scoped != null) return scoped;
  }
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
function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
// Duration in hours from a job's start/end (crosses midnight when end <= start).
function sessionHours(s) {
  if (!s.startTime || !s.endTime) return 0;
  const sd = s.date, ed = s.endDate || s.date;
  const start = new Date(`${sd}T${s.startTime}:00`);
  let end = new Date(`${ed}T${s.endTime}:00`);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
  if (end <= start) end = new Date(end.getTime() + 86400000);
  return (end - start) / 3600000;
}
function fmtHours(h) { const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return `${hh}h ${mm}m`; }
function inferEndDate(sd, st, en) {
  if (sd && st && en && en <= st) { const nd = new Date(sd + 'T00:00:00'); nd.setDate(nd.getDate() + 1); return isoOf(nd); }
  return sd;
}
function fmt(n, dec=0) { return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec}); }
function money(n, dec=0) { return curSym() + fmt(n, dec); }
function netOf(j) { return (Number(j.amount)||0) + (Number(j.tip)||0) - (Number(j.expense)||0); }

// ─── THEME ────────────────────────────────────────────────────────────
// M1.5: dark mode is PAUSED. applyTheme always forces light regardless of OS
// (the [data-theme="light"] token block overrides the prefers-color-scheme dark
// media query). The dark-theme CSS tokens are kept in styles.css but dormant.
function applyTheme() {
  localStorage.setItem('ui_theme', 'light');
  document.documentElement.dataset.theme = 'light';
}

// ─── BOOT ─────────────────────────────────────────────────────────────
function showPostLoginToast() {
  const msg = sessionStorage.getItem('post_login_toast');
  if (msg) { sessionStorage.removeItem('post_login_toast'); toast(msg); }
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
  renderPersonaControls();

  // First-run onboarding: choose a work type before the dashboard.
  if (!settings.workType) { openOnboarding(); }
  else {
    document.body.setAttribute('data-work-type', settings.workType);
    await seedServicesIfEmpty();
    switchScreen('home');
  }
}

function displayName() {
  if (isGuest) return t('guest_name');
  return (currentUser && currentUser.firstName) ? currentUser.firstName : (currentUser ? currentUser.username : '');
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
  customers.sort((a,b) => (a.name||'').localeCompare(b.name||''));
  services = (await dbAll('services')).filter(s => s.uid === uid);
  services.sort((a,b) => (a.name||'').localeCompare(b.name||''));
  renderHome();
  renderJobs();
  renderCustomers();
  renderServices();
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('set-count', jobs.length);
  const badge = document.getElementById('jobs-badge');
  if (badge) {
    if (jobs.length > 0) { badge.textContent = jobs.length; badge.style.display = 'flex'; }
    else badge.style.display = 'none';
  }
}

// ─── DASHBOARD (Home) ─────────────────────────────────────────────────
function monthKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function jobsThisMonth() { const m = monthKey(); return jobs.filter(j => (j.date||'').startsWith(m)); }
function jobsToday() { const t0 = todayISO(); return jobs.filter(j => j.date === t0); }

function renderHome() {
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
  // action queue: empty state until there is anything to surface (M1 has no
  // real queue items yet — invoices/reminders arrive in M2).
  const q = document.getElementById('queue-body');
  if (q) {
    q.innerHTML = `<div class="empty"><div class="empty-icon">✅</div>
      <p data-i18n="queue_empty">${t('queue_empty')}</p>
      <span data-i18n="queue_empty_sub">${t('queue_empty_sub')}</span></div>`;
  }
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
function renderJobs() {
  const wrap = document.getElementById('jobs-body');
  if (!wrap) return;
  if (!jobs.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-icon">🧾</div>
      <p data-i18n="no_jobs">${t('no_jobs')}</p>
      <span data-i18n="no_jobs_sub">${t('no_jobs_sub')}</span></div>`;
    return;
  }
  const esc = htmlEsc;
  wrap.innerHTML = '<div class="list-card">' + jobs.map(j => {
    // Title = service name → localized unit word (e.g. "Session"); subtitle = client · date.
    const title = j.serviceName ? esc(j.serviceName) : esc(unitWord());
    const sub = [j.client, fmtDate(j.date)].filter(Boolean).join(' · ');
    const hrs = sessionHours(j);
    return `<div class="list-row" onclick="openEditJob(${j.id})">
      <div class="list-icon">🧾</div>
      <div class="list-main">
        <div class="list-title">${title}</div>
        <div class="list-sub">${esc(sub)}${hrs>0?' · '+fmtHours(hrs):''}</div>
      </div>
      <div class="list-right">
        <div class="list-amt tnum pos">${money(netOf(j))}</div>
        ${(j.count>0)?`<div class="list-amt-sub tnum">${j.count} ${esc(t('field_count').toLowerCase())}</div>`:''}
      </div>
    </div>`;
  }).join('') + '</div>';
}

// ─── JOB FORM (modal) ─────────────────────────────────────────────────
// Populate the job form's customer + service dropdowns (per-uid lists) and set
// the current selection.
function populateJobSelects(selCustomerId, selServiceId) {
  const cs = document.getElementById('j-customer');
  if (cs) {
    cs.innerHTML = `<option value="">${htmlEsc(t('none_option'))}</option>` +
      customers.map(c => `<option value="${c.id}">${htmlEsc(c.name)}</option>`).join('');
    cs.value = selCustomerId != null ? String(selCustomerId) : '';
  }
  const ss = document.getElementById('j-service');
  if (ss) {
    ss.innerHTML = `<option value="">${htmlEsc(t('none_option'))}</option>` +
      services.map(s => `<option value="${s.id}">${htmlEsc(s.name)} · ${htmlEsc(money(s.rate))}</option>`).join('');
    ss.value = selServiceId != null ? String(selServiceId) : '';
  }
}
function onJobCustomerChange(v) {
  if (!v) return;
  const c = customers.find(x => x.id === parseInt(v));
  if (c) document.getElementById('j-client').value = c.name || '';
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
  ['j-start','j-end','j-client','j-amount','j-tip','j-expense','j-count','j-notes'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  populateJobSelects('', '');
  document.getElementById('j-delete').style.display = 'none';
  clearFieldErrors();
  calcNet(); calcDuration();
  openJobModal();
}
function openEditJob(id) {
  const j = jobs.find(x => x.id === id);
  if (!j) return;
  document.getElementById('modal-title').textContent = t('edit_job');
  document.getElementById('j-edit-id').value = String(id);
  const set = (i,v)=>{ const el=document.getElementById(i); if(el) el.value = (v==null?'':v); };
  set('j-date', j.date); set('j-start', j.startTime); set('j-end', j.endTime);
  set('j-client', j.client); set('j-amount', j.amount); set('j-tip', j.tip);
  set('j-expense', j.expense); set('j-count', j.count); set('j-notes', j.notes);
  populateJobSelects(j.clientId != null ? j.clientId : '', j.serviceId != null ? j.serviceId : '');
  document.getElementById('j-delete').style.display = 'block';
  clearFieldErrors();
  calcNet(); calcDuration();
  openJobModal();
}
function openJobModal() { document.getElementById('modal-job').classList.add('open'); }
function closeJobModal() { document.getElementById('modal-job').classList.remove('open'); }

function calcNet() {
  const num = id => parseFloat(document.getElementById(id).value) || 0;
  const net = num('j-amount') + num('j-tip') - num('j-expense');
  document.getElementById('j-net').textContent = money(net, 0);
}
function calcDuration() {
  const sd = document.getElementById('j-date').value;
  const st = document.getElementById('j-start').value;
  const en = document.getElementById('j-end').value;
  const durEl = document.getElementById('j-dur');
  const ovn = document.getElementById('j-overnight');
  if (!(sd && st && en)) { if (durEl) durEl.textContent = '—'; if (ovn) ovn.style.display='none'; return; }
  const overnight = en <= st;
  const ed = inferEndDate(sd, st, en);
  if (ovn) ovn.style.display = overnight ? 'inline' : 'none';
  const h = sessionHours({date: sd, startTime: st, endDate: ed, endTime: en});
  if (durEl) durEl.textContent = h > 0 ? fmtHours(h) : '—';
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
  const startTime = document.getElementById('j-start').value || '';
  const endTime = document.getElementById('j-end').value || '';
  const client = (document.getElementById('j-client').value || '').trim();
  const amount = num('j-amount'), tip = num('j-tip'), expense = num('j-expense');
  const count = parseInt(document.getElementById('j-count').value) || 0;
  const notes = (document.getElementById('j-notes').value || '').trim();
  clearFieldErrors();
  if (!date) { markFieldError('j-date', 'err_enter_date'); return; }
  if (amount < 0) { markFieldError('j-amount', 'err_neg'); return; }
  for (const [fid, val, max] of [['j-amount',amount,100000000],['j-tip',tip,100000000],['j-expense',expense,100000000],['j-count',count,100000]]) {
    if (val < 0) { markFieldError(fid, 'err_neg'); return; }
    if (val > max) { markFieldError(fid, 'err_too_big'); return; }
  }
  const uid = isGuest ? 'guest' : currentUser.id;
  const endDate = inferEndDate(date, startTime, endTime);
  // Optional customer + service links (free-text client still works if none picked).
  const custVal = document.getElementById('j-customer').value;
  const clientId = custVal ? parseInt(custVal) : null;
  const svcVal = document.getElementById('j-service').value;
  const serviceId = svcVal ? parseInt(svcVal) : null;
  const svc = serviceId != null ? services.find(s => s.id === serviceId) : null;
  const serviceName = svc ? svc.name : '';
  const obj = {uid, date, startTime, endTime, endDate, client, clientId, serviceId, serviceName,
    jobType: settings.workType || '',
    amount, tip, expense, count, notes, netAmount: amount + tip - expense};
  const editId = document.getElementById('j-edit-id').value;
  if (editId) {
    const id = parseInt(editId);
    const prev = jobs.find(j => j.id === id);
    if (!prev) return;
    obj.id = id; obj.cuid = prev.cuid || cuid();
    obj.jobType = prev.jobType || settings.workType || '';   // preserve the job's original work type on edit
  } else {
    obj.cuid = cuid();
  }
  obj.updatedAt = nowISO();
  const key = await dbPut('jobs', obj);
  if (obj.id == null) obj.id = key;
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

// ─── ONBOARDING / WORK TYPE (dropdown + Custom) ───────────────────────
// <option> list shared by the onboarding + settings dropdowns.
function personaOptionsHTML() {
  return PERSONAS.map(p => `<option value="${p.id}">${p.icon} ${p.label}</option>`).join('') +
    `<option value="custom">${htmlEsc(t('custom_option'))}</option>`;
}
function openOnboarding() {
  const sel = document.getElementById('ob-jobtype');
  if (sel) {
    sel.innerHTML = `<option value="" disabled selected>${htmlEsc(t('choose_placeholder'))}</option>` + personaOptionsHTML();
    sel.value = '';
  }
  const custom = document.getElementById('ob-custom');
  if (custom) custom.style.display = 'none';
  ['ob-custom-name','ob-custom-unit'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('onboarding').classList.add('open');
}
function onOnboardTypeChange(v) {
  const custom = document.getElementById('ob-custom');
  if (custom) custom.style.display = v === 'custom' ? 'block' : 'none';
}
async function confirmOnboarding() {
  const v = document.getElementById('ob-jobtype').value;
  if (!v) { toast(t('choose_placeholder')); return; }
  if (v === 'custom') {
    const name = (document.getElementById('ob-custom-name').value || '').trim();
    const unit = (document.getElementById('ob-custom-unit').value || '').trim();
    if (!name || !unit) { toast(t('custom_needs_both')); return; }
    await saveSetting('customLabel', name);
    await saveSetting('customUnit', unit);
  }
  await saveSetting('workType', v);
  document.body.setAttribute('data-work-type', v);
  document.getElementById('onboarding').classList.remove('open');
  await seedServicesIfEmpty();
  renderPersonaControls();
  applyLang();
  switchScreen('home');
}
// Settings work-type dropdown + custom inputs (mirrors onboarding).
function renderPersonaControls() {
  const sel = document.getElementById('set-worktype');
  if (sel) { sel.innerHTML = personaOptionsHTML(); sel.value = settings.workType || ''; }
  const row = document.getElementById('set-custom-row');
  if (row) row.style.display = settings.workType === 'custom' ? 'flex' : 'none';
  if (settings.workType === 'custom') {
    const n = document.getElementById('set-custom-name'), u = document.getElementById('set-custom-unit');
    if (n) n.value = settings.customLabel || '';
    if (u) u.value = settings.customUnit || '';
  }
}
async function onSettingsTypeChange(v) {
  await saveSetting('workType', v);
  document.body.setAttribute('data-work-type', v);
  const row = document.getElementById('set-custom-row');
  if (row) row.style.display = v === 'custom' ? 'flex' : 'none';
  await seedServicesIfEmpty();
  renderPersonaControls();
  applyLang();
  toast(t('saved'));
}
async function onCustomEdit() {
  const name = (document.getElementById('set-custom-name').value || '').trim();
  const unit = (document.getElementById('set-custom-unit').value || '').trim();
  await saveSetting('customLabel', name);
  await saveSetting('customUnit', unit);
  applyLang();
}

// ─── CUSTOMERS (records only — history/stats are BACKLOG) ──────────────
// Persona intake fields shown per work type (field-schema-per-workType).
const CUSTOMER_INTAKE = {
  gym:          [{id:'healthNotes', key:'field_health'}, {id:'allergies', key:'field_allergies'}, {id:'goals', key:'field_goals'}],
  photographer: [{id:'usageRights', key:'field_usage'}],
  _default:     [{id:'company', key:'field_company'}],
};
function intakeFields() { return CUSTOMER_INTAKE[settings.workType] || CUSTOMER_INTAKE._default; }
function renderCustomers() {
  const wrap = document.getElementById('customers-body');
  if (!wrap) return;
  if (!customers.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-icon">👤</div>
      <p>${htmlEsc(t('no_customers'))}</p><span>${htmlEsc(t('no_customers_sub'))}</span></div>`;
    return;
  }
  wrap.innerHTML = '<div class="list-card">' + customers.map(c => {
    const sub = c.company || c.phone || c.email || '';
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
function closeCustomerModal() { document.getElementById('modal-customer').classList.remove('open'); }
function openAddCustomer() {
  document.getElementById('cust-modal-title').textContent = t('add_customer');
  document.getElementById('c-edit-id').value = '';
  ['c-name','c-phone','c-email','c-tags','c-notes','c-taxid','c-billing'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
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
  } else { obj.cuid = cuid(); }
  obj.updatedAt = nowISO();
  await dbPut('clients', obj);
  closeCustomerModal();
  await reload();
  toast(t('customer_saved'));
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
// Example services seeded once per work type (editable/deletable). Numbers are
// currency-agnostic. Custom work types are not auto-seeded.
const SEED_SERVICES = {
  gym:          [['1-on-1 session',800,'session'],['Group class',400,'session'],['Nutrition plan',2000,'plan']],
  photographer: [['Portrait shoot',3500,'shoot'],['Event coverage',8000,'event'],['Product shoot',2500,'shoot']],
  creative:     [['Logo design',5000,'project'],['Social video',3000,'video'],['Copywriting',1500,'piece']],
  tech:         [['Website build',30000,'project'],['Bug fix',1500,'fix'],['Consulting hour',1200,'hour']],
  service:      [['1-hour lesson',600,'hour'],['Package of 10',5000,'package']],
  sales:        [['Consultation',1000,'visit'],['Policy review',800,'review']],
};
async function seedServicesIfEmpty() {
  const wt = settings.workType;
  if (!wt || wt === 'custom') return;
  const flag = 'servicesSeeded_' + wt;
  if (settings[flag]) return;                       // already seeded this type
  const uid = isGuest ? 'guest' : currentUser.id;
  const existing = (await dbAll('services')).filter(s => s.uid === uid);
  if (existing.length) { await saveSetting(flag, true); return; }   // never overwrite user data
  const seeds = SEED_SERVICES[wt];
  if (seeds) for (const [name, rate, unit] of seeds) {
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
  if (key === 'lang') localStorage.setItem('ui_lang', val);
}
async function onCurrencyChange(v) { await saveSetting('currency', v); applyLang(); }
async function onGoalChange(v) { const n = parseFloat(v); await saveSetting('dailyGoal', isNaN(n)?0:n); renderGoal(); }
async function onWhtChange(v) { const n = parseFloat(v); await saveSetting('wht', isNaN(n)?null:n); }
async function onVatChange(v) { const n = parseFloat(v); await saveSetting('vat', isNaN(n)?null:n); }
async function onPromptPayChange(v) { await saveSetting('promptpayId', (v||'').trim()); }

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
  let csv = 'Name,Phone,Email,Tags,Tax ID,Billing address,Notes\n';
  customers.forEach(c => {
    csv += `${csvCell(c.name||'')},${csvCell(c.phone||'')},${csvCell(c.email||'')},${csvCell(c.tags||'')},`
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
    app: 'Freelanz', version: APP_VERSION, exportedAt: nowISO(),
    user: (currentUser && currentUser.username) || 'guest',
    settings: settings, theme: 'light',   // dark mode paused in M1.5; restore never flips theme
  };
  BACKUP_STORES.forEach((s, i) => { backup[s] = allByStore[i].filter(r => r.uid === uid); });
  const blob = new Blob([JSON.stringify(backup, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `freelanz-backup-${backup.user}-${todayISO()}.json`;
  a.click();
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
  if (!data || data.app !== 'Freelanz' || !Array.isArray(data.jobs)) { toast(t('restore_bad_file')); return; }
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
      if (key === 'lang') continue;
      await saveSetting(key, data.settings[key]);
    }
    if (data.settings.workType) document.body.setAttribute('data-work-type', data.settings.workType);
  }
  await reload();
  renderPersonaControls();
  applyLang();
  toast(t('restore_done').replace('{n}', n));
}

// ─── NAV / SCREENS ────────────────────────────────────────────────────
function switchScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => { b.classList.remove('active'); b.removeAttribute('aria-current'); });
  document.getElementById('s-'+name)?.classList.add('active');
  const navBtn = document.getElementById('nav-'+name);
  if (navBtn) { navBtn.classList.add('active'); navBtn.setAttribute('aria-current','page'); }
  const fab = document.getElementById('fab');
  if (fab) fab.style.display = (name === 'home' || name === 'jobs') ? 'flex' : 'none';
  if (name === 'home') renderHome();
  if (name === 'customers') renderCustomers();
  if (name === 'services') renderServices();
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
// Dashboard "New invoice" quick action → open the invoices screen, then its form
// if the invoicing module has loaded.
function newInvoice() {
  switchScreen('invoices');
  if (typeof openInvoiceForm === 'function') openInvoiceForm();
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
  try { if (currentUser) { renderHome(); renderJobs(); applyUser(); } } catch(e) {}
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
