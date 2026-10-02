import assert from "node:assert/strict";
import { test } from "node:test";
import { SIM_COMMANDS, SIM_HELP, SIM_ROUTES } from "../lib/cli/sim.mjs";
import { writeReport } from "../lib/sim-store.mjs";
import { fakeBench, tmpPaths } from "./sim-fakes.mjs";

const ctx = (opt = {}) => {
  const paths = tmpPaths();
  /** @type {any} */
  const c = { bench: fakeBench(paths), paths, opt };
  return c;
};

test("every command that starts games needs --yes and says what it will do", async () => {
  await assert.rejects(async () => SIM_COMMANDS.sim(ctx(), ["diff", "m"], "sim"), /two seeded test games.*--yes/);
  await assert.rejects(async () => SIM_COMMANDS.sim(ctx(), ["diff"], "sim"), /which mod/);
  await assert.rejects(async () => SIM_COMMANDS.sim(ctx(), ["repeat"], "sim"), /twice.*--yes/);
  await assert.rejects(async () => SIM_COMMANDS.fuzz(ctx(), [], "fuzz"), /random verified actions.*--yes/);
  await assert.rejects(async () => SIM_COMMANDS.arena(ctx(), ["m"], "arena"), /off, then on.*--yes/);
  await assert.rejects(async () => SIM_COMMANDS.sim(ctx({ yes: true, turns: "0" }), ["repeat"], "sim"), /--turns must be/);
  await assert.rejects(async () => SIM_COMMANDS.sim(ctx(), ["nope"], "sim"), /sim diff <mod-id>/);
});

test("saved reports are listed and shown; the help lines follow the bench's format", async () => {
  const c = ctx({ json: true });
  writeReport(c.paths, "sim-repeat", { verdict: "DETERMINISTIC", detail: "x", curve: [] });
  const lines = [];
  const log = console.log;
  console.log = (s) => lines.push(s);
  try {
    await SIM_COMMANDS.sim(c, ["runs"], "sim");
    await SIM_COMMANDS.sim(c, ["controls"], "sim");
  } finally {
    console.log = log;
  }
  assert.equal(JSON.parse(lines[0])[0].verdict, "DETERMINISTIC");
  assert.deepEqual(JSON.parse(lines[1]), []);
  await assert.rejects(async () => SIM_COMMANDS.sim(c, ["show", "../x.json"], "sim"), /no such report/);
  for (const l of SIM_HELP.split("\n")) assert.ok(/^ {2}\S/.test(l) || /^ {39}\S/.test(l), `help line: "${l}"`);
});

test("the server lists reports and starts runs only when armed", async () => {
  const c = ctx();
  writeReport(c.paths, "arena", { mod: "m", games: [] });
  const q = new URLSearchParams();
  const list = await SIM_ROUTES["GET /api/sim/runs"](c.bench, null, q);
  assert.equal(list[0].kind, "arena");
  const body = (b) => async () => b;
  await assert.rejects(async () => SIM_ROUTES["POST /api/sim/start"](c.bench, null, q, body({ kind: "repeat" })), /arm writes/);
  c.bench.armed = true;
  await assert.rejects(async () => SIM_ROUTES["POST /api/sim/start"](c.bench, null, q, body({ kind: "other" })), /kind must be/);
  await assert.rejects(async () => SIM_ROUTES["POST /api/sim/start"](c.bench, null, q, body({ kind: "diff" })), /which mod/);
  assert.equal(SIM_ROUTES["GET /api/sim/job"](), null);
});
