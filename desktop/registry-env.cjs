'use strict';
// The environment variables of the Windows registry, read without making anyone wait. An app started from the Start menu can miss PATH
// or other changes made after Explorer started (the Muse Code installer, setx), so the server is given the current values.
// Before, two `reg query` calls ran one after the other with no time limit (12.8, 12.9, 2.3 and 8.0 s were measured on the owner's PC)
// and the server was not started until both were done, at every restart too.
//  - Both queries run at once, each with a time limit (LIMIT_MS, 1.5 s), and the answer never rejects: a query that fails or runs out of
//    time gives nothing, and the server then starts with the variables of this process (it looks for new CLIs itself, PLENUM_PATH_REFRESH).
//  - desktop/main.cjs asks for the values at the start of the app, so they are read while the window and the port check go on; only the
//    fork of the server waits for them.
//  - A complete reading is kept and given again when the supervisor starts the server again. An incomplete one is read again at that time.
// No Electron import; execFile is passed in so a test can make `reg` hang.

const SOURCES = ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'];
const LIMIT_MS = 1500;

// The text `reg query` prints for one key, as { name: value } (a variable is only its name and REG_ type and value). %NAME% in a value is
// replaced from env (the variables of this process) when it is there.
function parseQuery(out, env = process.env) {
  const vars = {};
  for (const line of String(out ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/);
    if (!m) continue;
    vars[m[1]] = m[2].replace(/%([^%]+)%/g, (_, name) => env[name] ?? `%${name}%`);
  }
  return vars;
}

// The readings of the keys in SOURCES order, merged as the shell always did: a later key replaces an earlier one's variable, and every
// Path is joined onto the one before.
function merge(readings) {
  const vars = {};
  for (const reading of readings) {
    for (const [name, value] of Object.entries(reading ?? {})) {
      if (name.toLowerCase() === 'path') vars.Path = [vars.Path, value].filter(Boolean).join(';');
      else vars[name] = value;
    }
  }
  return vars;
}

// One query: resolves { ok, vars }. Never rejects, never waits longer than limitMs (its own timer, whatever `reg` does).
function queryOne(execFile, key, limitMs, env) {
  return new Promise(resolve => {
    let settled = false;
    let child = null;
    let timer = null;
    const done = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      try {
        child?.kill?.();
      } catch {
        // Already gone.
      }
      done({ ok: false, vars: {} });
    }, limitMs);
    timer.unref?.();
    try {
      child = execFile('reg', ['query', key], { encoding: 'utf8', windowsHide: true, timeout: limitMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) done({ ok: false, vars: {} });
        else done({ ok: true, vars: parseQuery(stdout, env) });
      });
    } catch {
      done({ ok: false, vars: {} });
    }
  });
}

// The reader. get() resolves { vars, complete } and never rejects; it asks once at a time and keeps a complete answer.
function createRegistryEnv({ execFile, limitMs = LIMIT_MS, env = process.env, sources = SOURCES } = {}) {
  let kept = null;
  let going = null;
  async function read() {
    const readings = await Promise.all(sources.map(key => queryOne(execFile, key, limitMs, env)));
    return { vars: merge(readings.map(r => r.vars)), complete: readings.every(r => r.ok) };
  }
  return {
    get() {
      if (kept) return Promise.resolve(kept);
      if (!going) {
        going = read()
          .catch(() => ({ vars: {}, complete: false }))
          .then(result => {
            if (result.complete) kept = result;
            going = null;
            return result;
          });
      }
      return going;
    },
  };
}

module.exports = { createRegistryEnv, parseQuery, merge, SOURCES, LIMIT_MS };
