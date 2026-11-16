import { sleepAbortable } from './api-retry.mjs';

// What a council does about a failure that passes by itself (DECISIONS item 158, 15 Nov 2026), and about the moment it starts.
// The owner runs councils while he is away from the PC, and a seat that fails for a busy service, a dropped connection or a program
// that died before it answered can be sent again with a good chance of answering. Only a person could press Retry; nobody is there.
// A council run makes one of these (createAgain) and asks it two things:
//   failed(turn, kind, { label, ref })   after a turn failed with nothing written: 'again' when the same turn should be sent once more
//                                        (the card has been told and the wait is over), 'no' when the failure stands. The kinds are the
//                                        CLI failure kinds of lib/cli-errors.mjs and nothing else is read: never a reply, never a sentence.
//   apart(index)                         the seat that starts index-th among the seats of one program waits index * stagger, so two
//                                        processes of one program do not start in the same instant (two renew a sign-in with the same
//                                        one-use token, and one of them fails: Claude Code's "another process is refreshing it")
// Which kinds, and how often (AGAIN_WAITS: the wait before each new try):
//   overloaded 10 s, network 5 s, crashed 2 s, bad-output 2 s: once.  sign-in-busy: 20 s, then once more after 60 s, and only when
//   the second try failed with sign-in-busy again.
// Never here: quota, model-unavailable, flags-rejected and unknown (sending again changes nothing), not-signed-in and sign-in-refused
// (the sign-in gate, lib/signin-check.mjs, owns those), an idle time-out, a turn the person stopped, and a turn that wrote text or
// changed a file (the caller checks that before it asks). A model that runs with an API key is never sent again by this: its request
// already has its own tries (lib/api-retry.mjs, four requests; the Anthropic SDK's own three), so a second round of them here would
// only turn four tries into eight. `route(ref)` says whether a model runs on its program's own sign-in route (signedInProgram in
// lib/signin-check.mjs); a model that does not is neither sent again nor held back at the start.
// A turn may have one passing resend (two for sign-in-busy), and a second one only when every failure before it was of the same kind:
// a turn that failed busy, then failed for a dropped connection, fails with that last failure. Together with the sign-in gate's own
// resends no turn is tried more than MAX_TRIES times (the caller's loop stops there).

export const AGAIN_WAITS = Object.freeze({
  overloaded: Object.freeze([10_000]),
  network: Object.freeze([5_000]),
  crashed: Object.freeze([2_000]),
  'bad-output': Object.freeze([2_000]),
  'sign-in-busy': Object.freeze([20_000, 60_000]),
  // How far apart the turns of one program start in the first round.
  stagger: 2_000,
});

// Tries of one turn in all, the first included, whoever sends it again (this, or the sign-in gate).
export const MAX_TRIES = 5;

// "10 seconds", "1 minute".
function wordsFor(ms) {
  if (ms >= 60_000) {
    const m = Math.round(ms / 60_000);
    return m === 1 ? '1 minute' : `${m} minutes`;
  }
  const s = Math.max(1, Math.round(ms / 1000));
  return s === 1 ? '1 second' : `${s} seconds`;
}

// The sentence for the card, said when the resend is decided (so it is there during the wait). `step` is 0 for the first resend of a
// kind, 1 for the second. `program` is the program's name as Plenum shows it, `label` the seat's label or "the moderator".
export function againNote(kind, { label, program }, step, waitMs) {
  const turn = `the turn of ${label}`;
  const wait = wordsFor(waitMs);
  switch (kind) {
    case 'overloaded': return `The service was busy for ${turn}. Plenum sends the turn again in ${wait}.`;
    case 'network': return `The connection failed for ${turn}. Plenum sends the turn again in ${wait}.`;
    case 'crashed': return `The program stopped before it answered ${turn}. Plenum sends the turn again.`;
    case 'bad-output': return `The program's answer for ${turn} could not be read. Plenum sends the turn again.`;
    case 'sign-in-busy': return step === 0
      ? `${program} could not renew its sign-in for ${turn}, because another ${program} process was renewing it at the same moment. Plenum sends the turn again in ${wait}.`
      : `${program} still could not renew its sign-in for ${turn}. Plenum sends the turn once more in ${wait}.`;
    default: return '';
  }
}

// One council run's again. `signal` is the run's (Stop ends every wait at once), `say` takes one plain sentence for the card, `waits`
// replaces values of AGAIN_WAITS and `pause(ms, signal)` the timer (true when the time passed, false when the signal ended it), both for
// tests; `route(ref)` is described above, and without it nothing is sent again and nothing is held back.
export function createAgain({ signal = null, say = () => {}, waits = {}, pause = sleepAbortable, route = async () => null } = {}) {
  const table = { ...AGAIN_WAITS, ...waits };
  const sent = new Map(); // turn -> the kinds it was sent again for
  const tell = text => {
    try {
      say(text);
    } catch {
      // A card that cannot take the sentence must not stop the run.
    }
  };
  const named = async ref => {
    try {
      return (await route(ref)) ?? null;
    } catch {
      return null;
    }
  };
  // Waits ms: true when the time passed, false when the run was stopped.
  const wait = async ms => {
    if (signal?.aborted) return false;
    if (!(ms > 0)) return true;
    return Boolean(await pause(ms, signal)) && !signal?.aborted;
  };
  return {
    async failed(turn, kind, { label = 'a seat', ref = '', program = '' } = {}) {
      const steps = Object.hasOwn(table, kind) && Array.isArray(table[kind]) ? table[kind] : null;
      if (!steps?.length || signal?.aborted) return 'no';
      const before = sent.get(turn) ?? [];
      if (before.length >= steps.length || before.some(k => k !== kind)) return 'no';
      const on = await named(ref);
      if (!on || signal?.aborted) return 'no';
      const ms = steps[before.length];
      sent.set(turn, [...before, kind]);
      tell(againNote(kind, { label, program: program || on.name }, before.length, ms));
      return (await wait(ms)) ? 'again' : 'no';
    },

    // For the turns of the first round, in seat order: for each ref the place among the turns of the same program on its signed-in
    // route (0 for the first, which starts at once; 0 for any other model).
    async slots(refs) {
      const seen = new Map();
      const out = [];
      for (const ref of refs) {
        const on = await named(ref);
        const n = on ? seen.get(on.key) ?? 0 : 0;
        if (on) seen.set(on.key, n + 1);
        out.push(n);
      }
      return out;
    },

    // True when the wait for the index-th turn of a program is over, false when the run was stopped meanwhile.
    apart(index) {
      return wait(index * (Number(table.stagger) || 0));
    },
  };
}
