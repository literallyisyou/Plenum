#!/usr/bin/env node
// Builds Plenum's Android debug APK for the owner's own phone, in one command (wave 4, k1). Node only, no dependencies.
//
// usage: node scripts/build-android.mjs [--check | --native-only] [--phone]
//   --phone    builds the phone build type instead (64-bit ARM only, unused code removed; dist-android/plenum-phone-*.apk, the
//              newest three kept apart from the debug ones).
//   no option  finds the toolchain, writes mobile/android/local.properties (sdk.dir), then runs, in order:
//                node scripts/build-mobile.mjs (and its --check), cap sync android (in mobile/, the local Capacitor CLI),
//                gradlew assembleDebug --no-daemon (in mobile/android/),
//              and copies the APK to <project>/dist-android/plenum-debug-<versionName>.apk, printing its path, size and sha256.
//              Then only the newest three plenum-debug-*.apk there are kept (wave 5, f2): older copies it made are deleted, by
//              that name pattern only; nothing else in the folder is touched. dist-android/ is on D: (the real project folder)
//              and git ignores it.
//   --check    only reports what it found. Writes nothing and runs nothing.
//   --native-only  skips the phone bundle and cap sync: Gradle packs the web files mobile/android already has (after a change
//              to the Java, Kotlin, resources or Gradle files only). The APK still gets a new versionCode.
// When something is missing it prints one plain sentence per item, saying what to install and where, and exits 1.
//
// What it looks for:
//   Java 21 exactly (Gradle 8.14 cannot run on Java 25): JAVA_HOME when that is a JDK 21, else the usual folders on D: and in
//   C:\Program Files (Temurin, Microsoft, Oracle, Android Studio's jbr). The version is read from the JDK's `release` file;
//   no java process is started.
//   The Android SDK: ANDROID_HOME, ANDROID_SDK_ROOT, D:\Android\sdk, %LOCALAPPDATA%\Android\Sdk, with platforms;android-36
//   and build-tools 36.
// Where things go (the owner's rule: caches on D:, never on C:): GRADLE_USER_HOME=D:\Gradle (Gradle, its wrapper and the
// libraries), ANDROID_USER_HOME=D:\Android\user (the debug signing key, kept so each APK installs over the last one).
//
// It never downloads a JDK or an SDK, never starts an emulator or adb, never installs anything on a phone, and opens no window.
// Gradle itself fetches libraries it does not have yet into D:\Gradle on a first build.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const realOr = p => { try { return fs.realpathSync.native(p); } catch { return p; } };
// The real folder (the old OneDrive path is a junction to D:\Projects\Muse Console): outputs never land inside OneDrive.
export const ROOT = realOr(path.resolve(HERE, '..'));
export const MOBILE = path.join(ROOT, 'mobile');
export const ANDROID = path.join(MOBILE, 'android');
export const GRADLE_USER_HOME = 'D:\\Gradle';
export const ANDROID_USER_HOME = 'D:\\Android\\user';
export const PLATFORM = 'android-36';
export const BUILD_TOOLS_MAJOR = '36';

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const listDir = p => { try { return fs.readdirSync(p).sort(); } catch { return []; } };

// The Java in `home`, from its `release` file (JAVA_VERSION="21.0.13"): { major, full, jdk }, where jdk says the compiler
// (javac) is there too; a runtime alone (a JRE) cannot build. null when `home` holds no Java.
export function jdkVersion(home) {
  if (!home) return null;
  const exe = name => path.join(home, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
  if (!isFile(exe('java'))) return null;
  let text = '';
  try { text = fs.readFileSync(path.join(home, 'release'), 'utf8'); } catch { return null; }
  const m = /^JAVA_VERSION="?(\d+)(?:\.(\d+))?[^"\n]*"?/m.exec(text);
  if (!m) return null;
  const major = Number(m[1]) === 1 ? Number(m[2]) : Number(m[1]);
  const full = /^JAVA_VERSION="?([^"\n]+)"?/m.exec(text)[1];
  return { major, full, jdk: isFile(exe('javac')) };
}

// The folders a JDK 21 is usually installed in on this kind of PC, most likely first. Folders whose names do not say 21 are
// still checked by their release file.
export function jdkCandidates(env = process.env) {
  const out = [];
  const add = p => { if (p && !out.includes(p)) out.push(p); };
  add('D:\\Android\\jdk21');
  for (const parent of ['D:\\Android', 'D:\\Java', 'D:\\', 'D:\\Program Files\\Eclipse Adoptium', 'D:\\Program Files\\Microsoft', 'D:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Java', 'C:\\Program Files\\Zulu']) {
    for (const name of listDir(parent)) if (/^(jdk|temurin|zulu|microsoft-jdk|openjdk)[-_.]?.*21/i.test(name) || /^jdk-?21/i.test(name)) add(path.join(parent, name));
  }
  for (const studio of ['D:\\Android\\Android Studio', 'D:\\Program Files\\Android\\Android Studio', 'C:\\Program Files\\Android\\Android Studio',
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Android Studio') : null]) {
    if (studio) add(path.join(studio, 'jbr'));
  }
  return out;
}

// { home, version, from } for the JDK 21 to use, or { home: null, notes } when none is found.
export function findJdk({ env = process.env, candidates = jdkCandidates(env) } = {}) {
  const notes = [];
  if (env.JAVA_HOME) {
    const v = jdkVersion(env.JAVA_HOME);
    if (v?.major === 21 && v.jdk) return { home: env.JAVA_HOME, version: v.full, from: 'JAVA_HOME', notes };
    notes.push(!v ? `JAVA_HOME (${env.JAVA_HOME}) holds no Java, so it is not used.`
      : v.major !== 21 ? `JAVA_HOME is Java ${v.major} (${env.JAVA_HOME}), not 21, so it is not used.`
        : `JAVA_HOME is a Java 21 runtime without the compiler (${env.JAVA_HOME}), so it is not used.`);
  }
  for (const home of candidates) {
    const v = jdkVersion(home);
    if (v?.major === 21 && v.jdk) return { home, version: v.full, from: 'found', notes };
  }
  return { home: null, version: null, from: null, notes };
}

// What an SDK folder has: the API 36 platform and a build-tools 36.x.
export function sdkContents(root) {
  const platform = isFile(path.join(root, 'platforms', PLATFORM, 'android.jar'));
  const buildTools = listDir(path.join(root, 'build-tools')).filter(n => n.split('.')[0] === BUILD_TOOLS_MAJOR && isDir(path.join(root, 'build-tools', n)));
  return { platform, buildTools: buildTools.at(-1) ?? null };
}

export function sdkCandidates(env = process.env) {
  const out = [];
  const add = p => { if (p && !out.includes(p)) out.push(p); };
  add(env.ANDROID_HOME);
  add(env.ANDROID_SDK_ROOT);
  add('D:\\Android\\sdk');
  if (env.LOCALAPPDATA) add(path.join(env.LOCALAPPDATA, 'Android', 'Sdk'));
  return out;
}

// { root, platform, buildTools } of the first SDK folder that has both, or the best partial one with what it lacks.
export function findSdk({ env = process.env, candidates = sdkCandidates(env) } = {}) {
  let partial = null;
  for (const root of candidates) {
    if (!isDir(root)) continue;
    const has = sdkContents(root);
    if (has.platform && has.buildTools) return { root, ...has, complete: true };
    if (!partial) partial = { root, ...has, complete: false };
  }
  return partial ?? { root: null, platform: false, buildTools: null, complete: false };
}

// The environment Gradle and the Capacitor CLI run with. GRADLE_USER_HOME and ANDROID_USER_HOME are always on D:, whatever
// the calling shell had (a C:\Users\...\.gradle cache is never used).
export function childEnv(base, { jdk, sdk }) {
  const env = { ...base };
  env.JAVA_HOME = jdk;
  env.ANDROID_HOME = sdk;
  env.ANDROID_SDK_ROOT = sdk;
  env.GRADLE_USER_HOME = GRADLE_USER_HOME;
  env.ANDROID_USER_HOME = ANDROID_USER_HOME;
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
  env[key] = [path.join(jdk, 'bin'), env[key] ?? ''].filter(Boolean).join(path.delimiter);
  return env;
}

// sdk.dir in Java properties form: D:\Android\sdk -> D\:\\Android\\sdk.
export function localProperties(sdk) {
  return `# Written by scripts/build-android.mjs: where the Android SDK is on this computer. Not committed.\nsdk.dir=${sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`;
}

// Everything the build needs, with one plain sentence for each missing item.
export function inspect({ env = process.env } = {}) {
  const found = [];
  const missing = [];
  const notes = [];
  const jdk = findJdk({ env });
  notes.push(...jdk.notes);
  if (jdk.home) found.push(`Java 21: ${jdk.home} (${jdk.version}${jdk.from === 'JAVA_HOME' ? ', from JAVA_HOME' : ''})`);
  else missing.push('Java 21 is not installed. Install Eclipse Temurin 21 (the JDK, not 25: Gradle 8.14 cannot run on Java 25) into D:\\Android\\jdk21, or set JAVA_HOME to a JDK 21.');
  const sdk = findSdk({ env });
  if (sdk.complete) found.push(`Android SDK: ${sdk.root} (platform ${PLATFORM}, build-tools ${sdk.buildTools})`);
  else if (!sdk.root) missing.push('The Android SDK is not installed. Install the Android command-line tools into D:\\Android\\sdk, then run sdkmanager "platforms;android-36" "build-tools;36.0.0" "platform-tools".');
  else {
    if (!sdk.platform) missing.push(`The Android SDK in ${sdk.root} has no Android 16 platform. Run sdkmanager "platforms;android-36" there.`);
    if (!sdk.buildTools) missing.push(`The Android SDK in ${sdk.root} has no build-tools 36. Run sdkmanager "build-tools;36.0.0" there.`);
  }
  if (isDir('D:\\')) {
    found.push(`Gradle cache: ${GRADLE_USER_HOME} (GRADLE_USER_HOME)`);
    found.push(`Debug signing key folder: ${ANDROID_USER_HOME} (ANDROID_USER_HOME)${isFile(path.join(ANDROID_USER_HOME, 'debug.keystore')) ? ', key present' : ', a key is made on the first build'}`);
    const wrapper = /distributionUrl=.*gradle-([\d.]+)-(all|bin)\.zip/.exec(readText(path.join(ANDROID, 'gradle', 'wrapper', 'gradle-wrapper.properties')));
    if (wrapper && !isDir(path.join(GRADLE_USER_HOME, 'wrapper', 'dists', `gradle-${wrapper[1]}-${wrapper[2]}`))) {
      notes.push(`Gradle ${wrapper[1]} is not in ${GRADLE_USER_HOME} yet: the first build fetches it there (about 200 MB).`);
    }
  } else {
    missing.push('Drive D: is not there. The build keeps Gradle\'s cache in D:\\Gradle and the debug key in D:\\Android\\user, never on C:.');
  }
  if (isFile(path.join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'))) found.push(`Gradle wrapper: ${path.join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')}`);
  else missing.push(`The Gradle wrapper is missing from ${ANDROID}. Restore mobile/android from the repository.`);
  if (isFile(capacitorCli())) found.push(`Capacitor CLI: ${path.dirname(path.dirname(capacitorCli()))}`);
  else missing.push('The phone app\'s packages are not installed. Run npm ci --prefix mobile in the project folder.');
  found.push(`APK goes to: ${path.join(ROOT, 'dist-android')}`);
  return { jdk, sdk, found, missing, notes };
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function capacitorCli() {
  return path.join(MOBILE, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
}

function report({ found, missing, notes }) {
  console.log('Plenum Android build: what this computer has');
  for (const line of found) console.log(`  ${line}`);
  for (const line of notes) console.log(`  Note: ${line}`);
  for (const line of missing) console.log(`  Missing: ${line}`);
}

function run(label, command, args, options) {
  console.log(`\n== ${label}`);
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error || result.status !== 0) {
    console.log(`\nThe step "${label}" did not finish. Its messages are above; fix what they name and run this again.`);
    process.exit(1);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// The versionName Gradle gave the APK (app/build.gradle: <package version>-dev.<date>), from the build's output metadata.
export function apkVersionName(outputDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(outputDir, 'output-metadata.json'), 'utf8'));
    const name = meta?.elements?.[0]?.versionName;
    if (typeof name === 'string' && /^[\w.+-]{1,64}$/.test(name)) return name;
  } catch { /* no metadata */ }
  return null;
}

// The APK names this script gives its copies (plenum-debug-<versionName>.apk; apkVersionName's pattern, or the date fallback).
export const APK_NAME = /^plenum-debug-[\w.+-]{1,64}\.apk$/;
// The phone build's copies (--phone: plenum-phone-<versionName>.apk), kept and pruned apart from the debug ones.
export const PHONE_APK_NAME = /^plenum-phone-[\w.+-]{1,64}\.apk$/;
export const APKS_KEPT = 3;

// After a successful copy: keeps the newest `keep` APKs this script made in `dir` (by its own name pattern), the one just copied
// always among them, and deletes the older ones. Anything else in the folder (other names, folders, links) is never touched.
// Returns { removed: [names], failed: [names] }.
export function pruneApks(dir, { keep = APKS_KEPT, justMade = null, pattern = APK_NAME } = {}) {
  const removed = [];
  const failed = [];
  const mine = [];
  for (const name of listDir(dir)) {
    if (!pattern.test(name)) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    mine.push({ name, full, mtime: st.mtimeMs });
  }
  const fresh = justMade ? path.basename(justMade) : null;
  // Newest first; the one just copied first of all (a copy can keep Gradle's older file time), then by name for equal times.
  mine.sort((a, b) => (b.name === fresh) - (a.name === fresh) || b.mtime - a.mtime || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  for (const old of mine.slice(Math.max(1, keep))) {
    try {
      fs.unlinkSync(old.full);
      removed.push(old.name);
    } catch {
      failed.push(old.name);
    }
  }
  return { removed, failed };
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const nativeOnly = argv.includes('--native-only');
  // --phone: the phone build type (app/build.gradle): 64-bit ARM only, unused code and resources removed, signed with the debug key.
  const phone = argv.includes('--phone');
  const unknown = argv.filter(a => a !== '--check' && a !== '--native-only' && a !== '--phone');
  if (unknown.length) {
    console.log(`Unknown option ${unknown[0]}. Use node scripts/build-android.mjs, or add --check to only look.`);
    return 1;
  }
  const found = inspect();
  report(found);
  if (found.missing.length) {
    console.log(`\n${found.missing.length === 1 ? 'One thing is' : `${found.missing.length} things are`} missing; nothing was built.`);
    return 1;
  }
  if (check) {
    console.log('\nEverything the build needs is here. Run node scripts/build-android.mjs to build the APK.');
    return 0;
  }

  const jdk = found.jdk.home;
  const sdk = found.sdk.root;
  const env = childEnv(process.env, { jdk, sdk });
  for (const dir of [GRADLE_USER_HOME, ANDROID_USER_HOME]) fs.mkdirSync(dir, { recursive: true });
  const props = path.join(ANDROID, 'local.properties');
  const wanted = localProperties(sdk);
  if (readText(props) !== wanted) fs.writeFileSync(props, wanted);

  if (!nativeOnly) {
    run('Phone bundle', process.execPath, [path.join(ROOT, 'scripts', 'build-mobile.mjs')], { cwd: ROOT, env });
    run('Phone bundle check', process.execPath, [path.join(ROOT, 'scripts', 'build-mobile.mjs'), '--check'], { cwd: ROOT, env });
    run('cap sync android', process.execPath, [capacitorCli(), 'sync', 'android'], { cwd: MOBILE, env });
  }
  const variant = phone ? 'phone' : 'debug';
  const task = phone ? 'assemblePhone' : 'assembleDebug';
  // -PplenumPhone keeps only English library resources in the phone build (app/build.gradle, defaultConfig).
  const gradleArgs = phone ? ['--no-daemon', '-PplenumPhone', task] : ['--no-daemon', task];
  if (process.platform === 'win32') {
    // A .bat runs only through cmd.exe. The full path is quoted (the project folder has a space), and the line is passed as is,
    // so Node does not quote it a second time; cmd /s takes off the outer pair of quotes.
    const gradlew = path.join(ANDROID, 'gradlew.bat');
    run(`Gradle ${task}`, env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${gradlew}" ${gradleArgs.join(' ')}"`], { cwd: ANDROID, env, windowsVerbatimArguments: true });
  } else {
    run(`Gradle ${task}`, path.join(ANDROID, 'gradlew'), gradleArgs, { cwd: ANDROID, env });
  }

  const outDir = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', variant);
  const apk = path.join(outDir, `app-${variant}.apk`);
  if (!isFile(apk)) {
    console.log(`\nGradle finished but left no APK at ${apk}. Run this again; if it repeats, look at the Gradle messages above.`);
    return 1;
  }
  const versionName = apkVersionName(outDir) ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const destDir = path.join(ROOT, 'dist-android');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `plenum-${variant}-${versionName}.apk`);
  fs.copyFileSync(apk, dest);
  const size = fs.statSync(dest).size;
  console.log('\nThe APK is ready.');
  console.log(`  ${dest}`);
  console.log(`  ${(size / 1048576).toFixed(1)} MB (${size} bytes)`);
  console.log(`  sha256 ${sha256(dest)}`);
  const pruned = pruneApks(destDir, { justMade: dest, pattern: phone ? PHONE_APK_NAME : APK_NAME });
  if (pruned.removed.length) console.log(`  Removed ${pruned.removed.length} older APK${pruned.removed.length === 1 ? '' : 's'} (the newest ${APKS_KEPT} are kept).`);
  if (pruned.failed.length) console.log(`  Could not remove ${pruned.failed.join(', ')}; it is still in ${destDir}.`);
  console.log(`To put it on your phone (USB debugging on): adb install -r "${dest}"`);
  return 0;
}

// Whether this file was started as the script (not imported). Node keeps the case of the path as it was typed in import.meta.url, while
// the real path has the case on disk, so "d:\projects\muse console" never matched and the script did nothing and said nothing (shell-3).
// As scripts/stamp-build.mjs does: the typed path first, then the real path of both sides.
const startedHere = () => {
  const typed = path.resolve(process.argv[1]);
  if (import.meta.url === pathToFileURL(typed).href) return true;
  try {
    return fs.realpathSync.native(fileURLToPath(import.meta.url)) === fs.realpathSync.native(typed);
  } catch {
    return false;
  }
};
if (process.argv[1] && startedHere()) {
  process.exitCode = main();
}
