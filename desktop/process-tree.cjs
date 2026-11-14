'use strict';
// Which processes a quit ends (Windows). A quit ends the server and everything it started (an agent's run, a command), and until now it did
// that with `taskkill /t`, which also ended a hub launcher that was still starting the hub (DECISIONS item 118, Open items). The shell now
// asks the table of processes, works out the server's descendants without the launcher's own (and what the launcher started), and
// ends those. No Electron and no child process here: the table is passed in, so a test needs no real process.

// The text of `Get-CimInstance Win32_Process` printed as "pid parentPid" per line, as a Map from a parent's pid to its children's pids.
function parseTable(text) {
  const children = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const parent = Number(m[2]);
    if (pid === parent) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  return children;
}

// pid and everything under it, from the table (a pid is listed once even when the table loops).
function below(children, pid) {
  const seen = new Set([pid]);
  const queue = [pid];
  while (queue.length) {
    for (const next of children.get(queue.shift()) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

// The pids to end for a quit: the server and all it started, except the launchers (the pids in `spared`) and what they started. Resolves
// null when the table says nothing about the server (an empty or unreadable table): the caller then ends the whole tree as before, because
// a quit that leaves an agent's run behind is worse than one that ends a launcher.
function doomedWithout(children, serverPid, spared) {
  if (!(children instanceof Map) || !children.has(serverPid)) {
    // A server with no children is a table that lists none of its processes only when the table is empty.
    if (!(children instanceof Map) || children.size === 0) return null;
  }
  const keep = new Set();
  for (const pid of spared ?? []) for (const p of below(children, pid)) keep.add(p);
  keep.delete(serverPid);
  return [...below(children, serverPid)].filter(p => !keep.has(p)).sort((a, b) => b - a);
}

module.exports = { parseTable, below, doomedWithout };
