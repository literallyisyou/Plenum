// Showing the desktop's UI on the phone (H3; MOBILE.json client_model.ui_source, MOBILE-UI 6.10 and 6.16). After HELLO the shell pulls the UI
// the computer has (ui-loader.js) and then hands the page over to it:
//
//   web (https: the PWA, the Tailscale page, the relay page)
//        the loader fills the cache the active record names; once the service worker controls the page, location.replace('/') loads the UI
//        document from that cache (sw.js rewrites its index). The shell's own screens stay reachable at /?shell (sw.js lets that through).
//   LAN web page (plain http on the phone's own network)
//        no service worker and no cache: the computer serves the UI document at / to a page that holds the path-key cookie (listener uiPull),
//        so the page only navigates to /.
//   Android app
//        the loader writes the files under the app-data folder and points the WebView at them (WebView.setServerBasePath, persisted), which
//        reloads the page at the UI. The shell files the UI page loads (/shell/...) are written beside them.
//        w7 follow-up (17 Nov 2026): on the UI page a newer copy is staged and the page moves to it by the rule below for the built-in screens
//        (a later HELLO, nothing running, no Stop going out, a complete verified record), never as soon as it arrives: the move reloads the page.
//        w7 (17 Nov 2026): when the computer's UI cannot be pulled or does not verify, the app opens the snapshot built into it (www/ui/, the
//        asset folder public/ui: WebView.setServerAssetPath) instead of stopping on the failed screen, when that snapshot fits the computer
//        (bundledFit: the same Plenum release as the HELLO's desktopVersion, on the same protocol major). It leaves a note (ui-loader.js
//        BUNDLED_NOTE) for Phone settings and for the page itself. On that page every HELLO and every return to the app pulls the computer's UI
//        again without moving (a staged copy); the page moves to it (storage.ensureActive) only at a later HELLO that says nothing is running,
//        and only to a complete record whose files all verified. A copy from the computer that verifies still wins: the fallback is only taken
//        when the pull fails. When the snapshot does not fit, the failed screen says which versions differ and which side to update.
//   iPhone app
//        the App Store build runs the bundled snapshot (www/ui/): the WebView's base path moves to that folder. Nothing is pulled.
//
// The way back is openShell(): the shell's screens (computers, Phone settings, lock set-up, pairing) are a separate page.
//   web and LAN <the page the shell's screens were on>?shell (remembered when the page left for the UI, /?shell when nothing is remembered:
//   the Tailscale page keeps them at /p/<key>/), Android WebView.setServerAssetPath('public'), iPhone the base path it started with.
// A link that goes with it (a pairing link, #settings, #computers, #connect=<id>) rides in the address on web and LAN; the apps have no address to
// carry it, so it waits in the linkStore (a short-lived entry in the app's secure storage, app.js) and the shell page takes it out when it
// starts. It is never written to sessionStorage: a pairing link holds the pairing secret, and any script of the page can read web storage.
// Every platform call goes through an injected object, so the Node suites drive this with fakes. Native navigation can be checked only on a
// phone: the suites check the calls, in order.
//
// Nothing here holds a key or a token. The loader talks to the computer only through channel.request.

import { UiError, VERSION_FILE, androidStorage, createUiLoader, webStorage } from './ui-loader.js';

export const SHELL_QUERY = 'shell';
export const SHELL_PAGE_KEY = 'plenum-shell-page';   // sessionStorage and localStorage: where the shell's screens are, for the way back from the UI page
export const SHELL_BASE_KEY = 'plenum-shell-base';   // sessionStorage (iPhone): the folder the shell's screens were loaded from
export const SHELL_LINK_KEY = 'plenum-shell-link';   // the key an older version used in sessionStorage; never written now (app.js clears it once at start)
export const UI_ROOT = 'plenum-ui';
export const BUNDLED_UI_FOLDER = 'ui';
// Android: the asset folders the WebView serves. 'public' is the app's www (the shell's own screens); 'public/ui' is the UI snapshot built into
// the app (scripts/build-mobile.mjs www/ui/, complete with its own /shell/ files). Capacitor answers getServerBasePath with the asset path set.
export const SHELL_ASSET = 'public';
export const BUNDLED_UI_ASSET = `public/${BUNDLED_UI_FOLDER}`;
const SW_WAIT_MS = 4000;
const DATA = 'DATA';

// The cause the ui-failed screen words (route.js ctx.cause): checksum, not-sent, stopped, worker (the browser cannot keep the screens), or
// version (w7: the computer could not send its UI and the app's built-in screens are for another Plenum release).
export function causeOf(error) {
  const code = error?.code ?? '';
  if (code === 'worker') return 'worker';
  if (code === 'version') return 'version';
  if (code === 'fetch') return 'not-sent';
  if (code === 'cancelled' || code === 'closed' || code === 'stopped' || code === 'offline' || code === 'lost') return 'stopped';
  return 'checksum';
}

// The line the debug log gets for a failed pull: the code, and for the loader's own errors its sentence, which names a URL path and sizes at most
// (ui-loader.js), so "ui: size (/ is 31046 bytes, not 31028)" says which file failed. Nothing else is written.
function failLine(error) {
  const code = error?.code ?? 'error';
  return error instanceof UiError && error.message && error.message !== code ? `ui: ${code} (${String(error.message).slice(0, 160)})` : `ui: ${code}`;
}

// ----- w7: whether the built-in screens fit a computer -----
//
// The UI page talks to the computer's own HTTP routes, so a UI fits a computer that serves the routes it was written for. Nothing in the
// protocol names an API version, and the UI checks none (public/app.js only reloads when the version or generation in its events hello
// changes). The two facts there are:
//   - the link protocol: the HELLO's protocol.major against the major of version.json's protocol (the channel already refuses another major,
//     with the update-app and update-desktop screens; it is checked again here so nothing is assumed), and
//   - the Plenum release: version.json's version (scripts/build-mobile.mjs writes the root package.json version, the release the ui/ snapshot
//     was copied from) against the HELLO's desktopVersion (the same package.json field on the computer).
// The built-in screens fit when both are equal: the same x.y.z, a pre-release counted, build metadata (+...) not. Anything that cannot be read
// does not fit ('unknown'), and the failed screen keeps the pull's own cause. An applied update (the HELLO's generation) is not compared: the
// built-in screens are the release's shipped ones, without the computer's applied changes.

// { text, parts: [x, y, z], pre } for 'x.y.z', 'vx.y.z', 'x.y.z-pre' and 'x.y.z+build', else null.
export function releaseOf(value) {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,40}))?(?:\+[0-9A-Za-z.-]{0,40})?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pre = m[4] ?? '';
  return { text: `${parts.join('.')}${pre ? `-${pre}` : ''}`, parts, pre };
}

// Negative when a comes before b. A pre-release comes before its release; two pre-releases are compared as text.
function compareRelease(a, b) {
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

// bundled: { version, protocol } from version.json (readBundledVersion). hello: the computer's HELLO.
// Returns { fits, why: null | 'unknown' | 'protocol' | 'version', app, desktop, update: null | 'desktop' | 'app' }.
export function bundledFit(bundled, hello) {
  const app = releaseOf(bundled?.version);
  const desktop = releaseOf(hello?.desktopVersion);
  const out = (fits, why, update = null) => ({ fits, why, app: app?.text ?? null, desktop: desktop?.text ?? null, update });
  const majorText = String(bundled?.protocol ?? '').split('.')[0];
  const major = /^\d{1,4}$/.test(majorText) ? Number(majorText) : null;
  if (!app || major === null) return out(false, 'unknown');
  if (hello?.protocol?.major !== major) return out(false, 'protocol');
  if (!desktop) return out(false, 'unknown');
  const order = compareRelease(desktop, app);
  if (order === 0) return out(true, null);
  return out(false, 'version', order < 0 ? 'desktop' : 'app');
}

// { version, protocol } of the app's version.json, or null when it cannot be read. readBundled(rel) as for the loader.
export async function readBundledVersion(readBundled) {
  if (!readBundled) return null;
  try {
    const bytes = await readBundled(VERSION_FILE);
    if (!bytes || !bytes.byteLength || bytes.byteLength > 64 * 1024) return null;
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object') return null;
    return { version: String(value.version ?? '').slice(0, 40), protocol: String(value.protocol ?? '').slice(0, 10) };
  } catch {
    return null;
  }
}

function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return globalThis.btoa(text);
}

function fromBase64(text) {
  const bin = globalThis.atob(String(text));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const stripFileScheme = uri => String(uri ?? '').replace(/^file:\/\//, '').replace(/\/+$/, '');

// The app-data folder through Capacitor's Filesystem plugin, in the shape androidStorage wants:
// { write(rel, bytes), read(rel) -> Uint8Array | null, removeDir(rel), listDirs(rel) -> names }.
export function filesOver(filesystem) {
  return {
    async write(rel, bytes) {
      await filesystem.writeFile({ path: rel, data: toBase64(bytes), directory: DATA, recursive: true });
    },
    async read(rel) {
      try {
        const out = await filesystem.readFile({ path: rel, directory: DATA });
        return typeof out?.data === 'string' ? fromBase64(out.data) : null;
      } catch {
        return null;
      }
    },
    async removeDir(rel) {
      try {
        await filesystem.rmdir({ path: rel, directory: DATA, recursive: true });
      } catch {
        // Nothing there.
      }
    },
    // w7: one file (the built-in screens' note). A Filesystem without deleteFile gets the file written as null, which reads as no note.
    async remove(rel) {
      try {
        if (typeof filesystem.deleteFile === 'function') await filesystem.deleteFile({ path: rel, directory: DATA });
        else await filesystem.writeFile({ path: rel, data: toBase64(new TextEncoder().encode('null')), directory: DATA, recursive: true });
      } catch {
        // Nothing there.
      }
    },
    async listDirs(rel) {
      try {
        const out = await filesystem.readdir({ path: rel, directory: DATA });
        return (out?.files ?? []).filter(f => f.type === 'directory' || f.type === undefined).map(f => String(f.name ?? f));
      } catch {
        return [];
      }
    },
  };
}

// Capacitor's WebView plugin in the shape androidStorage wants. androidStorage names folders relative to the app-data folder
// ('plenum-ui/<cache>'); the plugin wants absolute paths, so they are translated both ways. androidStorage calls persist before set (set
// reloads the page at once); the plugin persists the base path it currently serves, so here persist only notes the path and set does both
// calls back to back, set first, before the reload can take the page away.
export function webViewOver({ webView, filesystem }) {
  let dataRoot = null;
  let noted = null;
  const root = async () => {
    if (dataRoot === null) {
      const out = await filesystem.getUri({ path: '', directory: DATA });
      dataRoot = stripFileScheme(out?.uri);
    }
    return dataRoot;
  };
  const absolute = async rel => `${await root()}/${String(rel).replace(/^\/+/, '')}`;
  return {
    async persistServerBasePath({ path }) {
      noted = path;
    },
    async setServerBasePath({ path }) {
      const target = await absolute(path ?? noted);
      const set = webView.setServerBasePath({ path: target });
      const keep = webView.persistServerBasePath?.();
      await Promise.all([set, keep]);
    },
    async getServerBasePath() {
      const out = await webView.getServerBasePath();
      const abs = String(out?.path ?? '');
      const prefix = `${await root()}/`;
      return { path: abs.startsWith(prefix) ? abs.slice(prefix.length) : abs };
    },
  };
}

// Reads one bundled file of the app (its own www folder) as bytes, or null. rel is 'shell/boot.js'; the bundle keeps those files at the root.
export function bundledReader(fetchImpl, base) {
  return async rel => {
    const name = String(rel).replace(/^shell\//, '');
    try {
      const res = await fetchImpl(new URL(name, base).href, { cache: 'no-store' });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  };
}

// w7: the same for the Android page that runs the built-in screens (the WebView serves public/ui): the snapshot keeps the shell files under
// its own /shell/ (byte copies of the www ones), so rel is read as it is. version.json is not in the snapshot, so it reads as null there and
// nothing is decided from it (as on a page that runs a computer's copy).
export function bundledUiReader(fetchImpl, base) {
  return async rel => {
    try {
      const res = await fetchImpl(new URL(String(rel), base).href, { cache: 'no-store' });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  };
}

// kind: 'web' | 'lan' | 'android' | 'ios'.
export function createUiHost({
  env,
  kind,
  native = null,
  channelOf,
  log = () => {},
  linkStore = null,       // { put(text), take() }: where a link for the shell page waits on the apps (never web storage)
  stopHandoff = null,     // B-120: { pending(), park(pending), unpark() }: a Stop still queued or sending here goes with the page to the shell page
  swWaitMs = SW_WAIT_MS,
  loaderFactory = createUiLoader, // the Node suites pass a fake loader
  setTimer = (fn, ms) => env.setTimeout(fn, ms),
  clearTimer = id => env.clearTimeout(id),
} = {}) {
  const location = () => env.location;
  const session = () => {
    try {
      return env.sessionStorage ?? null;
    } catch {
      return null;
    }
  };
  const remember = (key, value) => {
    try {
      session()?.setItem(key, value);
    } catch {
      // The way back then falls to the default page.
    }
  };
  const recall = key => {
    try {
      return session()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  // localStorage outlives the session: the installed web app opens a fresh session at its start page, and the way back still needs the page.
  const durable = () => {
    try {
      return env.localStorage ?? null;
    } catch {
      return null;
    }
  };
  const rememberDurable = (key, value) => {
    try {
      durable()?.setItem(key, value);
    } catch {
      // The session copy, or the default page.
    }
  };
  const recallDurable = key => {
    try {
      return durable()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  // A remembered page is used only when it is a path of this origin that names the shell's screens.
  const isShellPage = value => typeof value === 'string' && /^\/(?![/\\])[^#\s]*\?shell(?:&[^#\s]*)?$/.test(value);

  function androidStore() {
    if (!native?.Filesystem || !native?.WebView) throw new UiError('storage', 'The app-data folder is not available.');
    return androidStorage({
      files: filesOver(native.Filesystem),
      webView: webViewOver({ webView: native.WebView, filesystem: native.Filesystem }),
      root: UI_ROOT,
    });
  }

  // w4-m1: the Android copy of the UI, { storage, record } when the active record is complete, else null (nothing can be read: null too).
  async function androidCopy() {
    try {
      const storage = androidStore();
      const record = await storage.readActive();
      return record?.complete === true && typeof record.cacheName === 'string' && record.cacheName ? { storage, record } : null;
    } catch {
      return null;
    }
  }

  // w7: true on the Android page that runs the built-in screens (the WebView serves the asset folder public/ui).
  async function onBundledPage() {
    if (kind !== 'android' || typeof native?.WebView?.getServerBasePath !== 'function') return false;
    try {
      const here = await native.WebView.getServerBasePath();
      return String(here?.path ?? '').replace(/^\/+|\/+$/g, '') === BUNDLED_UI_ASSET;
    } catch {
      return false;
    }
  }

  // w7: the app's own files, read where this page has them: the www root on the shell page, /shell/ on the built-in screens.
  function readerFor(bundledPage) {
    const read = bundledPage ? bundledUiReader : bundledReader;
    return read(env.fetch.bind(env), location().href);
  }

  // w7: the pull failed on the shell page. When the built-in screens fit this computer, the WebView moves to them (and a note says so);
  // otherwise the failed screen gets the cause, with the versions when they are the reason. The note goes first: the page may be gone as soon
  // as the asset path is set. persistServerBasePath right after it stores that asset path, which is no folder, so the next start opens the
  // shell page and not a folder path an earlier copy left (Capacitor opens a persisted path only when that folder exists).
  async function openBundled({ hello, computerId, error }) {
    const failed = (cause = causeOf(error), extra = {}) => ({ ok: false, cause, code: error?.code ?? 'error', ...extra });
    const webView = native?.WebView;
    if (typeof webView?.setServerAssetPath !== 'function') return failed();
    const fit = bundledFit(await readBundledVersion(readerFor(false)), hello);
    if (!fit.fits) {
      log(`ui: built-in screens do not fit (${fit.why}${fit.app ? ` ${fit.app}` : ''}${fit.desktop ? ` vs ${fit.desktop}` : ''})`);
      return fit.why === 'version' ? failed('version', { versions: { app: fit.app, desktop: fit.desktop, update: fit.update } }) : failed();
    }
    const cause = causeOf(error);
    try {
      await androidStore().writeNote({ computerId: typeof computerId === 'string' ? computerId : null, at: Date.now(), cause, desktopVersion: fit.desktop, appVersion: fit.app });
    } catch {
      // Phone settings then does not say so, and the built-in page serves any computer (uiComputerId 'any').
    }
    try {
      const set = webView.setServerAssetPath({ path: BUNDLED_UI_ASSET });
      const keep = webView.persistServerBasePath?.();
      await Promise.all([set, keep]);
    } catch (err) {
      log(`ui: built-in screens did not open (${err?.code ?? 'error'})`);
      return failed();
    }
    log(`ui: using the built-in screens (${cause})`);
    return { ok: true, status: 'bundled', navigated: true, cause, code: error?.code ?? 'error' };
  }

  // w7: on an Android UI page (the built-in screens, or a copy from the computer). The computer's UI is pulled again without moving (staged).
  // The page moves to it only when mayMove (app.js: a HELLO that says nothing is running, no Stop in flight), only when the copy was already
  // complete before this call (status 'current': the record holds what the computer serves now, every file verified), and never on a return to
  // the app (reason 'resume' stages only). Moving reloads the WebView at once, so a reply that is streaming is never cut by a newer copy.
  // w7 follow-up (17 Nov 2026): a page that runs a copy from the computer moved to a newer copy as soon as it verified, mid-turn too; it now
  // waits by the same rule. Its own folder is kept while it runs (androidStorage dropSlotsExcept), and removed at the first HELLO after the move.
  async function refreshStaged({ hello, computerId, mayMove, reason, bundledPage }) {
    const channel = channelOf();
    if (!channel) throw new UiError('offline', 'The phone is not connected.');
    const storage = androidStore();
    const readBundled = readerFor(bundledPage);
    const loader = loaderFactory({ channel, storage, platform: 'android', shellBase: '/shell/', readBundled });
    const result = await loader.check({ helloHash: hello?.uiManifestHash || null, loadedHash: null, computerId, activate: false });
    const page = moved => (bundledPage ? { bundled: !moved } : {});
    const ready = result?.status === 'current' && result.record?.complete === true;
    if (!ready || !mayMove || reason === 'resume') return { ok: true, changed: false, reload: false, ...page(false), staged: result?.record?.complete === true };
    const moved = await storage.ensureActive(result.record, { readBundled, shellBase: '/shell/' });
    if (moved) log(bundledPage ? 'ui: moved from the built-in screens to the computer\'s copy' : 'ui: moved to the newer copy from the computer');
    // The page runs this record's folder: an older one left from before the move can go now.
    else if (!bundledPage) await storage.dropSlotsExcept(result.record.cacheName).catch(() => {});
    return { ok: true, changed: moved, reload: false, ...page(moved), staged: true, switched: moved };
  }

  function buildLoader() {
    const channel = channelOf();
    if (!channel) throw new UiError('offline', 'The phone is not connected.');
    if (kind === 'android') {
      const storage = androidStore();
      return loaderFactory({ channel, storage, platform: 'android', shellBase: '/shell/', readBundled: readerFor(false) });
    }
    if (!env.caches) throw new UiError('worker', 'This browser cannot keep Plenum\'s screens.');
    return loaderFactory({ channel, storage: webStorage(env.caches), platform: 'web', shellBase: '/shell/' });
  }

  // Waits until a service worker controls this page: the registration is ready, and the worker has claimed the page.
  async function workerControls() {
    const sw = env.navigator?.serviceWorker;
    if (!sw) return false;
    if (sw.controller) return true;
    try {
      await Promise.race([sw.ready, new Promise((_, reject) => setTimer(() => reject(new Error('timeout')), swWaitMs))]);
    } catch {
      return Boolean(sw.controller);
    }
    if (sw.controller) return true;
    return new Promise(resolve => {
      let timer = null;
      const done = () => {
        if (timer !== null) clearTimer(timer);
        resolve(Boolean(sw.controller));
      };
      sw.addEventListener?.('controllerchange', done, { once: true });
      timer = setTimer(done, swWaitMs);
    });
  }

  // Web and LAN: the page the shell's screens were on when the page left them (the Tailscale page keeps them at /p/<key>/, where /?shell would
  // be a 404, and on the loopback it would answer the UI document), else /?shell.
  function shellUrl() {
    for (const saved of [recall(SHELL_PAGE_KEY), recallDurable(SHELL_PAGE_KEY)]) {
      if (isShellPage(saved)) return saved;
    }
    return `/?${SHELL_QUERY}`;
  }

  return {
    kind,

    // The shell page, before it leaves for the UI: remembers where its screens are.
    rememberShellPage() {
      const page = `${location().pathname}?${SHELL_QUERY}`;
      remember(SHELL_PAGE_KEY, page);
      rememberDurable(SHELL_PAGE_KEY, page);
    },

    // True when the page was opened for the shell's own screens (/?shell): it stays on them and does not go to the UI.
    staysOnShell() {
      return new URLSearchParams(String(location()?.search ?? '')).has(SHELL_QUERY);
    },

    // Pulls what the computer has and hands the page to the UI. Resolves { ok: true, status, navigated } or { ok: false, cause, code }.
    async show({ hello, computerId = null, loadedHash = null, onProgress = () => {} } = {}) {
      onProgress({ done: 0, total: 1 });
      try {
        if (kind === 'lan') {
          this.rememberShellPage();
          location().replace('/');
          return { ok: true, status: 'lan', navigated: true };
        }
        if (kind === 'ios') {
          const webView = native?.WebView;
          if (!webView?.getServerBasePath || !webView?.setServerBasePath) throw new UiError('storage', 'The app cannot switch to its bundled screens.');
          const here = await webView.getServerBasePath();
          const base = String(here?.path ?? '').replace(/\/+$/, '');
          if (!base) throw new UiError('storage', 'The bundled screens are not where the app expects them.');
          remember(SHELL_BASE_KEY, base);
          await webView.setServerBasePath({ path: `${base}/${BUNDLED_UI_FOLDER}` });
          return { ok: true, status: 'bundled', navigated: true };
        }
        if (kind === 'android') {
          let result;
          try {
            result = await buildLoader().check({ helloHash: hello?.uiManifestHash ?? null, loadedHash, computerId });
          } catch (error) {
            // w7: the computer's UI did not arrive whole. The built-in screens stand in when they fit this computer.
            log(failLine(error));
            return await openBundled({ hello, computerId, error });
          }
          onProgress({ done: 1, total: 1 });
          // check() has already pointed the WebView at the UI (activate, or ensureActive for a UI that was current): the page reloads there.
          return { ok: true, status: result.status, navigated: true, reload: result.reload };
        }
        const loader = buildLoader();
        const result = await loader.check({ helloHash: hello?.uiManifestHash ?? null, loadedHash, computerId });
        onProgress({ done: 1, total: 1 });
        if (!(await workerControls())) throw new UiError('worker', 'No service worker controls this page.');
        this.rememberShellPage();
        location().replace('/');
        return { ok: true, status: result.status, navigated: true, reload: result.reload };
      } catch (error) {
        log(failLine(error));
        return { ok: false, cause: causeOf(error), code: error?.code ?? 'error' };
      }
    },

    // On the UI page: asks whether the computer has a newer UI. { ok, changed, reload }. The page reloads once per new UI (the loader's
    // shouldReload keeps the count), and the caller does the reload.
    // w7: reason is 'hello' (a HELLO arrived) or 'resume' (the app came back); mayMove (app.js uiMayMove) says nothing is running. On every
    // Android UI page this stages the computer's copy and moves to it only as refreshStaged says (the built-in page also stages on a resume;
    // a page that runs a copy from the computer asks for nothing then, as the web page does: the HELLO already did).
    async refresh({ hello, loadedHash = null, computerId = null, mayMove = false, reason = 'hello' } = {}) {
      if (kind === 'lan' || kind === 'ios') return { ok: true, changed: false, reload: false };
      try {
        if (await onBundledPage()) return await refreshStaged({ hello, computerId, mayMove: mayMove === true, reason, bundledPage: true });
        if (reason === 'resume') return { ok: true, changed: false, reload: false };
        if (kind === 'android') return await refreshStaged({ hello, computerId, mayMove: mayMove === true, reason, bundledPage: false });
        const loader = buildLoader();
        const result = await loader.check({ helloHash: hello?.uiManifestHash ?? null, loadedHash, computerId });
        return { ok: true, changed: result.status === 'updated', reload: result.reload === true };
      } catch (error) {
        log(failLine(error));
        return { ok: false, changed: false, reload: false, cause: causeOf(error) };
      }
    },

    // w7: which screens this phone uses for its computer, for Phone settings and About (Android only; elsewhere null):
    //   { kind: 'bundled', computerId, cause }   the built-in screens, opened because that computer could not send its own (the note)
    //   { kind: 'computer', computerId, files }  a complete copy from that computer, every file checked against its manifest
    async uiSource() {
      if (kind !== 'android') return null;
      try {
        const storage = androidStore();
        const note = await storage.readNote();
        if (note) return { kind: 'bundled', computerId: note.computerId, cause: note.cause };
        const record = await storage.readActive();
        if (record?.complete === true && Array.isArray(record.files)) return { kind: 'computer', computerId: record.computerId ?? null, files: record.files.length };
        return null;
      } catch {
        return null;
      }
    },

    // Which computer the UI on this page came from (one UI per computer): the active record's computerId on web and Android (null when it is not
    // known: no record, or one written before the id was kept), and 'any' where the page cannot tell and the computer serves it (the LAN page, the
    // iPhone's bundled copy).
    // w7: the Android page on the built-in screens answers the computer its note names (it was checked against that one), or 'any' without a
    // note, so it never sends the person round through the shell page again for the same computer.
    async uiComputerId() {
      if (kind === 'lan' || kind === 'ios') return 'any';
      if (await onBundledPage()) {
        try {
          return (await androidStore().readNote())?.computerId ?? 'any';
        } catch {
          return 'any';
        }
      }
      try {
        const storage = kind === 'android' ? androidStore() : env.caches ? webStorage(env.caches) : null;
        const record = storage ? await storage.readActive() : null;
        return typeof record?.computerId === 'string' && record.computerId ? record.computerId : null;
      } catch {
        return null;
      }
    },

    // The hash of the UI the cache serves now, or null.
    async loadedHash() {
      if (kind !== 'web' || !env.caches) return null;
      try {
        const record = await webStorage(env.caches).readActive();
        return record?.complete === true ? record.hash : null;
      } catch {
        return null;
      }
    },

    // Whether a complete copy of the UI is on the phone, for "Use the copy in this app".
    // w4-m1: on Android the copy is the complete active record in the app-data folder (loadedHash answers for the web cache only).
    async hasCopy() {
      if (kind === 'ios') return true;
      if (kind === 'lan') return false;
      if (kind === 'android') return (await androidCopy()) !== null;
      return (await this.loadedHash()) !== null;
    },

    // Uses the copy that is already on the phone, without asking the computer.
    async useCopy() {
      if (kind === 'ios') return this.show({});
      // w4-m1: Android activates the record it has (with this app's shell files) and the WebView reloads at it.
      if (kind === 'android') {
        try {
          const copy = await androidCopy();
          if (!copy) throw new UiError('storage', 'There is no copy of the screens on this phone.');
          await copy.storage.activateCopy(copy.record, { readBundled: bundledReader(env.fetch.bind(env), location().href), shellBase: '/shell/' });
          return { ok: true, status: 'copy', navigated: true };
        } catch (error) {
          log(failLine(error));
          return { ok: false, cause: causeOf(error), code: error?.code ?? 'error' };
        }
      }
      if (kind === 'web' && (await this.loadedHash()) !== null && (await workerControls())) {
        this.rememberShellPage();
        location().replace('/');
        return { ok: true, status: 'copy', navigated: true };
      }
      return { ok: false, cause: 'worker', code: 'worker' };
    },

    // From the UI page back to the shell's screens. link (a pairing link, #settings, #computers, #connect=<id>) rides along: in the address on web
    // and LAN pages (the '#...' part only), in the linkStore for the apps (the shell page takes it out once, within two minutes).
    //
    // B-120: a Stop that is still queued or sending lives in this page's channel worker, which ends with the page. It is left in the store
    // (the shell page sends it, if it is under a minute old) before the page goes. Only the page that is leaving does this, and it takes
    // the note back when the page does not go.
    async openShell(link = '') {
      const text = typeof link === 'string' ? link : '';
      let parked = false;
      try {
        const pending = stopHandoff?.pending?.() ?? null;
        if (pending) {
          await stopHandoff.park(pending);
          parked = true;
        }
      } catch {
        parked = false;
      }
      const unpark = async () => {
        if (!parked) return;
        try { await stopHandoff.unpark(); } catch { /* nothing to take back */ }
      };
      if (kind === 'web' || kind === 'lan') {
        location().assign(`${shellUrl()}${text.startsWith('#') ? text : ''}`);
        return true;
      }
      const webView = native?.WebView;
      if (!webView) {
        await unpark();
        return false;
      }
      const base = kind === 'android' ? null : recall(SHELL_BASE_KEY);
      const switchPage = kind === 'android'
        ? (webView.setServerAssetPath ? () => webView.setServerAssetPath({ path: SHELL_ASSET }) : null)
        : (base && webView.setServerBasePath ? () => webView.setServerBasePath({ path: base }) : null);
      if (!switchPage) {
        await unpark();
        return false;
      }
      if (text) await linkStore?.put(text);
      try {
        await switchPage();
      } catch (error) {
        // The page did not switch, so nothing is left to take the link: it does not stay.
        if (text) {
          try { await linkStore?.take(); } catch { /* nothing to take back */ }
        }
        await unpark();
        throw error;
      }
      return true;
    },
  };
}
