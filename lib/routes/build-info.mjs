// GET /api/build-info: which build this is, as { version, build, commit, dirty, builtAt, line } (lib/build-info.mjs, DECISIONS item 91).
// It reaches no network and holds no path, user name or secret, so it is not gated: it answers before the License Agreement is
// accepted too. The server checks the Plenum token before this handler runs.
import { buildInfo } from '../build-info.mjs';

export const routes = [
  { method: 'GET', path: '/api/build-info', handler: ({ res, json }) => json(res, 200, buildInfo()) },
];
