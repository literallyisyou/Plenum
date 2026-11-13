// GET /api/health: { ok: true, pid, uptimeMs }. It does no work at all (no CLI is looked for, no file is read, no provider is asked), so it
// answers at once, whatever else the server is busy with. The desktop shell asks it to learn that the server is up (desktop/main.cjs
// waitForServer, DECISIONS item 91). It is not gated: it answers before the License Agreement is accepted too. The server checks the Plenum
// token before this handler runs, like every other /api/ route.
export const routes = [
  { method: 'GET', path: '/api/health', handler: ({ res, json }) => json(res, 200, { ok: true, pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000) }) },
];
