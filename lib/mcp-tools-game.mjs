// MCP tools that read the running game through its UI debugger. None of them changes the game, except that
// events_wait subscribes the page to one event for the length of the wait, as the CLI does.
import { eventCatalogue, describeEvent } from "./events.mjs";
import { Lab, gamePid } from "./lab.mjs";
import { techniquesForCode } from "./techniques.mjs";
import { actionList } from "./cli/cheats.mjs";
import { S, VERDICTS, plotArg } from "./mcp-common.mjs";

/** @typedef {import("./mcp-common.mjs").ToolDef} ToolDef */

function statusText(s, port) {
  if (!("snapshot" in s)) return `offline: ${s.reason}. Is the game running with the UI debugger on port ${port}?`;
  const g = s.snapshot;
  const game = g ? `; turn ${g.turn}, ${g.age}, map ${g.map?.width}x${g.map?.height}, local player ${g.localPlayer}` : "";
  return `connected: ${s.scope} page, game ${s.version ?? "version unknown"}${game}; undoable changes today: ${s.undo}`;
}

/** Waits for the next `name` event whose fields equal `equals` (dotted paths into the event). */
async function waitEvent(bench, { name, equals = {}, timeoutMs }) {
  const get = (e, p) => p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), e);
  const hit = (e) => Object.entries(equals).every(([p, v]) => get(e, p) === v);
  await bench.events.set([name]);
  await bench.events.poll();
  const end = Date.now() + timeoutMs;
  let from = bench.events.history.length;
  try {
    while (Date.now() < end) {
      const w = await bench.events.waitFor({ event: name, timeoutMs: end - Date.now(), from });
      if (!w.ok) return null;
      if (hit(w.event)) return w.event;
      from = w.index + 1;
    }
    return null;
  } finally {
    await bench.events.set([]).catch(() => {});
  }
}

/** @type {ToolDef[]} */
export const GAME_TOOLS = [
  {
    name: "status", title: "Game connection", gate: "read",
    description: "Whether the game is reachable through its UI debugger, which page it is on (shell = main menu, game "
      + "= a loaded game), the turn, age, map size, players and how many of today's changes can be undone. Call first.",
    run: async ({ bench, paths }) => {
      const s = await bench.status();
      return { text: statusText(s, paths.cdpPort), data: s };
    },
  },
  {
    name: "plot", title: "Read a plot", gate: "read",
    description: "What is on one plot of the loaded game: terrain, feature, resource, owner, units, settlement.",
    input: { x: S.x, y: S.y, at: S.at },
    run: async ({ bench }, args) => {
      const at = await plotArg(bench, args);
      const p = await bench.plot(at.x, at.y);
      return { text: `plot (${at.x}, ${at.y})`, data: p };
    },
  },
  {
    name: "eval", title: "Run JavaScript in the game", gate: "eval",
    description: "Runs JavaScript in the game's UI page and returns the value (objects list their methods to `depth`). "
      + "It can change anything, and nothing it changes is verified or undoable: prefer write and do_action for "
      + "changes. A value printed here is what the page returned, not proof that the game state changed.",
    input: { code: { type: "string", description: "an expression or statements; the last value is returned" },
      depth: { type: "integer", minimum: 0, maximum: 6, description: "object depth to describe (default 3)" } },
    required: ["code"],
    run: async ({ bench }, { code, depth = 3 }) => {
      const value = await bench.eval(code, { depth });
      const techniques = techniquesForCode(code).map((t) => t.id);
      return { text: `evaluated in the ${bench.cdp.scope} page${techniques.length ? `; related techniques: ${techniques.join(", ")}` : ""}`,
        data: value };
    },
  },
  {
    name: "sql", title: "Query the live gameplay database", gate: "read",
    description: "One read-only SELECT (or WITH ... SELECT) against the gameplay database the loaded game compiled: "
      + "what the engine actually loaded, as opposed to what a mod's XML says.",
    input: { query: { type: "string", description: "a single SELECT statement" }, limit: S.limit(500, 5000) },
    required: ["query"],
    run: async ({ bench }, { query, limit = 500 }) => {
      const r = await bench.sql(query, { limit });
      return { text: `${r.total} row(s)${r.truncated ? `, showing ${r.rows.length}` : ""}`, data: r.rows };
    },
  },
  {
    name: "snapshot", title: "Save a map snapshot", gate: "read",
    description: "Saves the whole map (plots, units, settlements, players) to the bench's own snapshot store, to diff "
      + "against later. Changes nothing in the game.",
    input: { label: { type: "string", description: "a name; default turnN-<id>" } },
    run: async ({ bench }, { label }) => {
      const r = await bench.snapshot(label);
      return { text: `saved snapshot ${r.label} at turn ${r.turn}`, data: r };
    },
  },
  {
    name: "snapshots_list", title: "List map snapshots", gate: "read",
    description: "The saved map snapshots, for diff.",
    run: ({ bench }) => {
      const list = bench.snapshots.list();
      return { text: `${list.length} snapshot(s)`, data: list };
    },
  },
  {
    name: "diff", title: "Diff map snapshots", gate: "read",
    description: "What changed between two snapshots, or between a snapshot and the live game (b = \"now\").",
    input: { a: { type: "string", description: "snapshot label" }, b: { type: "string", description: 'snapshot label or "now" (default)' } },
    required: ["a"],
    run: async ({ bench }, { a, b = "now" }) => {
      const d = await bench.diff(a, b);
      return { text: d.text, data: d.diff };
    },
  },
  {
    name: "events_list", title: "List gameplay events", gate: "read",
    description: "The engine's declared gameplay events, optionally filtered by a substring. UI events work too.",
    input: { filter: { type: "string" } },
    run: ({ paths }, { filter = "" }) => {
      const all = eventCatalogue(paths);
      const list = all.filter((n) => n.toLowerCase().includes(filter.toLowerCase()));
      return { text: `${list.length} of ${all.length} gameplay events`, data: list };
    },
  },
  {
    name: "events_wait", title: "Wait for a game event", gate: "read",
    description: "Blocks until the next `name` event fires in the game (events recorded before the call do not count), "
      + "or the timeout passes. `equals` narrows it: dotted paths into the event, e.g. {\"data.player\": 0}. "
      + "Use it to confirm that something you did made the game react, rather than assuming it did.",
    input: { name: { type: "string" }, equals: { type: "object", description: "path -> value; all must be equal" },
      timeout_s: { type: "integer", minimum: 1, maximum: 600, description: "default 60" } },
    required: ["name"],
    run: async ({ bench }, { name, equals, timeout_s: t = 60 }) => {
      const e = await waitEvent(bench, { name, equals, timeoutMs: t * 1000 });
      return e ? { text: describeEvent(e), data: e }
        : { text: `no ${name}${equals ? ` matching ${JSON.stringify(equals)}` : ""} within ${t} s`, data: { ok: false } };
    },
  },
  {
    name: "registry", title: "What won in the running game", gate: "read",
    description: "Replaced legacy components, ui-next overrides above base priority, and the mods this game applied "
      + "against the ones the next launch will load.",
    run: async ({ bench }) => {
      const r = await bench.registry();
      return { text: `${r.controls.length} replaced component(s), ${r.components.length} ui-next override(s)`, data: r };
    },
  },
  {
    name: "lint", title: "Lint the live UI", gate: "read",
    description: "Checks the live UI for known GameFace failures (unsupported CSS, text drawn as boxes). Each issue names "
      + "the techniques that fix it.",
    input: { scope: { type: "string", description: "a CSS selector to limit the walk" } },
    run: async ({ bench }, { scope }) => {
      const r = await bench.lint(scope);
      if (r?.error) return { text: `lint failed: ${r.error}`, isError: true };
      return { text: `${r.issues.length} issue(s) in ${r.visited} element(s)`, data: r };
    },
  },
  {
    name: "deploy_prove", title: "Is the edit live?", gate: "read",
    description: "Copies nothing: compares the bytes the game serves for each of the mod's UI files with the source "
      + "folder. SERVED = the game runs your current source; STALE = it does not.",
    input: { folder: S.folder }, required: ["folder"],
    run: async ({ bench }, { folder }) => {
      const r = await bench.prove(folder);
      const stale = r.files.filter((f) => f.live !== "SERVED").length;
      return { text: stale ? `${stale} of ${r.files.length} UI file(s) are not what the game serves`
        : `all ${r.files.length} UI file(s) are what the game serves`, data: r };
    },
  },
  {
    name: "lab_status", title: "Lab run status", gate: "read",
    description: "The current lab test run, if any, and whether the game is running.",
    run: ({ paths }) => {
      const lab = new Lab(paths);
      const cur = lab.current;
      lab.cdp.close();
      const pid = gamePid();
      const own = cur?.pid && cur.pid === pid;
      return { text: `${cur ? `test run ${cur.dir}, started ${cur.startedAt}` : "no test run in progress"}; game `
        + `${pid ? `running (pid ${pid})${own ? ", started by this lab" : ""}` : "not running"}`, data: { run: cur, pid } };
    },
  },
  {
    name: "do_list", title: "Game-state actions", gate: "read",
    description: `The actions do_action can take (yields, units, cities, research, map) and how each is undone. ${VERDICTS}`,
    run: () => ({ text: actionList().map((a) => `${a.usage}  (undo: ${a.undo})`).join("\n"), data: actionList() }),
  },
];
