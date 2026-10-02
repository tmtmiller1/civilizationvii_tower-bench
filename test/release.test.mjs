import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { releaseCheck } from "../lib/release.mjs";
import { compareVersions, escapes, openPackage } from "../lib/release-package.mjs";
import { parseVdf } from "../lib/release-steam.mjs";
import { cleanMod, modinfo, modsDb, textFile, tmp, writeTree, zipFolder } from "./fixtures/release/make.mjs";

const clean = { verdict: "CLEAN", gameVersion: "9.9.9", defects: [], conflicts: [] };
const bench = (extra = {}) => ({ paths: { modsDb: path.join(tmp(), "none.sqlite"), userMods: "/nowhere/Mods", ...extra } });
const run = (opts, b = bench()) => releaseCheck(b, { analyse: () => clean, ...opts });
const byCheck = (r, check) => r.checks.filter((c) => c.check === check);
const one = (r, check) => {
  const hits = byCheck(r, check);
  assert.equal(hits.length, 1, `${check}: ${JSON.stringify(r.checks.map((c) => c.check))}`);
  return hits[0];
};

test("a clean mod folder passes the package checks and warns that nothing was compared", async () => {
  const dir = cleanMod(path.join(tmp(), "fixture"));
  const r = await run({ dir });
  for (const c of ["declared-files", "dev-junk", "nested-copy", "outside-files", "preflight", "name", "description", "affects-saved-games"]) {
    assert.equal(one(r, c).status, "PASS", c);
  }
  assert.equal(one(r, "version").status, "WARN");
  assert.equal(r.verdict, "WARN");
  assert.equal(one(r, "size").status, "INFO");
  assert.deepEqual(byCheck(r, "probe-files"), []);
  assert.deepEqual(byCheck(r, "dev-flags"), []);
});

test("the version must rise above --against, which must be the same mod", async () => {
  const root = tmp();
  const dir = cleanMod(path.join(root, "new"), { version: "1.2.0" });
  const same = cleanMod(path.join(root, "same"), { version: "1.2.0" });
  const old = cleanMod(path.join(root, "old"), { version: "1.1.9" });
  const newer = cleanMod(path.join(root, "newer"), { version: "1.10.0" });
  assert.equal(one(await run({ dir, against: old }), "version").status, "PASS");
  assert.equal(one(await run({ dir, against: same }), "version").status, "FAIL");
  assert.equal(one(await run({ dir, against: newer }), "version").status, "FAIL");
  const other = cleanMod(path.join(root, "other"), { id: "another-mod" });
  await assert.rejects(run({ dir, against: other }), /holds another-mod, not fixture-mod/);
});

test("without --against the Workshop copy registered in Mods.sqlite is the release to beat", async () => {
  const root = tmp();
  const dir = cleanMod(path.join(root, "dev"), { version: "2.0.0" });
  const ws = cleanMod(path.join(root, "steamapps", "workshop", "content", "1295660", "42"), { version: "2.0.0" });
  const db = modsDb(path.join(root, "Mods.sqlite"), [{ id: "fixture-mod", path: path.join(ws, "fixture.modinfo") },
    { id: "fixture-mod", path: path.join(dir, "fixture.modinfo") }]);
  const r = await run({ dir }, bench({ modsDb: db }));
  const v = one(r, "version");
  assert.equal(v.status, "FAIL");
  assert.match(v.text, /Workshop 42/);
});

test("a changelog needs an entry for the version, as a heading", async () => {
  const dir = cleanMod(path.join(tmp(), "m"), { version: "1.3.1" });
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## 1.3.0\n- older\n");
  assert.equal(one(await run({ dir }), "changelog").status, "FAIL");
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\nSee 1.3.1 notes.\n## 1.3.10\n");
  assert.equal(one(await run({ dir }), "changelog").status, "WARN", "1.3.10 is not 1.3.1, and prose is not a heading");
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## [1.3.1] - 2026-01-01\n");
  assert.equal(one(await run({ dir }), "changelog").status, "PASS");
});

test("dev leftovers, a nested copy of the mod and a missing listed file fail the package", async () => {
  const dir = cleanMod(path.join(tmp(), "m"), { imports: ["ui/missing.js"] });
  writeTree(dir, {
    ".DS_Store": "x", "ui/main.js.map": "{}", "notes.bak": "x",
    "dist/fixture/fixture.modinfo": modinfo(), ".env": "TOKEN=x",
  });
  const r = await run({ dir });
  assert.equal(one(r, "nested-copy").status, "FAIL");
  const junk = one(r, "dev-junk");
  assert.equal(junk.status, "FAIL", ".env can hold secrets");
  assert.ok(junk.evidence["Finder and Explorer files"].includes(".DS_Store"));
  assert.ok(junk.evidence["backup and editor files"].includes("notes.bak"));
  assert.equal(one(r, "declared-files").status, "FAIL");
  assert.equal(r.verdict, "FAIL");
});

test("a second mod inside the package warns; a symlink out of the folder fails", async () => {
  const root = tmp();
  const dir = cleanMod(path.join(root, "m"));
  writeTree(dir, { "extra/other.modinfo": modinfo({ id: "other-mod" }) });
  fs.writeFileSync(path.join(root, "secret.txt"), "x");
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(dir, "link.txt"));
  const r = await run({ dir });
  assert.equal(one(r, "nested-copy").status, "WARN");
  assert.equal(one(r, "outside-files").status, "FAIL");
});

test("probes that load, debug switches and dense logging are flagged", async () => {
  const noisy = Array.from({ length: 30 }, (_, i) => `console.log("step ${i}");`).join("\n");
  const dir = cleanMod(path.join(tmp(), "m"), { scripts: ["ui/main.js", "ui/fixture-probe.js"] });
  writeTree(dir, { "ui/fixture-probe.js": `const DEBUG = true;\n${noisy}\n`, "ui/repro-old.js": "1;" });
  const r = await run({ dir });
  const p = one(r, "probe-files");
  assert.deepEqual(p.evidence.loaded, ["ui/fixture-probe.js"]);
  assert.ok(p.evidence.files.includes("ui/repro-old.js"));
  const f = one(r, "dev-flags");
  assert.equal(f.evidence.consoleCalls, 30);
  assert.match(f.text, /debug switch on/);
  assert.equal(one(r, "unused-files").status, "INFO");
});

test("name and description resolve from the modinfo, warn from a game text file, fail when undefined", async () => {
  const root = tmp();
  const ok = await run({ dir: cleanMod(path.join(root, "a")) });
  assert.equal(one(ok, "name").status, "PASS");
  const fileOnly = cleanMod(path.join(root, "b"), { loc: {} });
  writeTree(fileOnly, { "text/en_us/Text.xml": textFile([["LOC_FIXTURE_NAME", "Fixture"], ["LOC_FIXTURE_HELLO", "Hi"]]) });
  const r = await run({ dir: fileOnly });
  assert.equal(one(r, "name").status, "WARN");
  assert.equal(one(r, "description").status, "FAIL");
  const viaFile = cleanMod(path.join(root, "c"), { loc: {}, locFile: "text/ModInfo.xml" });
  writeTree(viaFile, { "text/ModInfo.xml": textFile([["LOC_FIXTURE_NAME", "Fixture"], ["LOC_FIXTURE_DESC", "D"]]) });
  const c = await run({ dir: viaFile });
  assert.equal(one(c, "name").status, "PASS", "a <File> in the modinfo's LocalizedText reaches the mod list");
  assert.equal(one(c, "description").status, "PASS");
});

test("AffectsSavedGames must be set, and 1 on a UI-only mod warns", async () => {
  const root = tmp();
  assert.equal(one(await run({ dir: cleanMod(path.join(root, "a"), { affects: null }) }), "affects-saved-games").status, "WARN");
  assert.equal(one(await run({ dir: cleanMod(path.join(root, "b"), { affects: "1" }) }), "affects-saved-games").status, "WARN");
  assert.equal(one(await run({ dir: cleanMod(path.join(root, "c"), { affects: "0" }) }), "affects-saved-games").status, "PASS");
});

test("the pre-flight fails on a blocking defect and warns when it cannot run", async () => {
  const dir = cleanMod(path.join(tmp(), "m"));
  const blocked = { ...clean, verdict: "BLOCKS GAME",
    defects: [{ rule: "unknown-table", verdict: "BLOCKS GAME", text: "writes to table X" }, { rule: "missing-listed-file", verdict: "BLOCKS GAME", text: "listed" }] };
  const r = await releaseCheck(bench(), { dir, analyse: () => blocked });
  assert.equal(one(r, "preflight").status, "FAIL");
  assert.equal(one(r, "preflight").evidence.defects.length, 1, "missing files are reported under declared-files");
  const w = await releaseCheck(bench(), { dir, analyse: () => { throw new Error("game install not found"); } });
  assert.equal(one(w, "preflight").status, "WARN");
});

test("a zip is checked against its folder: same version, same loaded files", async () => {
  const root = tmp();
  const dir = cleanMod(path.join(root, "fixture"));
  const zip = zipFolder(dir, path.join(root, "fixture-v1.0.0.zip"));
  const r = await run({ dir, zip });
  assert.equal(r.package.kind, "zip");
  assert.equal(one(r, "zip-matches-folder").status, "PASS");
  assert.deepEqual(byCheck(r, "zip-layout"), []);
  fs.writeFileSync(path.join(dir, "ui/main.js"), "export const x = 2;\n");
  const stale = await run({ dir, zip });
  assert.equal(one(stale, "zip-matches-folder").status, "FAIL");
  assert.deepEqual(one(stale, "zip-matches-folder").evidence.files, ["ui/main.js"]);
  fs.writeFileSync(path.join(dir, "fixture.modinfo"), modinfo({ version: "1.0.1", scripts: ["ui/main.js"], text: ["text/en_us/Text.xml"] }));
  assert.match(one(await run({ dir, zip }), "zip-matches-folder").text, /stale/);
});

test("a zip with no top folder warns; the temporary copy is removed", async () => {
  const root = tmp();
  const dir = cleanMod(path.join(root, "fixture"));
  const zip = zipFolder(dir, path.join(root, "flat.zip"), { flat: true });
  const pkg = openPackage(zip);
  const unpacked = pkg.root;
  assert.ok(pkg.atZipRoot);
  pkg.close();
  assert.equal(fs.existsSync(unpacked), false);
  const r = await run({ zip });
  assert.equal(one(r, "zip-layout").status, "WARN");
});

test("a Steam .vdf must upload this mod at this version and name a preview that exists", async () => {
  const root = tmp();
  const dist = path.join(root, "dist");
  const dir = cleanMod(path.join(dist, "fixture"), { version: "1.1.0" });
  const old = cleanMod(path.join(root, "old"), { version: "1.0.0" });
  const vdf = (content, preview, note = "Version 1.1.0") => `"workshopitem"\n{\n "appid" "1295660"\n "contentfolder" "${content}"\n`
    + `${preview ? ` "previewfile" "${preview}"\n` : ""} "changenote" "${note}"\n}\n`;
  fs.writeFileSync(path.join(dist, "good.vdf"), vdf(dir, null));
  fs.writeFileSync(path.join(dist, "stale.vdf"), vdf(old, path.join(dist, "preview.png")));
  fs.writeFileSync(path.join(dist, "relative.vdf"), vdf("fixture", null, "older notes"));
  const r = await run({ dir });
  const by = Object.fromEntries(byCheck(r, "steam-vdf").map((c) => [path.basename(c.evidence.file), c]));
  assert.equal(by["good.vdf"].status, "PASS");
  assert.equal(by["stale.vdf"].status, "FAIL");
  assert.match(by["stale.vdf"].text, /stale/);
  assert.match(by["stale.vdf"].text, /preview/);
  assert.equal(by["relative.vdf"].status, "WARN", "a relative contentfolder resolves against the .vdf; the note lacks the version");
});

test("version order, escaping entries and the .vdf reader", () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.3", "1.3.0"), 0);
  assert.equal(compareVersions("2.0.0", null), 1);
  assert.equal(compareVersions("1.0.0-beta", "1.0.1"), -1);
  assert.ok(escapes("../evil.js") && escapes("/abs") && escapes("C:\\x") && escapes("a/../../b"));
  assert.ok(!escapes("mod/ui/a..b.js"));
  assert.deepEqual(parseVdf('"a"\n{\n "ContentFolder" "C:\\\\mods\\\\x"\n "changenote" "line one\nline \\"two\\""\n}'),
    { contentfolder: "C:\\mods\\x", changenote: 'line one\nline "two"' });
});

test("the CLI and routes refuse a call without a folder, and help lines fit the help column", async () => {
  const { RELEASE_COMMANDS, RELEASE_HELP, RELEASE_ROUTES } = await import("../lib/cli/release.mjs");
  assert.deepEqual(Object.keys(RELEASE_COMMANDS).sort(), ["l10n", "release-check"]);
  for (const line of RELEASE_HELP.split("\n")) assert.ok(line.length <= 104, line);
  const q = new URLSearchParams();
  assert.throws(() => RELEASE_ROUTES["GET /api/release-check"](bench(), null, q), /which mod folder or zip/);
  assert.throws(() => RELEASE_ROUTES["GET /api/l10n"](bench(), null, q), /which mod folder/);
  const dir = cleanMod(path.join(tmp(), "m"));
  const r = await RELEASE_ROUTES["GET /api/l10n"]({ paths: { install: null } }, null, new URLSearchParams({ dir }));
  assert.equal(r.id, "fixture-mod");
});
