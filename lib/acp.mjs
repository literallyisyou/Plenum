import { promises as fs } from 'node:fs';
import { KILL_LIMIT_MS, enterStartGate, killTree, noteSignInBusy, resolveLaunch, startChild, stripAnsi } from './proc.mjs';
import { classifyCliFailure, cliError } from './cli-errors.mjs';
import { knownMisfit, rememberRefusal } from './cli-fit.mjs';

// The client side of the Agent Client Protocol over stdio: newline-delimited JSON-RPC 2.0 on the agent's stdin and stdout.
// lib/cursor.mjs runs `agent acp` through it, and lib/grok.mjs runs `grok agent stdio`. The run goes: initialize, session/new,
// session/prompt, with session/update notifications read on the way. The agent asks for permission with
// session/request_permission, and onPermission decides; the answer is one of the options the agent offered. Plenum offers no
// file access (the fs capabilities are false), so any other request from the agent gets a "method not found" error.
// The field shapes come from the ACP specification (https://agentclientprotocol.com), not from a signed-in Cursor run, so every
// field is read defensively and an unknown line is skipped. A line longer than 8 MB is dropped.
// Ending a run: a stop (the abort signal) sends session/cancel and then ends the process, within about a second.
// A reply that was cut off: the agent's end marker is its answer to session/prompt. An agent that exits, or answers the prompt with an
// error, after reply text has arrived has left a reply that is not whole. The run then rejects with a CliError (lib/cli-errors.mjs)
// whose message starts with CUT_OFF, with partial: true and the kind read from the agent's own words; the text that arrived stays with
// the caller, which has it from onText. A failure before any reply text keeps the message it always had and carries the kind too
// (kind, retryable), so the page can offer the button that fits. A stop is never an error.
// Before the agent is started: a command line that this version of the agent has already refused ("unknown command acp") is not sent
// again. The run rejects with the words of lib/cli-fit.mjs (kind 'flags-rejected', before: true) and nothing is started.
// The start gate (lib/proc.mjs, DECISIONS item 159) is passed before the agent is started, as every other program's start does: two
// processes of one signed-in CLI (two council seats, or a turn beside a model-list read) start apart, and after a sign-in that another
// process was renewing. A Stop during that wait ends the run with nothing started. A failure of kind sign-in-busy holds the next starts.
// An agent that Plenum itself ended (a Stop, a handshake that timed out, the end of the run) is never read for a cause: what it wrote
// to its error output while it was being ended says nothing about its command line, so no refusal is remembered from it.

export const ACP_VERSION = 1;
// How long the agent may stay silent before its session exists. It was 30 seconds for a run; on the owner's PC the agents needed more
// than 20 seconds for it (see LIST_HANDSHAKE_MS), so a turn sent while the PC was busy could fail at 30. The clock starts again each
// time the agent writes anything (it is alive and starting up), up to HANDSHAKE_CAP times the limit in all.
export const HANDSHAKE_MS = 60_000;
export const HANDSHAKE_CAP = 4;
// The handshake limit of a model-list read (lib/muse-models.mjs, lib/antigravity.mjs), which sends no prompt and runs in the background.
// It was 20 seconds; on the owner's PC Muse Code 1.4.23 and Antigravity took longer than that every time (server.log, 16 and 17 Nov
// 2026: 20.8, 21.0, 24.6 and 34.9 s), so no list was ever read and a retired model stayed in the menus.
export const LIST_HANDSHAKE_MS = 60_000;
const MAX_LINE = 8 * 1024 * 1024;
const CANCEL_GRACE_MS = 1000;
// How long a run keeps reading after the agent has exited, so output that is still in the pipe is not lost (proc.mjs EXIT_GRACE_MS).
const EXIT_GRACE_MS = 300;
// The longest a finished run waits for its agent to exit after it was ended (see the end of runAcp). It was 2 seconds, which a kill on
// a busy PC passes: the run then returned with the agent still alive, and its scratch folder could not be removed. After a Stop the
// wait is the kill's own limit (KILL_LIMIT_MS), so Stop stays quick.
export const EXIT_WAIT_MS = 10_000;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const CLIENT_CAPABILITIES = Object.freeze({ fs: Object.freeze({ readTextFile: false, writeTextFile: false }) });

// The first sentence of a reply that ended without the agent's end marker.
export const CUT_OFF = 'The reply was cut off before it finished.';

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const textString = v => (typeof v === 'string' ? v : '');

// The fields of a tool call that an update carries when it has them: its raw input, the locations it touches and its content (diffs
// name their path there). Nothing is added for a field the update does not send.
const callFields = update => {
  const fields = {};
  if (update.rawInput !== undefined) fields.rawInput = update.rawInput;
  if (Array.isArray(update.locations)) fields.locations = update.locations;
  if (Array.isArray(update.content)) fields.content = update.content;
  return fields;
};

// The text of a content value: one block or a list of blocks, read as text parts only.
export function textOf(content) {
  const parts = Array.isArray(content) ? content : [content];
  return parts.map(p => (isObject(p) && p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('');
}

// The text of a tool call's content: its items are { type: 'content', content: block } or other kinds (a diff, say), of which only
// the text is kept.
export function toolText(content) {
  if (!Array.isArray(content)) return '';
  return content.map(item => {
    if (!isObject(item)) return '';
    if (item.type === 'content') return textOf(item.content);
    return textOf(item);
  }).join('');
}

// Runs one ACP turn and resolves with { stopReason }. Rejects with an Error when the handshake times out, the agent answers
// with an error, or it exits before it answers the prompt (the message carries the end of its stderr, which the caller may read
// for a sign-in failure). After reply text has arrived the last two reject with the cut-off error described at the top of this file.
// onText(piece) gets each agent message text; onTool({ id, title, kind, status, rawInput, locations, content }) gets a call when it
// starts and the same fields (those the update carries) plus text when it is updated; onPermission(toolCall) resolves true to allow
// the call, false to refuse it. The permission's toolCall may carry only its id, so the caller joins it with the earlier call (lib/cursor.mjs).
// handshakeMs is how long the agent may stay silent before the initialize and session/new replies have both come (60 seconds by default;
// see HANDSHAKE_MS). When it passes, the run rejects with an error of kind 'overloaded' (retryable: true): the program was slow to start,
// and sending again can work.
// onActivity (optional) is called on every piece of output the agent writes, so an idle clock sees an agent that is thinking or at work.
// afterSession (optional) runs inside the handshake once the session exists: ({ request, sessionId, created }) where request(method, params)
// sends a request and created is the session/new answer (lib/antigravity.mjs chooses the model there). An error it throws ends the run.
// sessionOnly ends the run after the handshake and resolves { stopReason: 'session', session: created } without sending a prompt, so
// nothing is asked of a model (lib/antigravity.mjs reads the account's model list that way).
export async function runAcp({ command, args = [], cwd, prompt, signal, onText, onTool, onPermission, label = command, handshakeMs = HANDSHAKE_MS, platform, source, spawner, mcpServers = [], onActivity, afterSession, sessionOnly = false }) {
  if (signal?.aborted) return { stopReason: 'cancelled' };
  const launch = await resolveLaunch(command, args, platform);
  if (!launch) throw new Error(`${label} is not on PATH.`);
  // A command line this version of the agent has already refused is said in words here, before the agent is started (lib/cli-fit.mjs).
  const misfit = await knownMisfit(command, args, { label });
  if (misfit) throw misfit;
  if (signal?.aborted) return { stopReason: 'cancelled' };
  // The start gate: a second process of the same signed-in CLI starts apart from the first. A Stop during the wait starts nothing.
  // Nothing is awaited between this check and the abort listener below, so a Stop cannot land in that gap unseen.
  const slot = await enterStartGate(command, { signal });
  if (!slot || signal?.aborted) {
    slot?.end();
    return { stopReason: 'cancelled' };
  }
  let child;
  try {
    child = startChild(command, launch, { cwd, stdio: ['pipe', 'pipe', 'pipe'], platform, source, spawner });
  } catch (err) {
    slot.end();
    throw err;
  }
  child.once('exit', () => slot.end());
  child.once('error', () => slot.end());
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  // The handshake clock (see HANDSHAKE_MS). armHandshake starts it, and starts it again on every sign of life until the session exists.
  const began = Date.now();
  let handshakeTimer = null;
  let failHandshake = null; // set while the handshake is waited for
  const armHandshake = () => {
    if (!failHandshake) return;
    clearTimeout(handshakeTimer);
    handshakeTimer = setTimeout(failHandshake, Math.max(0, Math.min(handshakeMs, began + handshakeMs * HANDSHAKE_CAP - Date.now())));
  };
  const active = () => {
    armHandshake();
    try {
      onActivity?.();
    } catch {
      // A broken listener must not stop the run.
    }
  };
  child.stderr.on('data', d => { active(); stderr = (stderr + d).slice(-4000); });
  const tail = () => stripAnsi(stderr).trim().slice(-1500);

  const pending = new Map(); // our request id -> { resolve, reject }
  let nextId = 1;
  let sessionId = null;
  let created = null;
  let aborted = false;
  let ending = false; // the run is over and Plenum is ending the agent (the finally block below)
  let cancelTimer = null;
  let exitTimer = null;
  let exited = null; // { code } once the agent has exited
  let shown = false; // reply text a person could see has arrived (a blank piece is nothing)
  let promptId = null; // our request id of session/prompt, once it is sent

  const send = msg => { try { child.stdin.write(`${JSON.stringify(msg)}\n`); } catch { /* the agent has gone; its exit ends the run */ } };
  // The kind of a failure (lib/cli-errors.mjs), put on an error whose words stay as they are.
  const withKind = (err, facts) => {
    const verdict = classifyCliFailure(label, facts);
    // A refused command line is remembered for this version of the agent, so the next run says so before it starts.
    if (verdict.kind === 'flags-rejected' && sessionId === null) rememberRefusal(command, { flag: verdict.flag, args }).catch(() => {});
    // Another process of this CLI was renewing its sign-in: the next starts of it wait for that renewal (the start gate).
    if (verdict.kind === 'sign-in-busy') noteSignInBusy(command);
    return Object.assign(err, { kind: verdict.kind, retryable: verdict.retryable, detail: verdict.detail });
  };
  // The reply was cut off. how is the sentence that says in what way the agent's turn ended; exit is the agent's exit code, when it exited.
  const cutOff = (how, facts, exit = null) => {
    const err = Object.assign(
      cliError(label, { ...facts, partial: true, cutWords: `${CUT_OFF} ${how}, so what it wrote is incomplete.` }),
      { code: exit },
    );
    if (err.kind === 'sign-in-busy') noteSignInBusy(command);
    return err;
  };
  // An agent's error output can be a long log, so it is read the careful way (transcript): a few lines as they are, of a long log only
  // what follows the agent's own last ERROR line.
  const exitedError = code => (shown && promptId !== null
    ? cutOff(`${label} closed before it ended its turn`, { code, stderr: tail(), transcript: true }, code)
    : withKind(new Error(`${label} stopped before it replied${code == null ? '' : ` (exit code ${code})`}${tail() ? `:\n${tail()}` : '.'}`), { code, stderr: tail(), transcript: true }));
  // The error of an exit that Plenum caused (a Stop, or the end of the run): plain words, and nothing is read for a cause.
  const endedError = code => (aborted || ending ? new Error(`${label} was stopped.`) : exitedError(code));
  const request = (method, params) => new Promise((resolve, reject) => {
    // A request sent after the agent has exited would wait for an exit that has already come, so it is refused here.
    if (exited) return reject(endedError(exited.code));
    const id = nextId++;
    if (method === 'session/prompt') promptId = id;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const rejectAll = err => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.reject(err);
    }
  };

  // session/update notifications. Anything else in them is ignored.
  const onUpdate = params => {
    const update = isObject(params) ? params.update : null;
    if (!isObject(update)) return;
    const id = textString(update.toolCallId);
    if (update.sessionUpdate === 'agent_message_chunk') {
      const piece = textOf(update.content);
      if (piece) {
        shown ||= /\S/.test(piece);
        onText?.(piece);
      }
    } else if (update.sessionUpdate === 'tool_call' && id) {
      onTool?.({ id, title: textString(update.title), kind: textString(update.kind), status: 'running', ...callFields(update) });
    } else if (update.sessionUpdate === 'tool_call_update' && id) {
      onTool?.({ id, status: textString(update.status), text: toolText(update.content), ...callFields(update) });
    }
  };

  // session/request_permission: the first option of the kind asked for, or a refusal. Only a refusal is sent when no option of
  // the wanted kind exists, and cancelled when there is no refusal option either.
  const answerPermission = async msg => {
    const params = isObject(msg.params) ? msg.params : {};
    const toolCall = isObject(params.toolCall) ? params.toolCall : isObject(params.tool_call) ? params.tool_call : {};
    const options = Array.isArray(params.options) ? params.options.filter(o => isObject(o) && typeof o.optionId === 'string') : [];
    let allowed = false;
    try {
      allowed = onPermission ? (await onPermission(toolCall)) === true : false;
    } catch {
      allowed = false;
    }
    const pick = prefix => options.find(o => textString(o.kind).startsWith(prefix));
    const chosen = (allowed ? pick('allow') : null) ?? pick('reject');
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { outcome: chosen ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' } },
    });
  };

  const handle = line => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON: skipped
    }
    if (!isObject(msg)) return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === 'string') {
      if (!hasId) {
        if (msg.method === 'session/update') {
          try {
            onUpdate(msg.params);
          } catch {
            // A shape that is not read is skipped.
          }
        }
        return;
      }
      if (msg.method === 'session/request_permission') {
        answerPermission(msg).catch(() => send({ jsonrpc: '2.0', id: msg.id, error: { code: INTERNAL_ERROR, message: 'Plenum could not answer this request.' } }));
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: METHOD_NOT_FOUND, message: `Plenum does not offer ${msg.method}.` } });
      }
      return;
    }
    if (!hasId || !pending.has(msg.id)) return;
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    if (isObject(msg.error)) {
      const said = textString(msg.error.message);
      // The agent is still running and reported a failure, so this is no crash: the table is given a plain failing exit code.
      waiter.reject(shown && msg.id === promptId
        ? cutOff(`${label} reported an error`, { code: 1, text: said })
        : withKind(new Error(`${label} stopped with an error: ${clip(said || 'unknown error', 400)}`), { code: 1, text: said }));
    } else {
      waiter.resolve(isObject(msg.result) ? msg.result : {});
    }
  };

  // A callback of the caller that throws must not end the process that reads this stream, so its error is contained here.
  const handleSafely = line => {
    try {
      handle(line);
    } catch {
      // The line is left as it is; the run goes on.
    }
  };

  // Output lines. A line over MAX_LINE is dropped, and so is the rest of it up to its end.
  let buf = '';
  let dropping = false;
  child.stdout.on('data', chunk => {
    active();
    let rest = chunk;
    for (;;) {
      const nl = rest.indexOf('\n');
      if (nl < 0) break;
      const head = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (dropping) {
        dropping = false;
        buf = '';
        continue;
      }
      const line = buf + head;
      buf = '';
      if (line.length <= MAX_LINE) handleSafely(line);
    }
    if (dropping) return;
    buf += rest;
    if (buf.length > MAX_LINE) {
      buf = '';
      dropping = true;
    }
  });
  child.stdout.on('end', () => {
    if (!dropping && buf.length && buf.length <= MAX_LINE) handleSafely(buf);
    buf = '';
  });

  // The agent's exit ends every request still waiting, after a short grace for output still in the pipe.
  // Once the run is over (ending) nothing waits any more, and the exit is the one Plenum asked for: it is not judged.
  child.once('exit', code => {
    exited = { code };
    if (ending) return;
    exitTimer = setTimeout(() => { if (!ending) rejectAll(endedError(code)); }, EXIT_GRACE_MS);
  });
  child.once('error', err => rejectAll(err));

  const onAbort = () => {
    aborted = true;
    if (!sessionId) {
      killTree(child);
      return;
    }
    send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    // The agent should answer the prompt with a cancelled stop reason. If it does not end soon, its process is ended.
    cancelTimer = setTimeout(() => killTree(child), CANCEL_GRACE_MS);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  // The failure of a handshake that took too long. It has a kind, so a team task or a council seat sends it again as it does any
  // passing failure, and the page offers "send again": the agent itself reported nothing, it was only slow to start.
  const slowStart = () => Object.assign(
    new Error(`${label} was slow to start: it did not start a session within ${Math.round((Date.now() - began) / 1000)} seconds, so the run was stopped. Send the message again: a second start is often faster. If it keeps happening, close other programs or pick another model.`),
    { kind: 'overloaded', retryable: true, detail: '' },
  );

  try {
    const handshake = (async () => {
      await request('initialize', { protocolVersion: ACP_VERSION, clientCapabilities: CLIENT_CAPABILITIES });
      created = await request('session/new', { cwd, mcpServers });
      if (!isObject(created) || typeof created.sessionId !== 'string' || !created.sessionId) {
        throw new Error(`${label} did not start a session.`);
      }
      sessionId = created.sessionId;
      if (afterSession && !sessionOnly) await afterSession({ request, sessionId, created });
    })();
    const tooSlow = new Promise((_, reject) => { failHandshake = () => reject(slowStart()); });
    armHandshake();
    try {
      await Promise.race([handshake, tooSlow]);
    } finally {
      failHandshake = null;
      clearTimeout(handshakeTimer);
    }
    if (aborted) return { stopReason: 'cancelled' };
    if (sessionOnly) return { stopReason: 'session', session: created };
    const reply = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
    return { stopReason: textString(reply.stopReason) || 'end_turn' };
  } catch (err) {
    if (aborted) return { stopReason: 'cancelled' };
    throw err;
  } finally {
    ending = true;
    failHandshake = null;
    clearTimeout(handshakeTimer);
    clearTimeout(cancelTimer);
    clearTimeout(exitTimer);
    signal?.removeEventListener('abort', onAbort);
    slot.end();
    child.stdout.destroy();
    child.stderr.destroy();
    // The agent's input is closed before the kill: an agent ends by itself when its input ends, so it also ends when taskkill cannot
    // end it (it used to wait on its open input for ever).
    try {
      child.stdin.destroy();
    } catch {
      // It was closed already.
    }
    // The run returns only once the agent has gone, so its working folder (a read-only run's scratch folder) can be removed: the kill
    // has reported (or passed its limit) and the agent has exited, or the wait has passed.
    const wait = aborted ? KILL_LIMIT_MS : EXIT_WAIT_MS;
    await Promise.all([killTree(child), exitWithin(child, wait)]);
  }
}

// Removes the scratch folder of a run (a read-only run's empty folder, a model-list read's folder). Windows refuses while a program
// still has it as its working folder, so a refused removal is tried again for a second; the run has already ended the agent (the end
// of runAcp waits for it). A folder that is still held then (a helper of the agent that ends late) is tried again in the background,
// every two seconds for half a minute: it used to be left in the temp folder for good, and nothing else removes it. Resolves true
// when the folder is gone now, false when the removal goes on in the background. Never throws.
const REMOVE_TRIES = 5;
const REMOVE_GAP_MS = 200;
const REMOVE_LATER_TRIES = 15;
const REMOVE_LATER_MS = 2000;
export async function removeRunFolder(dir) {
  for (let attempt = 0; attempt < REMOVE_TRIES; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, REMOVE_GAP_MS));
    }
  }
  let left = REMOVE_LATER_TRIES;
  const again = () => {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {
      left -= 1;
      if (left > 0) setTimeout(again, REMOVE_LATER_MS).unref?.();
    });
  };
  setTimeout(again, REMOVE_LATER_MS).unref?.();
  return false;
}

// Resolves when the child has exited, or after ms, whichever comes first.
function exitWithin(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
