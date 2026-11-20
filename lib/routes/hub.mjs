// Plenum Hub routes: what Settings > Plenum Hub reads and does (lib/hub.mjs holds the logic). All under /api/hub/, JSON.
//   GET  /api/hub/status        everything the panel shows, from memory (instant, never reaches the hub)
//   POST /api/hub/settings      { agents?, confirm?, publicUrl?, privateUrl?, starterFolder? }  ("" resets an address or the folder)
//   POST /api/hub/key           answers 400: Plenum keeps no hub key (the hub's starter hands out each agent's key)
//   POST /api/hub/key/remove    nothing to remove; answers the status
//   POST /api/hub/watch         { open: true | false }  the Hub section is on screen (renewed every 20 seconds) or has gone; answers the status
//   POST /api/hub/refresh       one real check now (at most one in two seconds), answers the status
//   POST /api/hub/test          { steps: [{ id, ok, text }] }, makes no agent, uses no agent's key and sends nothing to anyone
//   POST /api/hub/revoke        forgets every agent key Plenum holds and turns the agents switch off: { revoked, status }
// Every POST waits for the License Agreement (lib/legal.mjs) like all POSTs; the server checks the launch token before any handler here
// runs. No reply and no event holds a key. A broken hub never makes a route answer 500: only a failed save of the settings does.
// Nothing here reaches the hub or starts its starter while "Connect agents" is off and the Hub section is closed: status is memory only,
// and watch, refresh and test are sent only by the section while it is on screen. No route ever uses an agent's key.
import * as hub from '../hub.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const KEY_REFUSAL = 'Plenum Hub needs no key from you. Plenum asks the hub\'s own starter for each agent\'s key and keeps it in memory only.';
const BAD_SETTINGS = 'Send agents as true or false, confirm as writes or never, and addresses or a folder as text.';

export const routes = [
  {
    method: 'GET',
    path: '/api/hub/status',
    handler: async ({ res, json }) => {
      // The monitor starts here, on first use, and never on the start path. It runs only while the agents switch is on or the Hub section
      // is on screen (POST /api/hub/watch); otherwise this call starts nothing.
      try {
        hub.ensureMonitor();
      } catch {
        // The panel still answers.
      }
      return json(res, 200, hub.status());
    },
  },
  {
    method: 'POST',
    path: '/api/hub/settings',
    handler: async ({ req, res, json, readBody, httpError, store }) => {
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, BAD_SETTINGS);
      const accepted = {};
      if (body.agents !== undefined) {
        if (typeof body.agents !== 'boolean') throw httpError(400, BAD_SETTINGS);
        accepted.agents = body.agents;
      }
      if (body.confirm !== undefined) {
        if (body.confirm !== 'writes' && body.confirm !== 'never') throw httpError(400, BAD_SETTINGS);
        accepted.confirm = body.confirm;
      }
      for (const key of ['publicUrl', 'privateUrl']) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== 'string') throw httpError(400, BAD_SETTINGS);
        const text = body[key].trim();
        if (text !== '') {
          const refusal = hub.checkUrl(text);
          if (refusal) throw httpError(400, refusal);
        }
        accepted[key] = text === '' ? hub.DEFAULTS[key] : text.replace(/\/+$/, '');
      }
      if (body.starterFolder !== undefined) {
        if (typeof body.starterFolder !== 'string') throw httpError(400, BAD_SETTINGS);
        const text = body.starterFolder.trim();
        if (text !== '') {
          const refusal = hub.checkFolder(text);
          if (refusal) throw httpError(400, refusal);
        }
        // The default stays a default (the folder is looked up when needed), so only a chosen folder is written.
        accepted.starterFolder = text === hub.defaultStarterFolder() ? '' : text;
      }
      const before = hub.status().settings;
      const st = store.get();
      let failure = null;
      if (Object.keys(accepted).length > 0) {
        st.hub = { ...(isObject(st.hub) ? st.hub : {}), ...accepted };
        failure = await store.persist();
      }
      // The change is in use from here on even when the save failed, so the keys and notices below are forgotten before that is answered.
      const after = hub.status().settings;
      // Keys are forgotten when the agents go off or the hub moves, so a key for the old place is never sent to the new one.
      const moved = before.publicUrl !== after.publicUrl || before.starterFolder !== after.starterFolder;
      if ((before.agents && !after.agents) || moved) hub.forgetAgents();
      // Another address or starter folder is another hub: what Plenum already said about the old one does not hold for it.
      if (moved) hub.forgetNotices();
      hub.settingsChanged();
      hub.publishChange(true);
      if (failure) throw httpError(500, `${failure} The change is shown but is lost on restart until a save works.`);
      return json(res, 200, hub.status());
    },
  },
  {
    method: 'POST',
    path: '/api/hub/key',
    handler: async ({ req, readBody, httpError }) => {
      await readBody(req).catch(() => null);
      throw httpError(400, KEY_REFUSAL);
    },
  },
  {
    method: 'POST',
    path: '/api/hub/key/remove',
    handler: async ({ res, json }) => json(res, 200, hub.status()),
  },
  {
    method: 'POST',
    path: '/api/hub/watch',
    handler: async ({ req, res, json, readBody, httpError }) => {
      const body = await readBody(req);
      if (!isObject(body) || typeof body.open !== 'boolean') throw httpError(400, 'Send open as true or false.');
      return json(res, 200, hub.watch(body.open));
    },
  },
  {
    method: 'POST',
    path: '/api/hub/refresh',
    handler: async ({ res, json }) => json(res, 200, await hub.refresh()),
  },
  {
    method: 'POST',
    path: '/api/hub/test',
    handler: async ({ res, json }) => json(res, 200, { steps: await hub.testSteps() }),
  },
  {
    method: 'POST',
    path: '/api/hub/revoke',
    handler: async ({ res, json, httpError, store }) => {
      const revoked = hub.forgetAgents();
      const st = store.get();
      if (isObject(st.hub) && st.hub.agents === true) {
        st.hub = { ...st.hub, agents: false };
        const failure = await store.persist();
        if (failure) throw httpError(500, `${failure} The change is shown but is lost on restart until a save works.`);
      }
      hub.settingsChanged();
      hub.publishChange(true);
      return json(res, 200, { revoked, status: hub.status() });
    },
  },
];
