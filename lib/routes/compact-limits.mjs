// The auto-compact limit of each model (lib/compact-limits.mjs, DECISIONS item 86), for the Auto-compact section of Settings > Roles.
//   GET  /api/compact-limits                      -> the limits, the models in use and what a limit means for each
//   GET  /api/compact-limits?ref=<model>          -> the same description of one model, in use or not ("Add another model")
//   POST /api/compact-limits { ref, value }       -> sets an override, or null to inherit the default
//   POST /api/compact-limits { defaultValue, resetOverrides? } -> sets the shared target, optionally clearing all overrides
// The server checks the Plenum token on every /api/ request before a route runs; requireToken checks it here as well.
import { requireToken } from '../auth.mjs';
import { COMPACT_RANGE, DEFAULT_COMPACT_TARGET, UNPUBLISHED_MAX, cleanLimits, cliKnob, compactPolicy, compactValue,
  defaultValue, maxOf, suggestedOf, windowOf, withLimit } from '../compact-limits.mjs';
import { labelFor, parseRef } from '../providers.mjs';
import { claudeRoute } from '../claude-cli.mjs';
import { sessionEnabled } from '../sessions.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const CLI_PROVIDERS = new Set(['muse', 'codex', 'gemini', 'cursor', 'grok', 'antigravity', 'echo']);
const HAIKU = 'anthropic:claude-haiku-5-5';

// Every model the app or a project uses now, in a stable order: the chat models, the advisor, the council seats and moderators, the agent
// types' models, and any model that already has a limit. Values that are not model refs are skipped.
function modelsInUse(st) {
  const seen = new Set();
  const add = ref => {
    if (typeof ref === 'string' && ref.includes(':') && !seen.has(ref)) seen.add(ref);
  };
  const council = c => {
    for (const s of Array.isArray(c?.seats) ? c.seats : []) add(s?.ref);
    add(c?.moderator?.ref);
  };
  const agents = a => {
    for (const t of Array.isArray(a?.types) ? a.types : []) add(t?.model);
  };
  add(st.model);
  add(st.advisor);
  council(st.council);
  agents(st.agents);
  for (const p of Array.isArray(st.projects) ? st.projects : []) {
    add(p?.settings?.model);
    council(p?.settings?.council);
    agents(p?.settings?.agents);
  }
  for (const entry of Object.values(isObject(st.threads) ? st.threads : {})) {
    for (const t of Array.isArray(entry?.list) ? entry.list : []) add(t?.model);
  }
  // The shipped agent types run on Claude Haiku 5.5 unless they were given another model.
  add(HAIKU);
  for (const ref of Object.keys(cleanLimits(st.compactAt))) add(ref);
  return [...seen];
}

// What one model's limit is and means: its value, its window (and whether it is published), the top of its dial, the value a new limit
// starts from, what a chat turn of it is sent (lib/compact-limits.mjs roomOf), and which CLI is told the limit itself.
function describeModel(ref, st, route) {
  const provider = ref.split(':')[0];
  const cli = CLI_PROVIDERS.has(provider) || (provider === 'anthropic' && route !== 'api');
  const native = cli && sessionEnabled(ref, st);
  const win = windowOf(ref);
  // Claude Code is told the limit only when Claude runs through its CLI; through an API key there is no Claude Code process.
  const knob = cliKnob(ref) === 'claude' && provider === 'anthropic' && route === 'api' ? null : cliKnob(ref);
  let label = ref;
  try {
    label = labelFor(ref);
  } catch {
    // The ref itself is shown.
  }
  const routeSettings = { cli, native };
  return {
    ref,
    label,
    ...compactPolicy(ref, routeSettings, st),
    window: win.tokens,
    published: win.published,
    max: maxOf(ref),
    suggested: suggestedOf(ref, routeSettings, st),
    knob,
  };
}

async function describe(st) {
  const route = await claudeRoute().catch(() => 'cli');
  const limits = cleanLimits(st.compactAt);
  const models = modelsInUse(st).map(ref => describeModel(ref, st, route));
  return { range: COMPACT_RANGE, unpublishedMax: UNPUBLISHED_MAX, claudeRoute: route, defaultValue: defaultValue(st), limits, models };
}

let writes = Promise.resolve();

// Serialize writes and validate the entire request before changing either persisted setting. If the
// save fails, restore the old in-memory values as well. A later request therefore starts from the
// last valid settings, even when two browser windows submit changes at the same time.
async function saveSettings(store, body, httpError) {
  const attempt = writes.then(async () => {
    const st = store.get();
    const oldLimits = st.compactAt;
    const oldDefault = st.compactDefault;
    const wasLimits = Object.hasOwn(st, 'compactAt');
    const wasDefault = Object.hasOwn(st, 'compactDefault');
    const global = Object.hasOwn(body, 'defaultValue');
    let nextLimits = oldLimits;
    let nextDefault = oldDefault;
    try {
      if (global) {
        if (Object.hasOwn(body, 'ref') || Object.hasOwn(body, 'value')) throw new Error('Save a default or a model override in one request.');
        if (Object.hasOwn(body, 'resetOverrides') && typeof body.resetOverrides !== 'boolean') throw new Error('resetOverrides must be true or false.');
        nextDefault = body.defaultValue === null ? DEFAULT_COMPACT_TARGET : compactValue(body.defaultValue, UNPUBLISHED_MAX);
        if (body.resetOverrides) nextLimits = {};
      } else {
        if (!Object.hasOwn(body, 'ref') || !Object.hasOwn(body, 'value') || Object.hasOwn(body, 'resetOverrides')) {
          throw new Error('Send a model ref and value, or a defaultValue.');
        }
        nextLimits = withLimit(oldLimits, body, parseRef);
      }
    } catch (error) {
      throw httpError(400,error.message);
    }
    if (global) st.compactDefault = nextDefault;
    if (!global || body.resetOverrides) st.compactAt = nextLimits;
    try {
      await store.saveOrFail();
    } catch (error) {
      if (wasLimits) st.compactAt = oldLimits; else delete st.compactAt;
      if (wasDefault) st.compactDefault = oldDefault; else delete st.compactDefault;
      throw error;
    }
    return st;
  });
  writes = attempt.catch(() => {});
  return attempt;
}

export const routes = [
  {
    method: 'GET',
    path: '/api/compact-limits',
    handler: async ({ req, res, url, json, httpError, store }) => {
      requireToken(req, httpError);
      const asked = url?.searchParams?.get('ref');
      if (asked !== null && asked !== undefined) {
        let ref;
        try {
          ref = parseRef(asked);
        } catch (err) {
          throw httpError(400, err.message);
        }
        const route = await claudeRoute().catch(() => 'cli');
        const st = store.get();
        return json(res, 200, { range: COMPACT_RANGE, defaultValue: defaultValue(st), model: describeModel(ref, st, route) });
      }
      return json(res, 200, await describe(store.get()));
    },
  },
  {
    method: 'POST',
    path: '/api/compact-limits',
    handler: async ({ req, res, json, readBody, httpError, store }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with defaultValue, or a model ref and value.');
      const st = await saveSettings(store, body, httpError);
      return json(res, 200, await describe(st));
    },
  },
];
