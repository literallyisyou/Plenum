// ext-team. Settings > Agents > Team: the models that do delegated work, for each kind of work, in the person's own order. It shows the
// switch, a suggested team with one button (Use this team), each kind with its workers (a state dot and the reason in words, arrows to
// reorder, Remove, Add), this week's delegated work for each subscription beside its plan use, the other models with their sizes, and
// the switch for models billed per token. Adds itself through window.MuseUI (app.js). Layout and colour are in ext-team.css (tokens only).
//
// The server (lib/routes/team.mjs, lib/team.mjs, lib/team-log.mjs) owns every fact; this page shows them and changes them only through
// the routes. THE CONTRACT THIS PAGE READS (DELEGATION-DESIGN.md sections 5.3, 5.5, 10 and 12):
//  - GET /api/team -> { v, on, saved, kinds: [{ id, label, about, agent, workers: [{ ref, label, provider, size, avail: { state, why,
//    usedPercent } }], ...the kind's other fields }], suggested: { kinds: [{ id, workers: [ref] }] } | null, models: [{ ref, label,
//    provider, billing: 'plan' | 'api', size: 'small' | 'mid' | 'top' | 'unknown', sizeFrom: 'owner' | 'price' | 'name' | 'none', tools,
//    avail }], providers: [{ id, label, state, why, usedPercent }], limits: { perProviderAtOnce, skipAbovePercent, allowApi }, sizes:
//    { [ref]: size }, hints: [text], facts: [text] }. From the server's memory; it starts nothing. avail.state is ready, unknown,
//    not-installed, sign-in, no-key, not-offered or limit, and avail.why is the rest of a sentence about the model ("is at 93% of its
//    plan (your line is 90%)"), said here as "It is at 93% ..." unless the state's own word already says it. hints are what the person should know now (a model that left its list, a
//    team file from a newer Plenum): drawn at the top. facts are the reasons behind the suggested orders: drawn under the suggestion.
//  - POST /api/team { on, kinds, sizes, limits } -> the same answer. EVERY change on this page is one such request with the whole record
//    (a kind goes back as it came, with workers as a list of refs). "Saved" is said only after the answer; a refusal (400) shows the
//    server's own sentence and the page stays as the server has it. Changes go one after another in the order they were pressed: a
//    press made while another change is on its way waits for that answer and is then made on what the server holds, so none is lost.
//  - GET /api/team/pick?work=<kind id> -> the dry run of the choice: { ref, label, why, skipped } | { ref: null, error, skipped } |
//    { ref: null, empty: true, error, skipped } for a kind whose list holds no model. Asked for ONE thing, and only while the team is
//    on with such a kind: what happens to that kind's tasks. empty: true means the team has no say and the task goes to the model
//    of its agent type, as with the team off (the contract of lib/team.mjs pick, which lib/team-run.mjs follows); a refusal without
//    it means the task is refused; no answer means not known, and the page then says only what is sure (the team does not choose
//    for that kind). The page never writes this rule down itself. With the team off the type's own model does the task, as before.
//  - A model billed per token gets no delegated work while limits.allowApi is not true (lib/team.mjs pick): its row says Off.
//  - Auto (wave 6): a kind with `auto` (boolean) and `pinEffort` gets an Auto box and an Effort menu in its head (Auto, shown only
//    while Auto is on, Low, Medium, High, Extra high), and a line under its list; choosing a level sets pinEffort: true, choosing Auto
//    sets it false. Each is one POST /api/team with the whole record. A kind without `auto` (a server from before) shows none of it.
//  - POST /api/team/use-suggested -> the same answer, with the suggested team saved and on. 409 with a sentence while sign-ins are unknown.
//  - GET /api/team/usage?days=7 -> { days, byProvider: [{ provider, label, count, ok, failed, minutes, input, output, dollars }], byKind }.
//  - GET /api/agents (an existing route) -> effective.types [{ name, label, kind }]: an editing type takes only a model whose tool calls
//    Plenum can check (tools 'yes' or 'cli'), which is what Add offers. The server checks again and its sentence is shown.
//  - Events 'team' (saved elsewhere, or a task finished) and 'providers' (a sign-in or a model list changed): read again, only while the
//    section is on the page.
// Nothing is asked before the section is drawn. With the routes missing (404) the section says so in one line. A field that is missing
// is unknown, never an error; unknown fields are kept and sent back. Text reaches the page through textContent only. No new notice id:
// the two strips drawn here ('delegation', 'api-keys-spend') are registered in lib/notices.mjs.
(function () {
  const MuseUI = window.MuseUI;
  if (!MuseUI || !MuseUI.settings || typeof MuseUI.settings.register !== 'function') return;

  const SAVED_MS = 2500;
  const MAX_WORKERS = 12;
  const DAYS = 7;
  // The sentences of DELEGATION-DESIGN.md section 12 and section 9, word for word.
  const TEXT = {
    off: 'Delegated work uses one model for every kind of work. A team lets each subscription do what it is good at. This is a suggestion; nothing changes until you press Use this team.',
    switchNote: 'With the team on, a lead can spend your other subscriptions. Each task shows which model did the work.',
    perToken: 'These models are billed per token to your API keys. The spend limit of the project applies.',
    cannotAsk: 'In Ask first, Claude asks before each write. A Codex or Gemini coder cannot ask: it edits inside its scope by itself and Plenum lists what changed. To refuse that, set Coders that cannot ask to Refuse in the project settings.',
    checking: 'Plenum is still checking your sign-ins.',
    nobody: 'Plenum found no model you are signed in to that it can suggest. Sign in under Settings > Accounts, and a suggestion appears here.',
    missing: 'This build of Plenum has no team yet.',
    perTokenOff: 'Models billed per token do no delegated work until you turn on the switch at the end of this section.',
    order: 'For each kind of work, the first model in the list that can run now does the task.',
    orderOff: 'The team is off, so these lists are not used yet. Once it is on, the first model in a kind\'s list that can run now does the task.',
    pickFirst: 'Choose a model in the menu first.',
    // Auto routing (wave 6, AUTOROUTE-BRIEF.md section 2), word for word.
    autoNote: 'With Auto on, Plenum picks one model from a kind\'s list and an effort for each task, from the task itself and the room left in each plan. It never uses a model that is not in the list, and each task says which model it chose and why.',
    autoKind: 'Auto picks from this list for each task. Your order breaks ties.',
    orderOffAuto: 'The team is off, so these lists are not used yet.',
  };
  // The Effort menu of a kind: Auto only while the kind's Auto is on; a level chosen here is kept (pinEffort), also under Auto.
  const EFFORT_MENU = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high']];
  // An effort the menu does not offer, as a saved kind may hold it, is shown as it is.
  const EFFORT_OTHER = { '': 'Default', max: 'Maximum' };
  const LEVELS = ['low', 'medium', 'high', 'xhigh'];
  // A kind with no model. Team off: the type's own model, as before. Team on: the team does not choose for it, and what happens to
  // its tasks is the server's to say (emptyRule: 'type', 'refuse' or '' while not known, when only what is sure is said).
  const EMPTY = {
    off: l => `No model yet. A ${l} task uses the model of its agent type.`,
    type: l => `No model yet, so the team does not choose for ${l}. A ${l} task uses the model of its agent type, as with the team off.`,
    refuse: l => `No model yet, so the team does not choose for ${l}. A ${l} task is refused until you add a model here or the lead names one.`,
    '': l => `No model yet, so the team does not choose for ${l}. Add a model here to give ${l} tasks to the team.`,
  };
  // The off text without its last sentence, for when there is no suggestion to press.
  const OFF_LEAD = TEXT.off.slice(0, TEXT.off.indexOf(' This is a suggestion'));
  const STATE_WORD = {
    ready: 'Ready', unknown: 'Not checked yet', 'not-installed': 'Not installed', 'sign-in': 'Needs sign-in', 'no-key': 'Needs an API key',
    'not-offered': 'Not offered', limit: 'At its plan limit',
  };
  // The same states inside a line of notes (a model that is ready or not checked yet says nothing there).
  const STATE_NOTE = { 'not-installed': 'not installed', 'sign-in': 'needs sign-in', 'no-key': 'needs an API key', 'not-offered': 'not offered', limit: 'at its plan limit' };
  const SIZE_WORD = { small: 'Small', mid: 'Mid', top: 'Top', unknown: 'Size not known' };
  const SIZE_FROM = { owner: 'set by you', price: 'from its price', name: 'guessed from the name' };
  const SIZES = ['small', 'mid', 'top'];

  // ---------- helpers (text only) ----------

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = v => (typeof v === 'string' ? v : '');
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const list = v => (Array.isArray(v) ? v : []);
  let idSeq = 0;
  const uid = base => `${base}-${++idSeq}`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // 950 -> '950', 3100 -> '3.1k', 310000 -> '310k', 2400000 -> '2.4M'.
  function short(n) {
    if (n < 1000) return String(Math.round(n));
    const [div, unit] = n < 1e6 ? [1e3, 'k'] : [1e6, 'M'];
    const v = n / div;
    return `${v < 10 ? String(Math.round(v * 10) / 10) : String(Math.round(v))}${unit}`;
  }

  function icon(name, cls) {
    if (typeof MuseUI.icon === 'function') return MuseUI.icon(name, cls);
    return make('span', cls);
  }

  // ---------- state ----------

  let team = null;            // the last answer of GET or POST /api/team
  let usage = null;           // the last answer of GET /api/team/usage, or null when it could not be read
  let types = null;           // Map of agent type name -> { label, kind }, from GET /api/agents; null while not known
  let phase = 'idle';         // idle | loading | ready | missing | error
  let errorText = '';
  let busy = false;           // a change is on its way to the server
  let chain = Promise.resolve(false); // the changes, one after another in the order they were pressed
  let using = false;          // Use this team was pressed and is not answered yet
  let presses = 0;
  const wants = new Map();    // a switch that was pressed and is not answered yet: 'on' | 'api' -> { id, want }
  const picked = new Map();   // the model chosen in a kind's Add menu and not added yet: kind id -> ref
  let emptyRule = '';         // what the server says happens to a task of a kind with no model while the team is on: 'type' | 'refuse' | ''
  let emptyAsked = false;     // asked once for each time the section is drawn
  let again = false;          // an event came while a request was running
  let changes = 0;            // how many changes the server has answered; a read that started before one of them is thrown away
  let view = null;            // the parts of the section on the page
  let wantFocus = null;       // where focus goes after the next draw: { keys (tried in order), from (the control that was used) }
  const said = new Map();     // what each status line says now: key -> { text, bad }
  const timers = new Map();

  const kinds = () => list(team?.kinds).filter(k => isObj(k) && str(k.id));
  const models = () => list(team?.models).filter(m => isObj(m) && str(m.ref));
  const limits = () => (isObj(team?.limits) ? team.limits : {});
  const sizes = () => (isObj(team?.sizes) ? team.sizes : {});
  const refOf = w => (isObj(w) ? str(w.ref) : str(w));
  // Which vendor's program or API runs a model, from its reference: 'claude', 'codex', 'gemini' or the prefix itself.
  const vendorOf = ref => { const p = str(ref).split(':')[0]; return p === 'anthropic' ? 'claude' : p === 'googleai' || p === 'antigravity' ? 'gemini' : p === 'openai' ? 'codex' : p; };
  const refsOf = kind => list(kind.workers).map(refOf).filter(Boolean);
  const modelOf = ref => models().find(m => m.ref === ref) ?? null;
  const labelOf = (ref, given) => str(given) || str(modelOf(ref)?.label) || (typeof MuseUI.modelName === 'function' ? str(MuseUI.modelName(ref)) : '') || ref;
  const providerLabel = id => str(list(team?.providers).find(p => isObj(p) && p.id === id)?.label) || id || 'Other';
  const onPage = () => Boolean(view && view.root.isConnected);

  // ---------- requests ----------

  // A request that keeps the status of a refusal, so a missing route (404) can be told from a failure.
  async function get(path) {
    const res = await MuseUI.request(path);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(str(data?.error));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // The sentence for a change that did not go through: the server's own when it sent one.
  function whyNot(err) {
    const text = str(err?.message);
    if (!text || /^Request failed \(\d+\)$/.test(text) || err instanceof TypeError) return 'The change was not saved. Plenum did not answer; try again.';
    return text;
  }

  function takeTypes(data) {
    const found = list(data?.effective?.types ?? data?.app?.types).filter(t => isObj(t) && str(t.name));
    if (!found.length) return;
    types = new Map(found.map(t => [t.name, { label: str(t.label), kind: str(t.kind) }]));
  }

  async function load() {
    if (phase === 'loading' || busy) { again = true; return; }
    const first = !team;
    const at = changes;
    phase = 'loading';
    if (first) paint();
    try {
      const [t, u, a] = await Promise.all([
        get('/api/team'),
        get(`/api/team/usage?days=${DAYS}`).catch(() => null),
        types ? null : get('/api/agents').catch(() => null),
      ]);
      if (!isObj(t)) throw new Error('');
      if (a) takeTypes(a);
      phase = 'ready';
      errorText = '';
      if (at === changes) {
        team = t;
        usage = isObj(u) ? u : null;
      } else {
        // A change was saved while this read was on its way, so its answer is older than the page: read once more.
        again = true;
      }
    } catch (err) {
      if (err?.status === 404) {
        phase = 'missing';
        team = null;
      } else if (team) {
        // A later read that fails leaves what the page knows; the next event reads again.
        phase = 'ready';
      } else {
        phase = 'error';
        errorText = err?.status ? str(err.message) : 'Its server did not answer.';
      }
    }
    paint();
    if (again) { again = false; if (onPage()) load(); }
  }

  // Events: read again, but only while the section is on the page. Several events in a row become one read.
  let eventTimer = null;
  function onEvent() {
    if (!onPage() || phase === 'missing') return;
    clearTimeout(eventTimer);
    eventTimer = setTimeout(() => { if (onPage()) load(); }, 250);
  }

  // What happens to a task of a kind that has no model while the team is on: the server's dry run of the choice says it. Asked only
  // when the team is on with such a kind, once for each time the section is drawn; an answer that changes the words draws again.
  function askEmptyRule() {
    if (emptyAsked || !team || team.on !== true) return;
    const kind = kinds().find(k => !refsOf(k).length);
    if (!kind) return;
    emptyAsked = true;
    get(`/api/team/pick?work=${encodeURIComponent(kind.id)}`).then(a => {
      const rule = !isObj(a) || a.ref ? '' : a.empty === true ? 'type' : str(a.error) ? 'refuse' : '';
      if (rule === emptyRule) return;
      emptyRule = rule;
      paint();
    }, () => { /* not known: the page says only what is sure */ });
  }

  // ---------- status lines ----------

  function say(key, text, bad, clearAfter) {
    clearTimeout(timers.get(key));
    if (text) said.set(key, { text, bad: bad === true });
    else said.delete(key);
    if (clearAfter) timers.set(key, setTimeout(() => { said.delete(key); drawSaid(); }, SAVED_MS));
    drawSaid();
  }
  function drawSaid() {
    if (!onPage()) return;
    for (const line of view.root.querySelectorAll('[data-say]')) {
      const now = said.get(line.dataset.say);
      const text = now?.text ?? '';
      if (line.textContent !== text) line.textContent = text;
      line.classList.toggle('team-bad', now?.bad === true);
    }
  }
  const sayLine = key => {
    const n = make('span', 'team-save');
    n.setAttribute('role', 'status');
    n.dataset.say = key;
    return n;
  };

  // ---------- changes ----------

  // The whole record as the server holds it, ready to change and send back.
  function record() {
    return {
      on: team.on === true,
      kinds: kinds().map(k => ({ ...k, workers: refsOf(k) })),
      sizes: { ...sizes() },
      limits: { ...limits() },
    };
  }

  // The focus key of the control that has focus, when it is one of the section's.
  const focusKey = () => (view && view.root.contains(document.activeElement) ? document.activeElement.dataset?.fk ?? '' : '');

  // Changes go to the server one after another, in the order they were pressed. A step never throws past the line.
  function queue(run) {
    const result = chain.then(run).catch(() => false);
    chain = result;
    return result;
  }

  // One change: the record with `change` applied goes to the server, and the page shows what the server answers. A change that is
  // pressed while another is on its way waits for that answer and is then made on what the server holds by then, so no press is lost
  // and none is sent twice (`change` answers false when there is nothing left to do). `after` runs on success.
  function save(key, change, opts = {}) {
    if (!team) return Promise.resolve(false);
    const from = focusKey();
    if (busy) say(key, 'Saving…');
    return queue(() => {
      const next = team ? record() : null;
      if (!next || change(next) === false) {
        // Nothing to send: a line that still says Saving… would never be answered.
        if (said.get(key)?.text === 'Saving…') say(key, '');
        return false;
      }
      return send(key, '/api/team', next, { ...opts, from });
    });
  }

  // Runs inside the queue only, so one request is on its way at a time.
  async function send(key, path, body, { focus, after, from } = {}) {
    busy = true;
    view?.root.setAttribute('aria-busy', 'true');
    say(key, 'Saving…');
    let ok = false;
    try {
      const got = await MuseUI.api(path, body);
      if (isObj(got) && Array.isArray(got.kinds)) team = got;
      changes += 1;
      ok = true;
    } catch (err) {
      say(key, whyNot(err), true);
    }
    busy = false;
    view?.root.removeAttribute('aria-busy');
    // Focus follows the change. After a refusal nothing changed, so focus stays on the control that was used.
    wantFocus = ok && focus ? { keys: focus, from: from ?? '' } : null;
    paint();
    if (ok) {
      say(key, 'Saved', false, true);
      if (after) after();
    }
    // An event that came while the change was on its way is read now.
    if (again) { again = false; if (onPage()) load(); }
    return ok;
  }

  const kindIn = (rec, id) => rec.kinds.find(k => k.id === id);

  function move(kind, ref, by) {
    const up = by < 0;
    save(`kind:${kind.id}`, rec => {
      const k = kindIn(rec, kind.id);
      const at = k ? k.workers.indexOf(ref) : -1;
      const to = at + by;
      if (at < 0 || to < 0 || to >= k.workers.length) return false;
      k.workers.splice(to, 0, k.workers.splice(at, 1)[0]);
      return true;
    }, { focus: [fk(kind.id, ref, up ? 'up' : 'down'), fk(kind.id, ref, up ? 'down' : 'up')] });
  }

  function remove(kind, ref) {
    const refs = refsOf(kind);
    const at = refs.indexOf(ref);
    const neighbour = refs[at + 1] ?? refs[at - 1];
    save(`kind:${kind.id}`, rec => {
      const k = kindIn(rec, kind.id);
      if (!k || !k.workers.includes(ref)) return false;
      k.workers = k.workers.filter(r => r !== ref);
      return true;
    }, { focus: [neighbour ? fk(kind.id, neighbour, 'remove') : '', fk(kind.id, '', 'add')] });
  }

  // Add puts the model the menu shows into the kind. Choosing in the menu changes nothing by itself: the arrow keys and the letters
  // move through a closed menu, so a change of the menu must not be a change of the team.
  function add(kind, select) {
    const ref = select.value;
    if (!ref) { say(`kind:${kind.id}`, TEXT.pickFirst); return; }
    save(`kind:${kind.id}`, rec => {
      const k = kindIn(rec, kind.id);
      if (!k || k.workers.includes(ref)) return false;
      k.workers.push(ref);
      return true;
    }, { focus: [fk(kind.id, '', 'add'), fk(kind.id, ref, 'remove')] }).then(ok => {
      if (ok && picked.get(kind.id) === ref) picked.delete(kind.id);
    });
  }

  function setSize(ref, size, where) {
    save(`sizes:${where}`, rec => {
      if (SIZES.includes(size)) rec.sizes[ref] = size;
      else delete rec.sizes[ref];
      return true;
    }, { focus: [fk('size', ref, 'size')] });
  }

  // A switch. The newest press is the one that counts: a press made while an earlier one is on its way waits for that answer and
  // then sends what was pressed last, and the switch shows that until the server has answered. A refused switch goes back to what
  // the server has. `set` puts the value into the record and answers false when the server already has it.
  function flip(slot, key, input, set, notice) {
    const want = input.checked;
    const id = ++presses;
    wants.set(slot, { id, want });
    save(key, rec => (wants.get(slot)?.id === id ? set(rec, want) : false), {
      focus: [fk('', '', slot)],
      after: () => { if (want) notice(); },
    }).then(() => {
      if (wants.get(slot)?.id !== id) return;
      wants.delete(slot);
      paint();
    });
  }

  function setOn(input) {
    flip('on', 'switch', input, (rec, want) => {
      if (rec.on === want) return false;
      rec.on = want;
      return true;
    }, () => { if (typeof MuseUI.notice === 'function') MuseUI.notice('delegation', { before: view.onRow.row }); });
  }

  function setApi(input) {
    flip('api', 'api', input, (rec, want) => {
      if ((rec.limits.allowApi === true) === want) return false;
      rec.limits.allowApi = want;
      return true;
    }, () => { if (typeof MuseUI.notice === 'function') MuseUI.notice('api-keys-spend', { before: view.apiRow.row }); });
  }

  // Use this team. A team the person arranged is replaced only after a yes. A second press while the first is on its way is the
  // same wish, so it is not sent again.
  async function useSuggested() {
    if (using || !team) return;
    using = true;
    try {
      const from = focusKey();
      const own = team.saved === true && kinds().some(k => refsOf(k).length > 0);
      if (own && typeof MuseUI.confirm === 'function') {
        const yes = await MuseUI.confirm({
          title: 'Use the suggested team?',
          body: 'The models and their order for each kind of work are replaced by the suggestion, and the team is turned on. Sizes you set are kept.',
          action: 'Use this team',
        });
        if (!yes) return;
      }
      if (busy) say('suggested', 'Saving…');
      await queue(() => send('suggested', '/api/team/use-suggested', {}, {
        from,
        focus: [fk('', '', 'on')],
        after: () => { if (typeof MuseUI.notice === 'function') MuseUI.notice('delegation', { before: view.onRow.row }); },
      }));
    } finally {
      using = false;
    }
  }

  // ---------- which models Add offers ----------

  // An editing type needs a model whose tool calls Plenum can check, and never the offline model (lib/agents.mjs canRun). While the
  // types are not known every model is offered, and the server's sentence says why one was refused.
  function canRun(model, kind) {
    const type = types?.get(str(kind.agent));
    if (type?.kind !== 'edit') return true;
    return (model.tools === 'yes' || model.tools === 'cli') && model.provider !== 'echo';
  }
  const candidates = kind => {
    const have = new Set(refsOf(kind));
    return models().filter(m => !have.has(m.ref) && m.avail?.state !== 'not-offered' && canRun(m, kind));
  };
  // The reason beside a state's word. The server sends the rest of a sentence about the model ("is at 93% of its plan"); a reason that
  // only repeats the word ("needs sign-in" beside Needs sign-in) is left out, and a whole sentence is shown as it is.
  const plain = t => t.toLowerCase().replace(/^(it |is )+/, '').replace(/[.\s]+$/, '');
  function reason(state, why) {
    const text = why.trim();
    if (!text || plain(text) === plain(STATE_WORD[state] ?? '')) return '';
    if (/^[a-z]/.test(text)) return `It ${text}${/[.!?]$/.test(text) ? '' : '.'}`;
    return text;
  }
  const sizeText = m => {
    const word = SIZE_WORD[str(m?.size)] ?? SIZE_WORD.unknown;
    const from = SIZE_FROM[str(m?.sizeFrom)];
    return from ? `${word}, ${from}` : word;
  };

  // ---------- the section ----------

  // A focus key names a control across draws: the kind, the model and what the control does.
  const fk = (kind, ref, what) => `${kind}|${ref}|${what}`;

  function switchRow(title, note, key) {
    const row = make('label', 'switch-row');
    const input = make('input');
    input.type = 'checkbox';
    input.dataset.fk = fk('', '', key);
    const track = make('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    const text = make('span');
    text.append(title, make('small', null, note));
    row.append(input, track, text);
    return { row, input };
  }

  function section(title, cls) {
    const box = make('section', `team-sec ${cls}`);
    const head = make('h5', 'team-sub', title);
    head.id = uid('team-h');
    box.setAttribute('aria-labelledby', head.id);
    box.append(head);
    return box;
  }

  function build(body) {
    const root = make('div', 'team-root');
    const line = make('p', 'team-line');
    line.setAttribute('role', 'status');
    const retry = make('button', 'ghost small team-retry', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => load());
    const main = make('div', 'team-main');

    // The switch, with the notice the design gives it, and the line about coders that cannot ask.
    const onRow = switchRow('Use the team for delegated work', TEXT.switchNote, 'on');
    onRow.input.addEventListener('change', () => setOn(onRow.input));
    // What the switch means for the kinds that have no model, for as long as it is so (paintWarn).
    const onWarn = make('p', 'team-warn');
    onWarn.setAttribute('role', 'status');
    onWarn.hidden = true;
    // What Auto does, under the switch, while a kind has Auto on (paint).
    const autoNote = make('p', 'team-note team-auto-note', TEXT.autoNote);
    autoNote.hidden = true;
    const cannotAsk = make('p', 'team-note', TEXT.cannotAsk);
    // What the person should know now, in the server's words.
    const alerts = make('div', 'team-alerts');
    alerts.setAttribute('role', 'status');

    // The suggested team.
    const sugg = section('Suggested team', 'team-sugg');
    const suggIntro = make('p', 'team-note');
    const suggList = make('ul', 'team-sugg-list');
    const facts = make('ul', 'team-facts');
    const suggActions = make('div', 'team-actions');
    const use = make('button', 'primary small', 'Use this team');
    use.type = 'button';
    use.dataset.fk = fk('', '', 'use');
    use.addEventListener('click', () => useSuggested());
    suggActions.append(use, sayLine('suggested'));
    sugg.append(suggIntro, suggList, facts, suggActions);

    // The kinds of work.
    const yours = section('Your team', 'team-yours');
    const yoursNote = make('p', 'team-note', TEXT.orderOff);
    const kindsBox = make('div', 'team-kinds');
    yours.append(yoursNote, kindsBox);

    // This week's delegated work.
    const use7 = section(`Delegated work, last ${DAYS} days`, 'team-usage');
    const usageList = make('ul', 'team-usage-list');
    const usageNote = make('p', 'team-note');
    use7.append(usageList, usageNote);

    // Other models, and the sizes.
    const others = make('details', 'team-more');
    others.append(make('summary', null, 'Other models you can add'));
    const othersNote = make('p', 'team-note', 'A size is a starting point, not a measurement. Models are tried in the order of your list; the suggested team puts small ones first. A lead may ask for a larger one when the work is hard.');
    const othersList = make('ul', 'team-models');
    others.append(othersNote, othersList, sayLine('sizes:other'));
    const inTeam = make('details', 'team-more');
    inTeam.append(make('summary', null, 'Sizes of the models in your team'));
    const inTeamList = make('ul', 'team-models');
    inTeam.append(inTeamList, sayLine('sizes:team'));
    for (const d of [others, inTeam]) {
      d.addEventListener('keydown', e => {
        if (e.key === 'Escape' && d.open) { d.open = false; d.querySelector('summary')?.focus(); e.stopPropagation(); }
      });
    }

    // Models billed per token.
    const apiRow = switchRow('Models billed per token may do delegated work', TEXT.perToken, 'api');
    apiRow.input.addEventListener('change', () => setApi(apiRow.input));
    const apiBox = make('div', 'team-sec team-api');
    apiBox.append(apiRow.row, sayLine('api'));

    main.append(alerts, onRow.row, sayLine('switch'), onWarn, autoNote, cannotAsk, sugg, yours, use7, others, inTeam, apiBox);
    root.append(line, retry, main);
    body.append(root);
    view = { root, line, retry, main, alerts, onRow, onWarn, autoNote, yoursNote, sugg, suggIntro, suggList, facts, use, kindsBox, use7, usageList, usageNote, others, othersList, inTeam, inTeamList, apiRow, shape: '' };
  }

  // ---------- drawing ----------

  function paint() {
    if (!onPage()) return;
    const v = view;
    // Where focus should be after this draw. After a change it follows the change (the same arrow of the same model), unless the
    // person has moved on to another control meanwhile: then it stays with them. Otherwise it stays on the control that has it.
    const active = document.activeElement;
    const inside = Boolean(active) && v.root.contains(active);
    const here = inside ? active.dataset?.fk ?? '' : '';
    let held = here ? [here] : null;
    if (wantFocus) {
      const elsewhere = Boolean(active) && active !== document.body && !inside;
      if (inside && here !== wantFocus.from) held = here ? [here, ...wantFocus.keys] : null;
      else held = elsewhere ? null : wantFocus.keys;
    }
    wantFocus = null;

    const ready = Boolean(team);
    let line = '';
    if (phase === 'missing') line = TEXT.missing;
    else if (phase === 'error') line = `Plenum could not read your team. ${errorText}`.trim();
    else if (!ready) line = 'Reading your team…';
    v.line.textContent = line;
    v.line.hidden = !line;
    v.line.classList.toggle('team-bad', phase === 'error');
    v.retry.hidden = phase !== 'error';
    v.main.hidden = !ready;
    if (!ready) return;

    // A switch that was pressed and is not answered yet shows what was pressed; otherwise what the server has.
    v.onRow.input.checked = wants.has('on') ? wants.get('on').want : team.on === true;
    v.apiRow.input.checked = wants.has('api') ? wants.get('api').want : limits().allowApi === true;

    // The lists are built again only when what they show changed: an event that brings the same answer leaves the page alone, so an
    // open menu stays open and nothing flickers.
    const shape = JSON.stringify([team, usage, types ? [...types] : null, emptyRule]);
    if (shape !== v.shape) {
      v.shape = shape;
      paintSuggested(v);
      v.kindsBox.replaceChildren(...kinds().map(kindEl));
      paintUsage(v);
      paintModels(v);
    }
    // A server that knows Auto sends `auto` with every kind: each kind then says how its list is used, and this note says only what holds
    // for all of them. From a server without it, the notes are as before.
    const autoKnown = kinds().some(hasAuto);
    v.yoursNote.textContent = !autoKnown ? (team.on === true ? TEXT.order : TEXT.orderOff) : team.on === true ? '' : TEXT.orderOffAuto;
    v.autoNote.hidden = !kinds().some(k => k.auto === true);
    paintWarn(v);
    askEmptyRule();
    drawSaid();

    // Focus goes back to the control that was used, or to the next best one, so the keyboard keeps its place after a change.
    if (held) {
      for (const key of held) {
        if (!key) continue;
        const node = [...v.root.querySelectorAll('[data-fk]')].find(n => n.dataset.fk === key);
        if (node && !node.disabled && node.getClientRects().length) {
          if (document.activeElement !== node) node.focus({ preventScroll: true });
          break;
        }
      }
    }
  }

  function paintSuggested(v) {
    const s = isObj(team.suggested) ? list(team.suggested.kinds).filter(k => isObj(k) && str(k.id)) : null;
    const on = team.on === true;
    const rows = [];
    let same = Boolean(s);
    if (s) {
      for (const k of s) {
        const kind = kinds().find(x => x.id === k.id);
        const refs = list(k.workers).map(refOf).filter(Boolean);
        if (!kind || refs.join('\n') !== refsOf(kind).join('\n')) same = false;
        const li = make('li', 'team-sugg-row');
        li.append(make('span', 'team-sugg-kind', str(kind?.label) || k.id), make('span', 'team-sugg-models', refs.length ? refs.map(r => labelOf(r)).join(', ') : 'No model to suggest yet'));
        rows.push(li);
      }
    }
    // A suggestion with no model in any kind (nothing is installed or signed in yet) is not offered: it would turn on an empty team.
    const nobody = Boolean(s) && !s.some(k => list(k.workers).map(refOf).some(Boolean));
    const matches = same && on && !nobody;
    // With no suggestion to press, the off text ends before the sentence about pressing it.
    const lead = on ? '' : `${OFF_LEAD} `;
    v.suggIntro.textContent = !s ? `${lead}${TEXT.checking}` : nobody ? `${lead}${TEXT.nobody}` : matches ? 'Your team is the suggested team.' : on ? 'What Plenum would choose from the models that can run now. Nothing changes until you press Use this team.' : TEXT.off;
    v.suggList.replaceChildren(...(matches || nobody ? [] : rows));
    v.suggList.hidden = matches || nobody || !rows.length;
    // A fact is shown only while the suggestion shown follows it: "Claude leads Code and Test" is not said of a suggestion with no Claude model.
    const leader = id => vendorOf(list(s?.find(k => k.id === id)?.workers).map(refOf).find(Boolean));
    const factHolds = h => (/^Claude /.test(h) ? ['code', 'test'].every(id => leader(id) === 'claude')
      : /Codex leads Data/.test(h) ? leader('data') === 'codex'
        : /^Gemini .* leads Research/.test(h) ? leader('research') === 'gemini'
          : /second vendor/.test(h) ? Boolean(leader('review')) && Boolean(leader('code')) && leader('review') !== leader('code')
            : true);
    const factRows = list(team.facts).filter(h => typeof h === 'string' && h && factHolds(h)).map(h => make('li', 'team-fact', h));
    v.facts.replaceChildren(...factRows);
    v.facts.hidden = !factRows.length || !s || nobody;
    // The server's hints, at the top. The one the suggestion's own line already says is not said twice.
    const alertRows = list(team.hints).filter(h => typeof h === 'string' && h && !(h === TEXT.checking && !s)).map(h => make('p', 'team-alert', h));
    v.alerts.replaceChildren(...alertRows);
    v.alerts.hidden = !alertRows.length;
    v.use.hidden = !s || matches || nobody;
  }

  // "Find", "Find and Code", "Find, Code and Review".
  const andList = words => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

  // The switch can be on while kinds have no model: the team then does not choose for them. The line under the switch says so for
  // as long as it is so, with what the server says happens to their tasks (emptyRule). Where such tasks go to the model of their
  // agent type ('type') it is a plain note, and only when no kind has a model (the switch then changes nothing); each kind's own line
  // says the rest. Otherwise it is the amber note when no kind has a model or when tasks are refused, and a plain note when only
  // some kinds have none.
  function paintWarn(v) {
    const all = kinds();
    const empty = all.filter(k => !refsOf(k).length).map(k => str(k.label) || k.id);
    let text = '';
    if (team.on === true && empty.length) {
      const offered = !v.use.hidden;
      const those = empty.length === 1 ? 'that kind' : 'those kinds';
      if (empty.length === all.length) {
        text = 'Your team has no models yet, so it chooses for no kind of work.';
        if (emptyRule === 'type') text += ` Delegated work still uses the model of each agent type, as with the team off. Add a model to a kind below${offered ? ' or press Use this team' : ''}.`;
        else text += `${emptyRule === 'refuse' ? ' A delegated task is refused until its kind has a model or the lead names one.' : ''} Add a model to a kind below${offered ? ', press Use this team' : ''} or turn the team off.`;
      } else if (emptyRule !== 'type') {
        text = `No model yet for ${andList(empty)}, so the team does not choose for ${those}.`;
        text += emptyRule === 'refuse' ? ` A task of ${those} is refused until you add a model or the lead names one.` : ' Add a model to each to give its tasks to the team.';
      }
    }
    const cls = emptyRule === 'type' || (text && empty.length < all.length && emptyRule !== 'refuse') ? 'team-note' : 'team-warn';
    if (v.onWarn.className !== cls) v.onWarn.className = cls;
    if (v.onWarn.textContent !== text) v.onWarn.textContent = text;
    v.onWarn.hidden = !text;
  }

  // ---------- Auto (wave 6) ----------

  // A server that knows Auto sends `auto` (and `pinEffort`) with each kind; without it, nothing about Auto is drawn.
  const hasAuto = kind => typeof kind?.auto === 'boolean';
  // What the Effort menu shows: Auto while the kind's Auto is on and no level was chosen, else the kind's own effort.
  const effortShown = kind => (kind.auto === true && kind.pinEffort !== true ? 'auto' : str(kind.effort));

  // The Auto box and the Effort menu of a kind, in its head.
  function autoControls(kind, label) {
    const ctl = make('span', 'team-kind-ctl');
    const box = make('label', 'team-auto');
    const input = make('input');
    input.type = 'checkbox';
    input.checked = kind.auto === true;
    input.dataset.fk = fk(kind.id, '', 'auto');
    input.setAttribute('aria-label', `Auto for ${label}`);
    input.addEventListener('change', () => setAuto(kind, input));
    box.append(input, make('span', null, 'Auto'));

    const effort = make('label', 'team-effort');
    const select = make('select', 'team-select team-effort-menu');
    select.dataset.fk = fk(kind.id, '', 'effort');
    select.setAttribute('aria-label', `Effort for ${label}`);
    const shown = effortShown(kind);
    for (const [value, text] of EFFORT_MENU) {
      if (value === 'auto' && kind.auto !== true) continue;
      select.append(new Option(text, value));
    }
    if (!EFFORT_MENU.some(([value]) => value === shown) && Object.hasOwn(EFFORT_OTHER, shown)) select.append(new Option(EFFORT_OTHER[shown], shown));
    select.value = shown;
    select.addEventListener('change', () => setEffort(kind, select));
    effort.append(make('span', 'team-effort-word', 'Effort'), select);
    ctl.append(box, effort);
    return ctl;
  }

  // A control whose change was refused, or had nothing to send, shows again what the server has.
  const redraw = ok => {
    if (ok || !onPage()) return;
    view.shape = '';
    paint();
  };

  function setAuto(kind, input) {
    const want = input.checked;
    save(`kind:${kind.id}`, rec => {
      const k = kindIn(rec, kind.id);
      if (!k || (k.auto === true) === want) return false;
      k.auto = want;
      return true;
    }, { focus: [fk(kind.id, '', 'auto')] }).then(redraw);
  }

  // Auto lets Auto choose the effort again (the kind's own effort is kept for when Auto is off); a level is kept for every task.
  function setEffort(kind, select) {
    const want = select.value;
    save(`kind:${kind.id}`, rec => {
      const k = kindIn(rec, kind.id);
      if (!k) return false;
      if (want === 'auto') {
        if (k.pinEffort !== true) return false;
        k.pinEffort = false;
        return true;
      }
      if (!LEVELS.includes(want) || (k.effort === want && k.pinEffort === true)) return false;
      k.effort = want;
      k.pinEffort = true;
      return true;
    }, { focus: [fk(kind.id, '', 'effort')] }).then(redraw);
  }

  function kindEl(kind) {
    const box = make('div', 'team-kind');
    box.dataset.kind = kind.id;
    const head = make('div', 'team-kind-head');
    const name = make('h6', 'team-kind-name', str(kind.label) || kind.id);
    name.id = uid('team-k');
    const typeLabel = str(types?.get(str(kind.agent))?.label);
    head.append(name);
    if (typeLabel) head.append(make('span', 'team-kind-type', typeLabel));
    const workers = list(kind.workers).filter(w => refOf(w));
    const label = str(kind.label) || kind.id;
    if (hasAuto(kind)) head.append(autoControls(kind, label));
    box.append(head);
    if (str(kind.about)) box.append(make('p', 'team-kind-about', kind.about));

    if (workers.length) {
      const ol = make('ol', 'team-workers');
      ol.setAttribute('aria-labelledby', name.id);
      workers.forEach((w, i) => ol.append(workerEl(kind, label, w, i, workers.length)));
      box.append(ol);
      // How this list is used: by Auto, or in the person's order.
      if (hasAuto(kind)) box.append(make('p', 'team-note team-kind-how', kind.auto === true ? TEXT.autoKind : TEXT.order));
    } else {
      box.append(make('p', 'team-empty', EMPTY[team.on === true ? emptyRule : 'off'](label)));
    }

    const foot = make('div', 'team-add');
    const offer = candidates(kind);
    if (workers.length >= MAX_WORKERS) {
      foot.append(make('span', 'team-note', `A kind of work holds ${MAX_WORKERS} models at most.`));
    } else if (offer.length) {
      const select = make('select', 'team-select');
      select.dataset.fk = fk(kind.id, '', 'add');
      select.setAttribute('aria-label', `Add a model to ${label}`);
      select.append(new Option('Add a model…', ''));
      // One group for each subscription, in the registry's order.
      const groups = new Map();
      for (const m of offer) {
        const id = str(m.provider);
        if (!groups.has(id)) {
          const g = make('optgroup');
          g.label = providerLabel(id);
          groups.set(id, g);
          select.append(g);
        }
        groups.get(id).append(new Option(`${labelOf(m.ref, m.label)} · ${sizeText(m)}${m.billing === 'api' ? ' · billed per token' : ''}`, m.ref));
      }
      // The menu only chooses; Add (or Enter in the menu) puts the chosen model into the kind. What was chosen is kept across draws.
      const chosen = picked.get(kind.id);
      if (chosen && offer.some(m => m.ref === chosen)) select.value = chosen;
      else picked.delete(kind.id);
      select.addEventListener('change', () => {
        if (select.value) picked.set(kind.id, select.value);
        else picked.delete(kind.id);
        if (said.get(`kind:${kind.id}`)?.text === TEXT.pickFirst) say(`kind:${kind.id}`, '');
      });
      select.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey || !select.value) return;
        e.preventDefault();
        add(kind, select);
      });
      const go = make('button', 'ghost small team-addgo', 'Add');
      go.type = 'button';
      go.dataset.fk = fk(kind.id, '', 'addgo');
      go.setAttribute('aria-label', `Add the chosen model to ${label}`);
      go.addEventListener('click', () => add(kind, select));
      foot.append(select, go);
    }
    foot.append(sayLine(`kind:${kind.id}`));
    box.append(foot);
    return box;
  }

  function workerEl(kind, kindLabel, w, i, count) {
    const ref = refOf(w);
    const model = modelOf(ref);
    const label = labelOf(ref, isObj(w) ? w.label : '');
    const avail = isObj(w) && isObj(w.avail) ? w.avail : (isObj(model?.avail) ? model.avail : {});
    let state = STATE_WORD[str(avail.state)] ? str(avail.state) : 'unknown';
    let word = STATE_WORD[state];
    let why = reason(state, str(avail.why));
    // A model billed per token gets no delegated work while the switch for such models is off (lib/team.mjs pick), so a row that
    // could run otherwise does not say Ready: it says Off, with the reason and where the switch is. The dot is the neutral one.
    if (model?.billing === 'api' && limits().allowApi !== true && (state === 'ready' || state === 'unknown')) {
      state = 'off';
      word = 'Off';
      why = TEXT.perTokenOff;
    }
    const li = make('li', 'team-worker');
    li.dataset.state = state;

    li.append(make('span', 'team-rank', String(i + 1)));
    const main = make('span', 'team-wmain');
    const top = make('span', 'team-wtop');
    top.append(make('span', 'team-wname', label));
    const meta = [sizeText(model ?? (isObj(w) ? w : null))];
    if (model?.billing === 'api') meta.push('billed per token');
    top.append(make('span', 'team-wmeta', meta.join(' · ')));
    const st = make('span', 'team-wstate');
    const dot = make('span', 'team-dot');
    dot.setAttribute('aria-hidden', 'true');
    st.append(dot, make('span', 'team-wword', word));
    if (why) st.append(make('span', 'team-wwhy', why));
    main.append(top, st);

    const acts = make('span', 'team-wacts');
    const act = (what, text, iconName, disabled, run) => {
      const b = make('button', iconName ? `icon-btn team-act team-act-${what}` : 'team-remove');
      b.type = 'button';
      b.dataset.fk = fk(kind.id, ref, what);
      b.disabled = disabled;
      if (iconName) {
        b.append(icon(iconName));
        b.setAttribute('aria-label', text);
        b.title = text;
      } else {
        b.textContent = 'Remove';
        b.setAttribute('aria-label', text);
      }
      b.addEventListener('click', run);
      return b;
    };
    acts.append(
      act('up', `Move ${label} up in ${kindLabel}`, 'arrow-up', i === 0, () => move(kind, ref, -1)),
      act('down', `Move ${label} down in ${kindLabel}`, 'arrow-up', i === count - 1, () => move(kind, ref, 1)),
      act('remove', `Remove ${label} from ${kindLabel}`, '', false, () => remove(kind, ref)),
    );
    li.append(main, acts);
    return li;
  }

  // This week's delegated work for each subscription, beside its plan use.
  function paintUsage(v) {
    const by = new Map(list(usage?.byProvider).filter(r => isObj(r) && str(r.provider)).map(r => [r.provider, r]));
    const provs = list(team.providers).filter(p => isObj(p) && str(p.id));
    const onPlan = new Set(models().filter(m => m.billing === 'plan').map(m => str(m.provider)));
    const rows = [];
    const seen = new Set();
    const row = (id, label, p, u) => {
      seen.add(id);
      const count = num(u?.count) ?? 0;
      const used = num(p?.usedPercent);
      if (!count && used === null) return;
      const li = make('li', 'team-use');
      li.append(make('span', 'team-use-name', label || id));
      const parts = [];
      if (count) {
        parts.push(plural(count, 'task', 'tasks'));
        const failed = num(u.failed) ?? 0;
        if (failed) parts.push(`${failed} not finished`);
        const minutes = num(u.minutes);
        if (minutes !== null) parts.push(minutes < 1 ? 'under 1 min' : `${Math.round(minutes)} min`);
        const tokens = (num(u.input) ?? 0) + (num(u.output) ?? 0);
        if (tokens > 0) parts.push(`${short(tokens)} tokens`);
        const dollars = num(u.dollars);
        if (dollars !== null && dollars > 0) parts.push(`$${dollars.toFixed(2)}`);
      } else {
        parts.push('No delegated work');
      }
      li.append(make('span', 'team-use-work', parts.join(' · ')));
      const plan = make('span', 'team-use-plan');
      if (used !== null) {
        const pct = Math.max(0, Math.min(100, Math.round(used)));
        const bar = make('progress', 'team-meter');
        bar.max = 100;
        bar.value = pct;
        bar.setAttribute('aria-label', `${label || id}: ${pct}% of the plan used`);
        const line = num(limits().skipAbovePercent);
        if (line !== null && pct >= line) bar.dataset.full = 'yes';
        plan.append(bar, make('span', 'team-use-pct', `${pct}% of plan used`));
      } else if (onPlan.has(id)) {
        plan.append(make('span', 'team-use-pct', 'Plan use not known'));
      }
      li.append(plan);
      rows.push(li);
    };
    for (const p of provs) row(p.id, str(p.label), p, by.get(p.id));
    for (const [id, u] of by) if (!seen.has(id)) row(id, str(u.label), null, u);
    if (!rows.length) rows.push(make('li', 'team-empty', usage ? `No delegated work in the last ${DAYS} days.` : 'Plenum could not read the delegated work right now.'));
    v.usageList.replaceChildren(...rows);
    const skip = num(limits().skipAbovePercent);
    v.usageNote.textContent = skip !== null ? `The team passes over a subscription once ${Math.round(skip)}% of its plan is used.` : '';
    v.usageNote.hidden = !v.usageNote.textContent;
  }

  // The models that are in no kind (with what each is and a way to set its size), and the sizes of the ones that are.
  function paintModels(v) {
    const used = new Set(kinds().flatMap(refsOf));
    const row = where => m => {
      const li = make('li', 'team-model');
      const main = make('span', 'team-mmain');
      const label = labelOf(m.ref, m.label);
      main.append(make('span', 'team-wname', label));
      const meta = [sizeText(m)];
      if (m.billing === 'api') meta.push('billed per token');
      const state = str(m.avail?.state);
      if (STATE_NOTE[state]) meta.push(STATE_NOTE[state]);
      main.append(make('span', 'team-wmeta', meta.join(' · ')));
      const select = make('select', 'team-select team-size');
      select.dataset.fk = fk('size', m.ref, 'size');
      select.setAttribute('aria-label', `Size of ${label}`);
      select.append(new Option('Automatic', ''), ...SIZES.map(s => new Option(SIZE_WORD[s], s)));
      select.value = SIZES.includes(sizes()[m.ref]) ? sizes()[m.ref] : '';
      select.addEventListener('change', () => setSize(m.ref, select.value, where));
      li.append(main, select);
      return li;
    };
    const out = models().filter(m => !used.has(m.ref));
    const inn = models().filter(m => used.has(m.ref));
    v.othersList.replaceChildren(...(out.length ? out.map(row('other')) : [make('li', 'team-empty', 'Every model Plenum knows is in your team.')]));
    v.inTeamList.replaceChildren(...inn.map(row('team')));
    v.inTeam.hidden = !inn.length;
  }

  // ---------- Settings section ----------

  // Drawing reads the server's memory (GET /api/team starts nothing). Nothing is read before the section is drawn.
  function render(body) {
    // What a status line said the last time the page was open is not said again.
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    said.clear();
    picked.clear();
    emptyRule = '';
    emptyAsked = false;
    body.textContent = '';
    build(body);
    paint();
    load();
  }

  (async function start() {
    await (MuseUI.ready ?? Promise.resolve());
    MuseUI.settings.register({ id: 'team', scope: 'app', group: 'agents', title: 'Team', order: 30, render });
    MuseUI.events.on('team', onEvent);
    MuseUI.events.on('providers', onEvent);
  })();
})();
