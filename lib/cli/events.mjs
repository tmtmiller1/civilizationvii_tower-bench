import fs from "node:fs";
import path from "node:path";
import { BenchError } from "../bench.mjs";
import { AGENT_ID, agentStatus, describeEvent, eventCatalogue, writeAgent } from "../events.mjs";
import { num, out, stampNow } from "./common.mjs";

/** @typedef {import("./common.mjs").Ctx} Ctx */

function eventsList(catalogue, names) {
  const f = names.join(" ").toLowerCase();
  const list = f ? catalogue.filter((n) => n.toLowerCase().includes(f)) : catalogue;
  if (list.length) out(list.join("\n"));
  return out(`${list.length} of ${catalogue.length} gameplay events; UI events such as UnitSelectionChanged work too`);
}

function noteUndeclared(catalogue, names) {
  for (const n of names) {
    if (catalogue.length && !catalogue.includes(n)) {
      out(`note: ${n} is not a declared gameplay event; if it is a UI event it still works, otherwise nothing will arrive`);
    }
  }
}

/** @param {Ctx} ctx */
function unsubscriber({ bench }) {
  return async () => {
    try { await bench.events.set([]); } catch { /* game gone */ }
  };
}

/** @param {Ctx} ctx @param {string[]} names */
async function eventsWatch(ctx, names) {
  const { bench, opt } = ctx;
  await bench.events.set(names, { log: !!opt.log });
  // The page buffer is shared with the agent and holds everything since the page loaded: take it in
  // silently, then show only the requested events from now on (--backlog shows the history too).
  await bench.events.poll();
  if (opt.backlog) for (const e of bench.events.history) if (names.includes(e.name)) out(describeEvent(e));
  bench.events.on("event", (e) => { if (names.includes(e.name)) out(describeEvent(e)); });
  bench.events.on("gap", (g) => out(`--- ${g.note} ---`));
  bench.events.on("dropped", (d) => out(`--- ${d.count} event(s) fell out of the page buffer before they were read ---`));
  out(`listening for ${names.join(", ")}${opt.log ? ", also writing UI.log" : ""}. Ctrl-C stops and unsubscribes.`);
  const unsubscribe = unsubscriber(ctx);
  const stop = async () => { await unsubscribe(); bench.close(); process.exit(0); };
  process.on("SIGINT", stop);
  if (opt.for) setTimeout(stop, Number(opt.for) * 1000);
  return new Promise(() => {});
}

/** @param {Ctx} ctx @param {string} name */
async function eventsWait(ctx, name) {
  const { bench, opt } = ctx;
  const timeoutS = num(opt.timeout) ?? 60;
  await bench.events.set([name]);
  await bench.events.poll();
  // "wait" means the next one: anything the page recorded before now does not count.
  const from = bench.events.history.length;
  const w = await bench.events.waitFor({ event: name, match: opt.match, timeoutMs: timeoutS * 1000, from });
  await unsubscriber(ctx)();
  process.exitCode = w.ok ? 0 : 1;
  return out(w.ok ? describeEvent(w.event) : `no ${name}${opt.match ? ` matching ${opt.match}` : ""} within ${timeoutS} s`);
}

/** @param {Ctx} ctx @param {string[]} args */
function eventsCommand(ctx, args) {
  const [sub, ...names] = args;
  const catalogue = eventCatalogue(ctx.paths);
  if (sub === "list") return eventsList(catalogue, names);
  if (sub !== "watch" && sub !== "wait") throw new BenchError("events list | watch <name...> | wait <name>");
  if (!names.length) throw new BenchError(`events ${sub} needs at least one event name (see "events list")`);
  noteUndeclared(catalogue, names);
  return sub === "watch" ? eventsWatch(ctx, names) : eventsWait(ctx, names[0]);
}

const AGENT_SUBS = {
  status: (_ctx, _names, st) => {
    if (!st.installed) return out(`not installed (would live at ${st.dir})`);
    const subs = st.subscriptions?.length ? `records from page load: ${st.subscriptions.join(", ")}` : "inert: its event list is empty";
    return out(`installed at ${st.dir}\n${subs}`);
  },
  install: ({ paths, opt }, names) => {
    if (!opt.yes) {
      throw new BenchError(`installs ${AGENT_ID} into Mods/, where it loads into every game (inert until given events); add --yes`);
    }
    const dir = writeAgent(paths, names);
    const what = names.length ? `; it will record ${names.join(", ")} from page load` : "; it stays inert until \"agent set\"";
    return out(`wrote ${dir}. The game registers it at its next launch${what}.`);
  },
  set: (ctx, names, st) => agentSet(ctx, names, st, false),
  off: (ctx, names, st) => agentSet(ctx, names, st, true),
  remove: ({ paths, opt }, _names, st) => {
    if (!st.installed) return out("not installed");
    if (!opt.yes) throw new BenchError("add --yes to move the agent out of Mods/");
    const to = path.join(path.dirname(paths.evidence), "removed", `${AGENT_ID}-${stampNow()}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(st.dir, to);
    return out(`moved to ${to} (not deleted). The game drops it at its next launch.`);
  },
};

/** @param {Ctx} ctx @param {string[]} names */
function agentSet({ paths }, names, st, off) {
  if (!st.installed) throw new BenchError("the agent is not installed; agent install --yes first");
  writeAgent(paths, off ? [] : names);
  return out(off
    ? "agent is inert from the next page load"
    : `agent records ${names.join(", ")} from the next page load (a reload, an age transition or a new game)`);
}

/** @param {Ctx} ctx @param {string[]} args */
function agentCommand(ctx, args) {
  const [sub = "status", ...names] = args;
  const st = agentStatus(ctx.paths);
  if (!Object.hasOwn(AGENT_SUBS, sub)) {
    throw new BenchError("agent status | install --yes [events...] | set <events...> | off | remove --yes");
  }
  return AGENT_SUBS[sub](ctx, names, st);
}

/** @type {Record<string, import("./common.mjs").Handler>} */
export const EVENT_COMMANDS = {
  events: eventsCommand,
  agent: agentCommand,
};
