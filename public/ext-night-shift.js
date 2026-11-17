// Night shift: the pane on the PC, the phone and a paired browser (wave 6, ns3). Loaded by ext.js and adds itself through window.MuseUI.
// Night shift is a short list of one-off jobs the owner leaves for Plenum; during the hours (23:00 to 07:00 by default) Plenum works through
// them one at a time, as ordinary chat turns in the business's Jobs thread, spending only plan time that would otherwise go unused.
// The server owns every fact (lib/jobs.mjs, lib/pacer.mjs, lib/routes/night-shift.mjs); this file only draws what it says and sends the
// owner's own changes:
//   GET  /api/night-shift                 { v, settings, hours, status: { code, line }, awake: { on, line }, running, jobs, businesses,
//                                           newer?, damaged? }   (not gated: it answers from the last tick's readings)
//   POST /api/night-shift/jobs            { business, text, doneWhen?, lead?, source? }   adds a job; only the owner adds one
//   POST /api/night-shift/jobs/move       { id, to }      /jobs/remove { id }   /jobs/continue { id }   /jobs/done { id }
//   POST /api/night-shift/stop            { id }          stops the job's run (routines.stop on the server)
//   POST /api/night-shift/settings        { from?, to?, share?, countRuns?, keepAwake?, on? }
//   POST /api/night-shift/resume          {}              ends the hold after a Stop
//   GET  /api/night-shift/suggestions     { suggestions: [{ business, name, text, sha256, at, lead }] }   (ns4: lines models left as NEXT)
//   POST /api/night-shift/suggestions/dismiss { business, sha256 }
// Suggested jobs are only text: "Use as job" fills the form with the exact words, and the owner still presses Add job (sent with
// source: 'suggested'). Nothing becomes a job without that tap.
// Every change on the server publishes { type: 'night-shift', action: 'changed' }; a Stop or Resume publishes { type: 'routine',
// action: 'hold' | 'resume' }. The pane reads again on both.
// Words: the status line and the keep-awake line are the server's own sentences when it sends them; the words below are used only
// when it sends a code without a line (an older server), and say exactly the same thing.
// Access: a phone or a paired browser below Full may read the pane and use Stop all (POST /api/stop-all), and nothing else. Every
// other control is switched off for it and no other POST is sent. Should the Bridge refuse the GET below Full (an older server
// gated it), the pane says so and keeps Stop all.
// Auto routing (wave 6, ar3): a business with autoLeads: true (businesses[].autoLeads) has its "First with room" option worded as Auto,
// and a run Auto picked carries auto (runs[].auto, "Auto: <lead>, <effort>: ..."), which the last-run line goes on with.
// A job that needs the owner has "Open the Jobs thread" (its folder's Jobs thread on screen, as the Setup card opens its chat) and a line.
// Text goes in only through textContent; colours come only from the tokens in style.css.
(function () {
  'use strict';
  const MU = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it, or without the side pane, there is nothing to attach to.
  if (!MU || !MU.pane || typeof MU.pane.register !== 'function') return;

  const TAB = 'night-shift';
  const TITLE = 'Night shift';
  const BASE = '/api/night-shift';
  const STOP_ALL = '/api/stop-all';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAX_RUNS = 3;
  const TEXT_MAX = 4000;
  const DONE_MAX = 300;
  const POLL_MS = 60000;

  const TEXT = {
    empty: 'Leave a job here and Plenum works on it overnight, using only plan time you would otherwise lose.',
    what: 'What should be done?',
    whatHint: 'Re-score last week\'s rejects with the new rubric.',
    doneWhen: 'Done when',
    doneHint: 'The report lists what changed.',
    business: 'Business',
    lead: 'Lead',
    firstRoom: 'First with room',
    firstAuto: 'Auto (from the job and the room left)',
    add: 'Add job',
    addHead: 'Add a job',
    jobsHead: 'Jobs',
    settingsHead: 'Settings',
    resume: 'Resume',
    resumeNote: 'Resume lets routines and Night shift start again.',
    stopAll: 'Stop all',
    off: 'Night shift is off.',
    here: 'Waiting while you\'re at this PC.',
    noroom: 'Waiting: no plan has room to spare tonight.',
    awakeOn: to => `Keeping this PC awake until ${to} while jobs wait.`,
    awakeMaySleep: 'This PC may sleep. Jobs wait until it is awake during the hours.',
    awakeDesktop: 'Keeping the PC awake works in the desktop app.',
    newer: 'Night shift was saved by a newer Plenum. This version shows it and does not change it.',
    damaged: 'The Night shift list could not be read, so a copy of it was kept beside it and the list starts again.',
    needFull: dev => `Changing Night shift needs Full access on this ${dev}. You can read everything here, and Stop all still works. Change what this ${dev} can do at the computer under Settings › Phones.`,
    refused: dev => `Night shift shows here only with Full access on this ${dev}. Stop all still works. Change what this ${dev} can do at the computer under Settings › Phones.`,
    noBusiness: 'Night shift jobs belong to a business. Add a business first, under Businesses.',
    readOnlyFolder: 'The Jobs thread is read-only in this folder, so a job can only read and report. Turn on More than one thread may write.',
    noAnswer: 'Plenum did not answer. Check that it is running.',
    missing: 'Night shift is not in this version of Plenum yet.',
    notRead: 'Night shift could not be read just now. It tries again in a minute.',
    loading: 'Reading Night shift…',
    hours: 'Hours',
    hoursFrom: 'From',
    hoursTo: 'To',
    share: 'Use at most half of what would go unused',
    shareNote: 'How much of the plan time that would go unused Night shift may use. Never past your line.',
    countRuns: 'Runs a night for plans that don\'t report use',
    keepAwake: 'Keep this PC awake while jobs wait',
    keepAwakeNote: 'Only while jobs wait during the hours. The tray says so while it is on.',
    onSwitch: 'Night shift',
    added: 'Job added. It waits for the hours.',
    stopAllSent: 'Stop all was sent.',
    removeAsk: 'Remove this job?',
    removeBody: name => `"${name}" is taken off the list. Its runs stay in the Jobs thread.`,
    remove: 'Remove',
    suggestHead: 'Suggested jobs',
    useAsJob: 'Use as job',
    dismiss: 'Dismiss',
    suggestFilled: 'The form has the suggestion. Press Add job to leave it.',
    // A job that has had its 3 runs cannot be continued (lib/jobs.mjs cont() refuses it): the row says so and offers Add again.
    fullRuns: `It has had its ${MAX_RUNS} runs. Add it again to go on.`,
    addAgainNote: 'To go on, add it again as a new job.',
    addAgain: 'Add again',
    againFilled: 'The form has this job\'s words. Press Add job to add it again.',
    // An Ask-first folder: each change a job makes waits for an answer, and overnight nobody is there to give one.
    askFolder: 'This folder is on Ask first, so each change a job makes waits for you, and overnight nobody answers. To let jobs change files, set the folder to Auto-approve.',
    askJob: 'Its folder is on Ask first, so its changes wait for you. Set the folder to Auto-approve, then press Continue tonight.',
    // A job that needs the owner (ar3, integration review finding 10): where to answer, and what to press after.
    openJobs: 'Open the Jobs thread',
    answerJobs: 'Answer in the Jobs thread, then press Continue tonight.',
    noJobsThread: 'The Jobs thread of that folder is not open. Open the folder and look under Threads.',
    jobsNotOpened: 'The Jobs thread could not be opened.',
  };
  const PILL = {
    waiting: ['Waiting', ''],
    running: ['Running', 'accent'],
    done: ['Done', 'green'],
    'needs-you': ['Needs you', 'amber'],
    stopped: ['Stopped', ''],
    'not-finished': ['Not finished', 'red'],
  };
  const COUNTED = [['gemini', 'Gemini'], ['antigravity', 'Antigravity'], ['cursor', 'Cursor'], ['grok', 'Grok']];
  const SHARES = [10, 20, 30, 40, 50];
  // The most runs a night the server takes for one of those plans (lib/jobs.mjs LIMITS.countRuns).
  const MAX_COUNT = 20;

  // ---------- small helpers ----------

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arr = v => (Array.isArray(v) ? v : []);
  const str = v => (typeof v === 'string' ? v : '');
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null && text !== '') n.textContent = String(text);
    return n;
  }
  function btn(cls, text, key) {
    const b = mk('button', cls, text);
    b.type = 'button';
    if (key) b.dataset.fk = key;
    return b;
  }
  const two = n => String(n).padStart(2, '0');
  // A time as the page writes it, 24-hour: "01:12". A value that is not a time gives ''.
  function hhmm(v) {
    const t = typeof v === 'number' ? v : Date.parse(str(v));
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
  }
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const providerOf = ref => str(ref).split(':')[0];
  function providerName(id) {
    try {
      const hit = arr(MU.providerRegistry).find(p => p && p.id === id);
      if (hit && str(hit.name)) return hit.name;
    } catch { /* the id is shown instead */ }
    return id || 'a model';
  }
  const leadName = ref => providerName(providerOf(ref));
  const waitingWords = n => (n === 0 ? 'No jobs waiting.' : n === 1 ? '1 job waiting.' : `${n} jobs waiting.`);
  const sentence = s => { const t = str(s).trim(); return !t || /[.!?…]$/.test(t) ? t : `${t}.`; };

  // ---------- access ----------

  function shellTier() {
    try {
      const shell = window.plenumShell;
      const c = shell && typeof shell.connection === 'function' ? shell.connection() : null;
      return str(c && c.tier) || str(shell && shell.tier);
    } catch { return ''; }
  }
  // A phone or a paired browser with Approve and watch or Read only. On the desktop there is no tier, and nothing is limited.
  const belowFull = () => { const t = shellTier(); return t === 'approve' || t === 'read'; };
  const device = () => (document.documentElement && document.documentElement.dataset && document.documentElement.dataset.surface === 'phone' ? 'phone' : 'browser');

  // ---------- the server ----------

  // { state: 'idle' | 'loading' | 'ok' | 'missing' | 'refused' | 'error', data, error }
  const D = { state: 'idle', data: null, error: '', readAt: 0 };
  let seq = 0;

  // A request. A POST that this access may not make is not sent: the Bridge would refuse it. Stop all always goes.
  async function ask(path, body) {
    if (body !== undefined && path !== STOP_ALL && belowFull()) return { ok: false, status: 403, error: TEXT.needFull(device()), data: null };
    let res;
    try {
      res = await MU.request(path, body === undefined ? {} : { method: 'POST', body });
    } catch {
      return { ok: false, status: 0, error: TEXT.noAnswer, data: null };
    }
    const data = await (res && typeof res.json === 'function' ? res.json().catch(() => null) : Promise.resolve(null));
    if (res && res.ok && isObj(data)) return { ok: true, status: res.status, data, error: '' };
    // The server's own sentence, exactly as it sent it (a 400 or a 409 such as "Stop it first."). Never a number.
    return { ok: false, status: res ? res.status : 0, data, error: str(data && data.error) || failWords(res ? res.status : 0) };
  }
  function failWords(status) {
    if (status === 0) return TEXT.noAnswer;
    if (status === 404) return TEXT.missing;
    return TEXT.notRead;
  }

  async function refresh() {
    const mine = ++seq;
    if (D.state === 'idle') D.state = 'loading';
    const r = await ask(BASE);
    if (mine !== seq) return;
    D.readAt = Date.now();
    if (r.ok) {
      D.state = 'ok';
      D.data = r.data;
      D.error = '';
    } else if (r.status === 403 && r.data && r.data.terms === true) {
      // The agreement comes first: the card is asked for only when the pane is on screen, never by the count read at start.
      D.state = 'error';
      D.error = r.error;
      if (shown()) { try { window.dispatchEvent(new CustomEvent('plenum:terms-required')); } catch { /* the card opens at start anyway */ } }
    } else if (r.status === 403 && belowFull()) {
      D.state = 'refused';
      D.data = null;
      D.error = '';
    } else if (r.status === 404) {
      D.state = 'missing';
      D.error = TEXT.missing;
    } else {
      // An answer that fails keeps the last good one on screen, with a line that says it could not be read again.
      D.state = D.data ? 'ok' : 'error';
      D.error = r.error;
    }
    paintCount();
    paint();
    if (r.ok) loadSuggestions();
  }
  let soon = 0;
  function refreshSoon(ms = 400) {
    clearTimeout(soon);
    soon = setTimeout(refresh, ms);
  }

  // ---------- what the answer says ----------

  const jobsOf = () => arr(D.data && D.data.jobs).filter(isObj);
  const businessesOf = () => arr(D.data && D.data.businesses).filter(b => isObj(b) && str(b.id));
  const settingsOf = () => (isObj(D.data && D.data.settings) ? D.data.settings : {});
  const hoursOf = () => {
    const s = settingsOf();
    const h = isObj(D.data && D.data.hours) ? D.data.hours : {};
    return { from: str(h.from) || str(s.from) || '23:00', to: str(h.to) || str(s.to) || '07:00' };
  };
  const waitingCount = () => jobsOf().filter(j => j.state === 'waiting').length;
  const isNewer = () => Boolean(D.data && D.data.newer);
  const readOnly = () => belowFull() || isNewer();
  const jobName = id => str(jobsOf().find(j => j.id === id)?.name);
  const businessName = id => str(businessesOf().find(b => b.id === id)?.name) || 'This business';

  // The status line. The server's sentence when it sends one; else the same words from the code.
  function statusLine() {
    const st = isObj(D.data && D.data.status) ? D.data.status : {};
    if (str(st.line).trim()) return st.line;
    return statusWords(str(st.code), st);
  }
  function statusWords(code, st) {
    const { from, to } = hoursOf();
    const n = waitingCount();
    const prov = str(st.provider) ? providerName(st.provider) : '';
    const run = isObj(D.data && D.data.running) ? D.data.running : null;
    switch (code) {
      case 'off': return TEXT.off;
      case 'before': return `Starts at ${from}. ${waitingWords(n)}`;
      case 'hold': {
        const hold = isObj(st.hold) ? st.hold : isObj(D.data && D.data.hold) ? D.data.hold : {};
        const at = hhmm(hold.at);
        const until = hhmm(hold.until);
        if (at && until) return `You pressed Stop at ${at}. Night shift starts again at ${until}.`;
        return until ? `You pressed Stop. Night shift starts again at ${until}.` : 'You pressed Stop. Night shift starts again in half an hour.';
      }
      case 'running': {
        const name = run ? jobName(run.jobId) : '';
        const who = run ? leadName(run.lead) : prov;
        return name ? `Working on "${name}" with ${who}.` : `Working on a job with ${who || 'a model'}.`;
      }
      case 'here': return TEXT.here;
      case 'using': return `Waiting: you're using ${prov || 'that plan'} right now.`;
      case 'outside': return `Waiting: ${prov || 'that plan'} is in use outside Plenum.`;
      case 'noroom': return TEXT.noroom;
      case 'day': return `Waiting: ${businessName(str(st.business))} keeps half of today's runs for the day.`;
      case 'unknown': return `Plenum can't tell yet how much of ${prov || 'the plan'} is left.`;
      case 'counted': return `${prov || 'That plan'} has had its ${num(st.runs) ?? 4} runs tonight.`;
      default: return `Working tonight until ${to}. ${waitingWords(n)}`;
    }
  }
  // The keep-awake line. Shown plainly whenever the PC is kept awake: it can never be switched off on its own.
  function awakeLine() {
    const a = isObj(D.data && D.data.awake) ? D.data.awake : null;
    if (!a) return '';
    if (typeof a.line === 'string') return a.line;
    if (a.on === true) return TEXT.awakeOn(hoursOf().to);
    if (a.desktop === false) return TEXT.awakeDesktop;
    return TEXT.awakeMaySleep;
  }
  // The lines under a job's name: its last run, the lead it was moved to and why, and the server's why.
  function runLines(job) {
    const runs = arr(job.runs).filter(isObj);
    const out = [];
    if (runs.length) {
      const last = runs[runs.length - 1];
      const who = leadName(last.lead);
      const at = hhmm(last.at);
      const of = `(run ${runs.length} of ${MAX_RUNS})`;
      // Auto's own sentence goes on the same line: "Ran on Codex at 01:12 (run 2 of 3). Auto: Codex, medium effort: …".
      const auto = str(last.auto).trim() ? ` ${sentence(last.auto)}` : '';
      if (job.state === 'running') out.push(`${at ? `Started on ${who} at ${at} ${of}.` : `Started on ${who} ${of}.`}${auto}`);
      else out.push(`${at ? `Ran on ${who} at ${at} ${of}.` : `Ran on ${who} ${of}.`}${auto}`);
      // A lead other than the first one is never used without saying so: "Ran on Codex: Claude had no room to spare."
      if (str(last.note).trim()) out.push(`Ran on ${who}: ${sentence(last.note)}`);
    }
    return out;
  }

  // ---------- the pane ----------

  let root = null;
  let parts = null;
  let pollTimer = 0;
  const busy = new Set();
  // The suggested jobs (ns4): { list: [{ business, name, text, sha256, at, lead }] }. Read after the main answer; a failure shows none.
  const SUG = { list: [], seq: 0 };
  const ui = { say: '', sayTone: '', source: 'owner', suggested: null };

  const shown = () => {
    try { return Boolean(root && MU.pane.active() === TAB && MU.pane.isOpen(TAB) && !(MU.el && MU.el.pane && MU.el.pane.hidden)); } catch { return Boolean(root); }
  };

  function say(text, tone = '') {
    ui.say = str(text);
    ui.sayTone = tone;
    if (parts) {
      parts.say.textContent = ui.say;
      parts.say.dataset.tone = tone;
    }
  }

  // One action of the owner's. The button's key is busy until the answer comes, so a second press does not send it twice.
  async function act(key, path, body, done) {
    if (busy.has(key)) return null;
    busy.add(key);
    paint();
    const r = await ask(path, body);
    busy.delete(key);
    if (r.ok) {
      if (typeof done === 'function') done(r.data);
      else say('');
    } else {
      say(r.error, 'bad');
    }
    await refresh();
    return r;
  }

  function build(body) {
    installIcon();
    root = mk('div', 'ns');
    const status = mk('section', 'ns-status');
    status.setAttribute('aria-live', 'polite');
    const awake = mk('p', 'ns-awake');
    const notes = mk('div', 'ns-notes');
    const sayEl = mk('p', 'ns-say');
    sayEl.setAttribute('role', 'status');
    const list = mk('section', 'ns-jobs');
    list.setAttribute('aria-label', TEXT.jobsHead);
    const form = buildForm();
    const settings = mk('section', 'ns-settings');
    settings.setAttribute('aria-label', TEXT.settingsHead);
    const suggest = mk('section', 'ns-jobs ns-suggest');
    suggest.setAttribute('aria-label', TEXT.suggestHead);
    suggest.hidden = true;
    root.append(status, awake, notes, sayEl, list, suggest, form.el, settings);
    parts = { status, awake, notes, say: sayEl, list, suggest, form, settings };
    // The settings are not drawn over while a control in them has the focus; they are drawn again once it leaves them.
    settings.addEventListener('focusout', () => setTimeout(() => {
      if (parts && parts.settings === settings && !(document.activeElement && settings.contains(document.activeElement))) paintSettings();
    }, 0));
    body.replaceChildren(root);
    say(ui.say, ui.sayTone);
    paint();
  }

  // ---------- the form (built once, so typing is never drawn over) ----------

  function field(label, control, id) {
    const wrap = mk('div', 'ns-field');
    const l = mk('label', 'ns-label', label);
    control.id = id;
    l.setAttribute('for', id);
    wrap.append(l, control);
    return wrap;
  }
  function buildForm() {
    const el = mk('section', 'ns-add');
    el.setAttribute('aria-label', TEXT.addHead);
    const head = mk('h3', 'ns-head', TEXT.addHead);
    const text = mk('textarea', 'ns-input ns-text');
    text.rows = 3;
    text.maxLength = TEXT_MAX;
    text.placeholder = TEXT.whatHint;
    text.dataset.fk = 'add|text';
    const doneWhen = mk('input', 'ns-input ns-done');
    doneWhen.type = 'text';
    doneWhen.maxLength = DONE_MAX;
    doneWhen.placeholder = TEXT.doneHint;
    doneWhen.dataset.fk = 'add|done';
    const business = mk('select', 'ns-input ns-biz');
    business.dataset.fk = 'add|business';
    const lead = mk('select', 'ns-input ns-lead');
    lead.dataset.fk = 'add|lead';
    const folderNote = mk('p', 'ns-note ns-folder');
    folderNote.hidden = true;
    const askNote = mk('p', 'ns-note ns-ask');
    askNote.hidden = true;
    const addBtn = btn('primary small ns-addbtn', TEXT.add, 'add|send');
    const row = mk('div', 'ns-pair');
    row.append(field(TEXT.business, business, 'ns-f-biz'), field(TEXT.lead, lead, 'ns-f-lead'));
    el.append(head, field(TEXT.what, text, 'ns-f-text'), field(TEXT.doneWhen, doneWhen, 'ns-f-done'), row, folderNote, askNote, addBtn);
    text.addEventListener('input', () => { syncAdd(); });
    business.addEventListener('change', () => { fillLeads(); syncAdd(); });
    addBtn.addEventListener('click', () => sendAdd());
    return { el, text, doneWhen, business, lead, addBtn, folderNote, askNote };
  }
  function option(value, label) {
    const o = mk('option', '', label);
    o.value = value;
    return o;
  }
  function fillBusinesses() {
    const f = parts.form;
    const list = businessesOf();
    const was = f.business.value;
    const key = list.map(b => `${b.id}\u0000${str(b.name)}`).join('\u0001');
    if (f.business.dataset.key !== key) {
      f.business.replaceChildren(...list.map(b => option(b.id, str(b.name) || b.id)));
      f.business.dataset.key = key;
    }
    if (list.some(b => b.id === was)) f.business.value = was;
    else if (list.length) f.business.value = list[0].id;
    fillLeads();
  }
  function fillLeads() {
    const f = parts.form;
    const b = businessesOf().find(x => x.id === f.business.value);
    const leads = arr(b && b.leads).filter(l => isObj(l) && str(l.ref));
    const was = f.lead.value;
    const auto = Boolean(b && b.autoLeads === true);
    const key = `${b ? b.id : ''}|${auto ? 'auto' : ''}|${leads.map(l => `${l.ref}\u0000${str(l.label)}`).join('\u0001')}`;
    if (f.lead.dataset.key !== key) {
      f.lead.replaceChildren(option('', auto ? TEXT.firstAuto : TEXT.firstRoom), ...leads.map(l => option(l.ref, str(l.label) || l.ref)));
      f.lead.dataset.key = key;
    }
    f.lead.value = leads.some(l => l.ref === was) ? was : '';
    // A folder where only its writer thread may write: a job there can only read and report, and the pane says so, as routines do.
    // The form sends no folder, so the job goes to the business's first folder (as the server does); its canWrite says whether the
    // Jobs thread may write there. multiWriter / readOnly on the business are kept only as fallbacks.
    const first = b && Array.isArray(b.projects) ? b.projects[0] : undefined;
    const ro = Boolean(b && ((isObj(first) && first.canWrite === false) || b.multiWriter === false || b.readOnly === true));
    f.folderNote.hidden = !ro;
    f.folderNote.textContent = ro ? (str(b.folderLine) || TEXT.readOnlyFolder) : '';
    // The first folder's approvals (ns1 sends 'ask' | 'auto' | 'all'): on Ask first a job's first change waits for a card nobody
    // answers at night, so it is said before the job is added, as routines show both folder facts. A read-only folder has its own line.
    const ask = Boolean(b && !ro && isObj(first) && first.approvals === 'ask');
    f.askNote.hidden = !ask;
    f.askNote.textContent = ask ? TEXT.askFolder : '';
  }
  // The folder a job runs in, as the answer describes it (its business's projects), or null.
  function folderOf(job) {
    const b = businessesOf().find(x => x.id === job.business);
    const list = b && Array.isArray(b.projects) ? b.projects.filter(isObj) : [];
    return list.find(p => p.id === job.project) || null;
  }
  // A run that ended on a card nobody answered: the server's flag when it sends one, else its sentence (lib/jobs.mjs ended()).
  const timedOut = job => {
    const last = arr(job.runs).filter(isObj).at(-1);
    return job.timedOut === true || Boolean(last && Number(last.unanswered) > 0) || /question for you timed out/i.test(str(job.why));
  };
  function syncAdd() {
    const f = parts && parts.form;
    if (!f) return;
    const locked = readOnly() || D.state !== 'ok';
    for (const c of [f.text, f.doneWhen, f.business, f.lead]) c.disabled = locked;
    f.addBtn.disabled = locked || busy.has('add|send') || !businessesOf().length || !f.text.value.trim();
  }
  // Sends exactly what the owner typed: the text and the Done when line are not trimmed or changed here (the server checks them).
  function sendAdd() {
    const f = parts.form;
    if (readOnly() || !f.text.value.trim() || !f.business.value) return;
    const body = { business: f.business.value, text: f.text.value };
    if (f.doneWhen.value !== '') body.doneWhen = f.doneWhen.value;
    if (f.lead.value) body.lead = f.lead.value;
    if (ui.source === 'suggested') body.source = 'suggested';
    // A suggestion the owner took is settled: after a successful add with its text unchanged, it is dismissed so it never comes back.
    const taken = ui.source === 'suggested' && ui.suggested && ui.suggested.business === body.business && ui.suggested.text === body.text ? ui.suggested : null;
    const sent = act('add|send', `${BASE}/jobs`, body, () => {
      f.text.value = '';
      f.doneWhen.value = '';
      f.lead.value = '';
      ui.source = 'owner';
      say(TEXT.added, 'ok');
    });
    if (taken) sent.then(async r => { if (r && r.ok) { await ask(`${BASE}/suggestions/dismiss`, { business: taken.business, sha256: taken.sha256 }); await loadSuggestions(); } }).catch(() => {});
  }
  // Fills the form (ns4's Use as job): nothing is added until the owner presses Add job.
  function fillForm({ business, text, doneWhen, lead } = {}, source = 'owner') {
    if (!parts) return false;
    ui.suggested = null;
    const f = parts.form;
    if (str(business) && businessesOf().some(b => b.id === business)) { f.business.value = business; fillLeads(); }
    if (typeof text === 'string') f.text.value = text.slice(0, TEXT_MAX);
    if (typeof doneWhen === 'string') f.doneWhen.value = doneWhen.slice(0, DONE_MAX);
    if (typeof lead === 'string') f.lead.value = [...f.lead.options].some(o => o.value === lead) ? lead : '';
    ui.source = source === 'suggested' ? 'suggested' : 'owner';
    syncAdd();
    try { f.text.focus(); } catch { /* the form is filled either way */ }
    return true;
  }

  // ---------- drawing ----------

  function paint() {
    if (!root || !parts) return;
    paintStatus();
    paintAwake();
    paintNotes();
    paintList();
    paintSuggest();
    if (D.state === 'ok') fillBusinesses();
    const hasBiz = businessesOf().length > 0;
    parts.form.el.hidden = D.state !== 'ok';
    let nob = parts.form.el.querySelector('.ns-nobiz');
    if (D.state === 'ok' && !hasBiz) {
      if (!nob) { nob = mk('p', 'ns-note ns-nobiz', TEXT.noBusiness); parts.form.addBtn.before(nob); }
    } else if (nob) nob.remove();
    syncAdd();
    paintSettings();
  }

  function paintStatus() {
    const box = parts.status;
    const kids = [];
    if (D.state === 'loading' || D.state === 'idle') kids.push(mk('p', 'ns-line', TEXT.loading));
    else if (D.state === 'refused') kids.push(mk('p', 'ns-line', TEXT.refused(device())));
    else if (D.state === 'missing') kids.push(mk('p', 'ns-line', TEXT.missing));
    else if (D.state === 'error' && !D.data) kids.push(mk('p', 'ns-line', D.error || TEXT.notRead));
    else {
      const st = isObj(D.data.status) ? D.data.status : {};
      const line = mk('p', 'ns-line', statusLine());
      line.dataset.code = str(st.code);
      kids.push(line);
      if (st.code === 'hold') {
        const resume = btn('primary small ns-resume', TEXT.resume, 'resume');
        resume.disabled = belowFull() || busy.has('resume');
        resume.addEventListener('click', () => act('resume', `${BASE}/resume`, {}));
        kids.push(resume, mk('p', 'ns-note ns-resume-note', TEXT.resumeNote));
      }
      if (D.error) kids.push(mk('p', 'ns-note ns-stale', D.error));
    }
    // Below Full the one thing this access can do: Stop all, the same as the phone's Stop.
    if (belowFull()) {
      const all = btn('ghost small ns-stop ns-stopall', TEXT.stopAll, 'stopall');
      all.disabled = busy.has('stopall');
      all.addEventListener('click', () => act('stopall', STOP_ALL, {}, () => say(TEXT.stopAllSent, 'ok')));
      kids.push(all);
    }
    box.replaceChildren(...kids);
  }

  function paintAwake() {
    const line = D.state === 'ok' ? awakeLine() : '';
    parts.awake.textContent = line;
    parts.awake.hidden = !line;
    const on = Boolean(D.data && isObj(D.data.awake) && D.data.awake.on === true);
    parts.awake.dataset.on = on ? 'true' : 'false';
  }

  function paintNotes() {
    const kids = [];
    if (D.state === 'ok' && isNewer()) kids.push(mk('p', 'ns-note ns-newer', TEXT.newer));
    if (D.state === 'ok' && D.data.damaged) kids.push(mk('p', 'ns-note ns-damaged', typeof D.data.damaged === 'string' && D.data.damaged.trim() ? D.data.damaged : TEXT.damaged));
    if (D.state === 'ok' && belowFull()) kids.push(mk('p', 'ns-note ns-needfull', TEXT.needFull(device())));
    parts.notes.replaceChildren(...kids);
    parts.notes.hidden = kids.length === 0;
  }

  function paintList() {
    const box = parts.list;
    if (D.state !== 'ok') { box.replaceChildren(); box.hidden = true; return; }
    box.hidden = false;
    const jobs = jobsOf();
    const head = mk('h3', 'ns-head', TEXT.jobsHead);
    if (!jobs.length) {
      box.replaceChildren(head, mk('p', 'ns-empty', TEXT.empty));
      return;
    }
    const ol = mk('ol', 'ns-list');
    jobs.forEach((job, i) => ol.append(jobRow(job, i, jobs)));
    box.replaceChildren(head, ol);
  }

  function jobRow(job, i, jobs) {
    const id = str(job.id);
    const li = mk('li', 'ns-job');
    li.dataset.job = id;
    li.dataset.state = str(job.state);
    const top = mk('div', 'ns-job-top');
    const name = mk('span', 'ns-job-name', str(job.name) || str(job.text).split('\n')[0].slice(0, 60));
    if (str(job.text)) name.title = job.text;
    const [word, tone] = PILL[job.state] || [str(job.state) || 'Waiting', ''];
    const pill = mk('span', 'pill ns-pill', word);
    if (tone) pill.dataset.tone = tone;
    top.append(name, pill);
    li.append(top);
    const biz = businessesOf().find(b => b.id === job.business);
    if (biz && businessesOf().length > 1) li.append(mk('p', 'ns-job-sub', str(biz.name)));
    for (const line of runLines(job)) li.append(mk('p', 'ns-job-run', line));
    if (str(job.why).trim()) li.append(mk('p', 'ns-job-why', sentence(job.why)));
    const runs = arr(job.runs).length;
    // After its last run a job cannot be continued: the row says why, and Add again puts its words back in the form.
    const spent = job.state === 'not-finished' || ((job.state === 'needs-you' || job.state === 'stopped') && runs >= MAX_RUNS);
    if (spent) li.append(mk('p', 'ns-job-why ns-job-spent', job.state === 'not-finished' ? TEXT.addAgainNote : TEXT.fullRuns));
    // A card that timed out in an Ask-first folder: the same thing would happen every night, so the row says what to change.
    const folder = folderOf(job);
    const askFirst = job.state === 'needs-you' && timedOut(job) && folder && folder.approvals === 'ask';
    if (askFirst) li.append(mk('p', 'ns-job-why ns-job-ask', TEXT.askJob));
    // Needs you: where to answer and what to press after (the Ask-first line above already says what to press).
    if (job.state === 'needs-you' && runs < MAX_RUNS && !askFirst) li.append(mk('p', 'ns-job-why ns-job-answer', TEXT.answerJobs));
    const row = mk('div', 'ns-job-acts');
    const add = (key, label, cls, path, body, enabled, extra) => {
      const b = btn(`${cls} small`, label, `${key}|${id}`);
      b.disabled = !enabled || busy.has(`${key}|${id}`);
      b.addEventListener('click', async () => {
        if (extra && !(await extra())) return;
        act(`${key}|${id}`, path, body);
      });
      row.append(b);
      return b;
    };
    const ro = readOnly();
    const running = job.state === 'running';
    const done = job.state === 'done';
    if (!done) {
      add('up', 'Move up', 'ghost', `${BASE}/jobs/move`, { id, to: i - 1 }, !ro && i > 0 && !running);
      add('down', 'Move down', 'ghost', `${BASE}/jobs/move`, { id, to: i + 1 }, !ro && i < jobs.length - 1 && !running);
    }
    if (!running) {
      add('remove', TEXT.remove, 'ghost', `${BASE}/jobs/remove`, { id }, !ro, async () => {
        try {
          return Boolean(await MU.confirm({ title: TEXT.removeAsk, body: TEXT.removeBody(str(job.name)), action: TEXT.remove, tone: 'danger' }));
        } catch { return false; }
      });
    }
    if (job.state === 'needs-you' && canOpenThreads()) {
      // Only puts the folder's Jobs thread on screen; nothing is sent to the job. Below Full the page cannot change what is on screen.
      const open = btn('ghost small ns-open-jobs', TEXT.openJobs, `open|${id}`);
      open.disabled = belowFull() || busy.has(`open|${id}`);
      open.addEventListener('click', () => openJobsThread(job));
      row.append(open);
    }
    if ((job.state === 'needs-you' || job.state === 'stopped') && runs < MAX_RUNS) {
      add('continue', 'Continue tonight', 'ghost', `${BASE}/jobs/continue`, { id }, !ro);
    }
    if (spent) {
      // Only fills the form (with the owner's own words, Done when and lead): nothing is added until he presses Add job.
      const again = btn('ghost small ns-again', TEXT.addAgain, `again|${id}`);
      again.disabled = ro || !businessesOf().some(b => b.id === job.business);
      again.addEventListener('click', () => {
        if (fillForm({ business: job.business, text: str(job.text), doneWhen: str(job.doneWhen), lead: str(job.lead) }, 'owner')) say(TEXT.againFilled, 'ok');
      });
      row.append(again);
    }
    if (!done && !running) add('done', 'Mark done', 'ghost', `${BASE}/jobs/done`, { id }, !ro);
    // Stop is offered while the job runs. A newer file is read-only, but Stop always works; below Full, Stop all is the way.
    if (running) add('stop', 'Stop', 'ghost ns-stop', `${BASE}/stop`, { id }, !belowFull());
    li.append(row);
    return li;
  }

  // The page can put a folder's thread on screen (app.js: MuseUI.update and MuseUI.threads.switchTo).
  const canOpenThreads = () => typeof MU.update === 'function' && Boolean(MU.threads) && typeof MU.threads.switchTo === 'function';
  // The job's folder becomes the active one and its Jobs thread is shown, the way the Setup card opens its chat (ext-biz-setup.js).
  async function openJobsThread(job) {
    const key = `open|${str(job.id)}`;
    if (busy.has(key) || belowFull()) return;
    busy.add(key);
    try {
      const project = str(job.project);
      const now = () => (isObj(MU.state) ? MU.state : {});
      if (project && now().activeProject !== project) await MU.update({ activeProject: project });
      const thread = arr(now().threads).find(t => isObj(t) && str(t.name).trim().toLowerCase() === 'jobs');
      if (thread && str(thread.id)) {
        await MU.threads.switchTo(thread.id);
        say('');
      } else say(TEXT.noJobsThread, 'bad');
    } catch (err) {
      say(sentence(str(err && err.message)) || TEXT.jobsNotOpened, 'bad');
    } finally {
      busy.delete(key);
    }
  }

  // ---------- settings ----------

  function paintSettings() {
    const box = parts.settings;
    if (D.state !== 'ok') { box.replaceChildren(); box.hidden = true; return; }
    box.hidden = false;
    // A control the owner is using is not drawn over: the settings are drawn again after it loses the focus.
    if (box.contains && document.activeElement && box.contains(document.activeElement) && box.childElementCount) return;
    const s = settingsOf();
    const ro = readOnly();
    const kids = [mk('h3', 'ns-head', TEXT.settingsHead)];

    // Night shift on or off.
    kids.push(switchRow(TEXT.onSwitch, '', s.on !== false, 'set|on', on => saveSettings('set|on', { on })));

    // Hours: from and to. From equal to to is refused by the server, with its own sentence.
    const hours = mk('div', 'ns-field ns-hours');
    const lab = mk('span', 'ns-label', TEXT.hours);
    const from = timeInput(str(s.from) || '23:00', 'set|from', TEXT.hoursFrom);
    const to = timeInput(str(s.to) || '07:00', 'set|to', TEXT.hoursTo);
    const pair = mk('div', 'ns-hours-pair');
    pair.append(from.wrap, to.wrap);
    hours.append(lab, pair);
    // A change event means the owner changed a time, so the pair is always sent: comparing with the settings as last drawn would
    // drop a change back to the old time while the settings are not drawn again (the focus is still inside them).
    const sendHours = () => {
      if (!HHMM.test(from.input.value) || !HHMM.test(to.input.value)) return;
      saveSettings('set|hours', { from: from.input.value, to: to.input.value });
    };
    from.input.addEventListener('change', sendHours);
    to.input.addEventListener('change', sendHours);
    kids.push(hours);

    // The share of what would go unused: 10 to 50%.
    const share = mk('select', 'ns-input ns-share');
    share.dataset.fk = 'set|share';
    const cur = num(s.share) ?? 50;
    const choices = SHARES.includes(cur) ? SHARES : [...SHARES, cur].sort((a, b) => a - b);
    share.replaceChildren(...choices.map(n => option(String(n), `${n}%`)));
    share.value = String(cur);
    share.addEventListener('change', () => saveSettings('set|share', { share: Number(share.value) }));
    const shareField = field(TEXT.share, share, 'ns-s-share');
    shareField.append(mk('p', 'ns-note', TEXT.shareNote));
    kids.push(shareField);

    // Runs a night for the plans that do not report their use.
    const counts = isObj(s.countRuns) ? s.countRuns : {};
    const cr = mk('fieldset', 'ns-field ns-counts');
    cr.append(mk('legend', 'ns-label', TEXT.countRuns));
    const grid = mk('div', 'ns-counts-grid');
    for (const [p, label] of COUNTED) {
      const input = mk('input', 'ns-input ns-count');
      input.type = 'number';
      input.min = '0';
      input.max = String(MAX_COUNT);
      input.step = '1';
      input.value = String(num(counts[p]) ?? 4);
      input.dataset.fk = `set|count|${p}`;
      input.addEventListener('change', () => {
        const n = Number(input.value);
        if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT) return;
        // Only this plan's count: the server merges each key, and the other boxes' values as last drawn may be out of date.
        saveSettings(`set|count|${p}`, { countRuns: { [p]: n } });
      });
      grid.append(field(label, input, `ns-s-count-${p}`));
    }
    cr.append(grid);
    kids.push(cr);

    // Keep the PC awake while jobs wait.
    const awakeRow = switchRow(TEXT.keepAwake, TEXT.keepAwakeNote, s.keepAwake !== false, 'set|awake', on => saveSettings('set|awake', { keepAwake: on }));
    kids.push(awakeRow);

    box.replaceChildren(...kids);
    for (const c of box.querySelectorAll('input, select, button')) c.disabled = ro || [...busy].some(k => k.startsWith('set|'));
  }
  function timeInput(value, key, label) {
    const wrap = mk('label', 'ns-time');
    const input = mk('input', 'ns-input');
    input.type = 'time';
    input.step = '60';
    input.value = value;
    input.dataset.fk = key;
    input.setAttribute('aria-label', `${TEXT.hours}: ${label}`);
    wrap.append(mk('span', 'ns-time-word', label), input);
    return { wrap, input };
  }
  function switchRow(label, note, on, key, onChange) {
    const row = mk('label', 'ns-switch');
    const box = mk('input', 'ns-check');
    box.type = 'checkbox';
    box.checked = Boolean(on);
    box.dataset.fk = key;
    box.setAttribute('role', 'switch');
    const words = mk('span', 'ns-switch-words');
    words.append(mk('span', 'ns-switch-label', label));
    if (note) words.append(mk('span', 'ns-note', note));
    row.append(box, words);
    box.addEventListener('change', () => onChange(box.checked));
    return row;
  }
  // A change that comes while the same setting's last change is still on its way is kept (the latest one only) and sent when the
  // answer comes, so the value the owner ends on is the one saved.
  const settingsNext = new Map();
  async function saveSettings(key, patch) {
    if (readOnly()) return;
    if (busy.has(key)) { settingsNext.set(key, patch); return; }
    await act(key, `${BASE}/settings`, patch);
    if (settingsNext.has(key)) {
      const next = settingsNext.get(key);
      settingsNext.delete(key);
      await saveSettings(key, next);
    }
  }

  // ---------- the title bar count ----------

  // While jobs wait the title bar button carries their count; a job that waits for the owner turns it amber.
  function paintCount() {
    if (D.state !== 'ok') { try { MU.pane.count(TAB, null); } catch { /* no count */ } return; }
    const jobs = jobsOf();
    const needs = jobs.filter(j => j.state === 'needs-you').length;
    const open = jobs.filter(j => j.state === 'waiting' || j.state === 'running').length + needs;
    try { MU.pane.count(TAB, open > 0 ? open : null, needs > 0 ? 'amber' : ''); } catch { /* the pane shows it */ }
  }

  // ---------- suggested jobs (ns4) ----------

  async function loadSuggestions() {
    const mine = ++SUG.seq;
    const r = await ask(`${BASE}/suggestions`);
    if (mine !== SUG.seq) return;
    SUG.list = r.ok ? arr(r.data.suggestions).filter(s => isObj(s) && str(s.business) && str(s.text).trim() && /^[a-f0-9]{64}$/.test(str(s.sha256))) : [];
    paintSuggest();
  }
  // A suggestion that is already a job on the list (waiting, running or finished) is not offered again.
  const isJobAlready = s => jobsOf().some(j => j.business === s.business && str(j.text).trim() === str(s.text).trim());
  function paintSuggest() {
    if (!parts || !parts.suggest) return;
    const box = parts.suggest;
    const shownList = D.state === 'ok' ? SUG.list.filter(s => !isJobAlready(s)) : [];
    if (!shownList.length) { box.replaceChildren(); box.hidden = true; return; }
    box.hidden = false;
    const ro = readOnly();
    const many = businessesOf().length > 1;
    const ol = mk('ol', 'ns-list');
    for (const s of shownList) {
      const li = mk('li', 'ns-job');
      li.dataset.suggestion = s.sha256;
      const who = str(s.lead) ? `Suggested by ${leadName(s.lead)}: ` : 'Suggested: ';
      li.append(mk('p', 'ns-job-name ns-suggest-text', who + s.text));
      if (many && str(s.name)) li.append(mk('p', 'ns-job-sub', s.name));
      const row = mk('div', 'ns-job-acts');
      const use = btn('ghost small ns-use', TEXT.useAsJob, `use|${s.sha256}`);
      use.disabled = ro;
      use.addEventListener('click', () => {
        if (businessesOf().some(b => b.id === s.business) && fillForm({ business: s.business, text: s.text }, 'suggested')) { ui.suggested = { business: s.business, text: s.text, sha256: s.sha256 }; say(TEXT.suggestFilled, 'ok'); }
      });
      const no = btn('ghost small ns-dismiss', TEXT.dismiss, `dismiss|${s.sha256}`);
      no.disabled = ro || busy.has(`dismiss|${s.sha256}`);
      no.addEventListener('click', () => act(`dismiss|${s.sha256}`, `${BASE}/suggestions/dismiss`, { business: s.business, sha256: s.sha256 }));
      row.append(use, no);
      li.append(row);
      ol.append(li);
    }
    box.replaceChildren(mk('h3', 'ns-head', TEXT.suggestHead), ol);
  }

  // ---------- the moon icon (the shared sprite has none) ----------

  function installIcon() {
    try {
      if (document.getElementById('i-moon')) return;
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'sprite');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      svg.id = 'ns-sprite';
      const symbol = document.createElementNS(SVG_NS, 'symbol');
      symbol.id = 'i-moon';
      symbol.setAttribute('viewBox', '0 0 24 24');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1z');
      symbol.append(path);
      svg.append(symbol);
      document.body.append(svg);
    } catch { /* the button keeps its words without the icon */ }
  }

  // ---------- wiring ----------

  function startPoll() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (shown()) refresh(); }, POLL_MS);
  }
  function stopPoll() {
    clearInterval(pollTimer);
    pollTimer = 0;
  }

  installIcon();
  MU.pane.register({
    id: TAB,
    title: TITLE,
    icon: 'moon',
    order: 46,
    titleButton: true,
    render: body => build(body),
    onShow: () => { paint(); refresh(); startPoll(); },
    onHide: () => stopPoll(),
    onClose: () => { stopPoll(); root = null; parts = null; },
  });

  window.addEventListener('plenum:event', e => {
    const ev = e && e.detail;
    if (!isObj(ev)) return;
    if (ev.type === 'night-shift') refreshSoon(shown() ? 200 : 1500);
    else if (ev.type === 'routine' && (ev.action === 'hold' || ev.action === 'resume')) refreshSoon(shown() ? 200 : 1500);
  });
  // The phone's access can change while the pane is open: it is drawn again with what it now allows, and read again.
  try {
    let was = belowFull();
    if (window.plenumShell && typeof window.plenumShell.onConnection === 'function') {
      window.plenumShell.onConnection(() => {
        const now = belowFull();
        if (now !== was) { was = now; paint(); refreshSoon(); }
      });
    }
  } catch { /* the access is read again at the next draw */ }

  // For the suggested jobs (ns4) and the tests: open the pane, fill the form, read the state. Nothing here adds a job.
  window.MuseNightShift = Object.freeze({
    open: () => { try { MU.pane.open(TAB); } catch { /* not on this page */ } },
    fill: (job, source) => fillForm(job, source),
    refresh: () => refresh(),
    state: () => ({ state: D.state, data: D.data ? JSON.parse(JSON.stringify(D.data)) : null, error: D.error }),
  });

  // The count on the title bar button: one read, after the page has started, never on the start path.
  Promise.resolve(MU.ready).then(() => setTimeout(refresh, 1800), () => {});
})();
