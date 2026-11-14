// The fake Tailscale CLI for the carriers suite (mob-04). It is never the real tailscale: the test puts this folder first on a scratch PATH
// and the shims run this file with the node binary the test names (TS_FAKE_NODE). Every call appends its exact argv, as JSON, to the
// file named by TS_FAKE_LOG, so the suite can count what ran. Behaviour is chosen by environment variables the test sets:
//   TS_FAKE_STATUS=running (default) | needslogin | stopped   what `status --json` reports
//   TS_FAKE_FAIL=serve                                       `serve --bg ...` and `serve --https=443 off` exit 1 with a message
//   TS_FAKE_SERVE=<file>                                      the serve config this fake keeps (default: <TS_FAKE_LOG>.serve.json)
// The serve config is a real one in miniature: `serve status --json` prints it ({} when empty), `serve --bg --https=443 <target>` sets the
// web entry "<name>:443", `serve --https=443 off` removes the entries on 443 and nothing else, `serve reset` is not known and fails (13 Nov 2026: Plenum never runs it).
// A test may write the file first to put another program's handler on the computer (443, or the hub's 8790).
// Nothing here reaches the network or any account.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.TS_FAKE_LOG) appendFileSync(process.env.TS_FAKE_LOG, `${JSON.stringify({ argv })}\n`);

const dns = 'will-pc.tail1234.ts.net.';
const state = process.env.TS_FAKE_STATUS ?? 'running';
const backend = state === 'needslogin' ? 'NeedsLogin' : state === 'stopped' ? 'Stopped' : 'Running';
const serveFile = process.env.TS_FAKE_SERVE || (process.env.TS_FAKE_LOG ? `${process.env.TS_FAKE_LOG}.serve.json` : '');
const readServe = () => {
  try {
    return serveFile && existsSync(serveFile) ? JSON.parse(readFileSync(serveFile, 'utf8')) : {};
  } catch {
    return {};
  }
};
const writeServe = cfg => {
  if (serveFile) writeFileSync(serveFile, JSON.stringify(cfg));
};

if (argv[0] === 'status' && argv[1] === '--json') {
  process.stdout.write(`${JSON.stringify({ BackendState: backend, Self: { DNSName: dns, Online: backend === 'Running' } })}\n`);
  process.exit(0);
}
if (argv[0] === 'serve' && argv[1] === 'status' && argv[2] === '--json') {
  process.stdout.write(`${JSON.stringify(readServe())}\n`);
  process.exit(0);
}
if (argv[0] === 'serve') {
  if (process.env.TS_FAKE_FAIL === 'serve') {
    process.stderr.write('fake tailscale: serve refused for this test\n');
    process.exit(1);
  }
  const cfg = readServe();
  if (argv[1] === '--bg' && argv[2] === '--https=443' && argv[3]) {
    cfg.TCP = { ...(cfg.TCP ?? {}), 443: { HTTPS: true } };
    cfg.Web = { ...(cfg.Web ?? {}), [`${dns.replace(/\.$/, '')}:443`]: { Handlers: { '/': { Proxy: argv[3] } } } };
    writeServe(cfg);
    process.stdout.write('Available within your tailnet\n');
    process.exit(0);
  }
  if (argv[1] === '--https=443' && argv[2] === 'off') {
    for (const key of Object.keys(cfg.Web ?? {})) if (/:443$/.test(key)) delete cfg.Web[key];
    if (cfg.TCP) delete cfg.TCP[443];
    writeServe(cfg);
    process.exit(0);
  }
}
process.stderr.write(`fake tailscale: unknown command ${argv.join(' ')}\n`);
process.exit(2);
