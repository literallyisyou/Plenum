// The one route of answering from a phone's notification (wave 8, 17 Nov 2026; lib/phone-answer.mjs holds the logic and the contract).
//   POST /api/phone-answer/quick { id, answer: 'yes' | 'no' } -> { item, waiting, record, why, followUp, said }
//        id is what the notification's Yes and No carry ('<n>.<token>', made by this start of Plenum). Only a simple yes/no item is
//        answered here: 409 with one sentence when the token does not check out, the item no longer waits, or it is not a simple
//        yes/no any more (then it is answered on Today, where its draft is read); 400 for anything that is not an id and an answer.
//        The answer is recorded by lib/decisions.mjs answerItem, as a tap in the Businesses pane is: the same record line, the same
//        follow-up run, the same one answer per item (a second one is a 409).
// The server checks the Plenum token on every /api/ request before a handler runs, and every POST waits for the License Agreement; the
// POST checks the token here as well. From a phone it needs Full access (lib/remote/tiers.mjs: a POST it does not name is Full). No
// model can call it: a model's tools never hold the token. It reaches no network and starts no program.
// Reading how an item can be answered on a phone needs no route of its own: GET /api/decisions puts it on every waiting item (phone).
// A Yes that came through the Bridge (x-plenum-device, which only the Bridge sets, lib/remote/proxy.mjs) is taken only from a phone
// that has Approve from notifications, read from the running Bridge's registry when the Yes arrives (lib/remote/index.mjs deviceOf),
// as the Bridge checks Approve: 409 with one sentence otherwise (review of wave 8). The No never needs it.
import { requireToken } from '../auth.mjs';
import * as phoneAnswer from '../phone-answer.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Loaded when asked, as lib/routes/remote.mjs loads lib/remote/: no Bridge, or a phone it does not list, is false.
async function yesAllowedByRegistry(device) {
  const mod = await import('../remote/index.mjs');
  return mod.deviceOf?.(device)?.approveFromNotifications === true;
}

export function createRoutes(deps = {}) {
  const api = deps.phoneAnswer ?? phoneAnswer;
  const yesAllowed = deps.yesAllowed ?? yesAllowedByRegistry;
  return [
    {
      method: 'POST',
      path: '/api/phone-answer/quick',
      handler: async ({ req, res, json, readBody, httpError }) => {
        requireToken(req, httpError);
        const body = await readBody(req);
        if (!isObject(body)) throw httpError(400, api.TEXT.bad);
        const device = req.headers?.['x-plenum-device'];
        try {
          return json(res, 200, await api.quickAnswer({ id: body.id, answer: body.answer, device: typeof device === 'string' ? device : '' }, { ...deps, yesAllowed }));
        } catch (err) {
          throw Number.isInteger(err?.status)
            ? httpError(err.status, String(err.message))
            : httpError(500, 'Plenum could not save the answer, so nothing was changed. Try again, or answer on Today.');
        }
      },
    },
  ];
}

export const routes = createRoutes();
