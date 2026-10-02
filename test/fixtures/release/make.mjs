// Synthetic mods for the release and localization tests. Nothing here comes from a real mod.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const tmp = (prefix = "tb-release-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export function writeTree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

const DEFAULTS = {
  id: "fixture-mod", version: "1.0.0", modVersion: "1", name: "LOC_FIXTURE_NAME", description: "LOC_FIXTURE_DESC",
  affects: "0", loc: { LOC_FIXTURE_NAME: "Fixture", LOC_FIXTURE_DESC: "A fixture." }, locFile: undefined,
  text: [], scripts: [], data: [], imports: [],
};

/**
 * A modinfo. `text` lists UpdateText items as [file, locale?]; `scripts` UIScripts; `data` UpdateDatabase.
 * @param {{ id?: string, version?: string, modVersion?: string, name?: string, description?: string,
 *   affects?: string | null, loc?: Record<string, string>, locFile?: string, text?: (string | [string, string])[],
 *   scripts?: string[], data?: string[], imports?: string[] }} o
 */
export function modinfo(o = {}) {
  const { id, version, modVersion, name, description, affects, loc, locFile, text, scripts, data, imports } = {
    ...DEFAULTS, ...o,
  };
  const items = (list) => list.map((i) => (Array.isArray(i) ? `<Item locale="${i[1]}">${i[0]}</Item>` : `<Item>${i}</Item>`)).join("");
  const actions = [
    text.length ? `<UpdateText>${items(text)}</UpdateText>` : "",
    scripts.length ? `<UIScripts>${items(scripts)}</UIScripts>` : "",
    data.length ? `<UpdateDatabase>${items(data)}</UpdateDatabase>` : "",
    imports.length ? `<ImportFiles>${items(imports)}</ImportFiles>` : "",
  ].join("");
  const locBlock = Object.entries(loc).map(([t, v]) => `<Text id="${t}"><en_US>${v}</en_US></Text>`).join("")
    + (locFile ? `<File>${locFile}</File>` : "");
  return `<?xml version="1.0" encoding="utf-8"?>
<Mod id="${id}" version="${modVersion}" xmlns="ModInfo">
  <Properties>
    <Name>${name}</Name>
    <Description>${description}</Description>
    <Version>${version}</Version>
    ${affects === null ? "" : `<AffectsSavedGames>${affects}</AffectsSavedGames>`}
  </Properties>
  <ActionCriteria><Criteria id="always"><AlwaysMet></AlwaysMet></Criteria></ActionCriteria>
  <ActionGroups><ActionGroup id="game" scope="game" criteria="always"><Actions>${actions}</Actions></ActionGroup></ActionGroups>
  <LocalizedText>${locBlock}</LocalizedText>
</Mod>`;
}

/** A text file: rows as [tag, text, language?]; no language means an EnglishText row. */
export function textFile(rows) {
  const en = rows.filter((r) => !r[2]).map(([t, x]) => `<Row Tag="${t}"><Text>${x}</Text></Row>`).join("");
  const other = rows.filter((r) => r[2]).map(([t, x, l]) => `<Row Tag="${t}" Language="${l}"><Text>${x}</Text></Row>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<Database>${en ? `<EnglishText>${en}</EnglishText>` : ""}${other ? `<LocalizedText>${other}</LocalizedText>` : ""}</Database>`;
}

/** A clean mod: one script, English text, a README. Returns its folder. */
export function cleanMod(root, o = {}) {
  return writeTree(root, {
    "fixture.modinfo": modinfo({ scripts: ["ui/main.js"], text: ["text/en_us/Text.xml"], ...o }),
    "ui/main.js": "export const x = Locale.compose(\"LOC_FIXTURE_HELLO\");\n",
    "text/en_us/Text.xml": textFile([["LOC_FIXTURE_HELLO", "Hello"]]),
    "README.md": "# Fixture\n",
  });
}

/** Zips `folder` as `<zipDir>/<name>.zip` holding the folder itself (cd parent; zip -r name.zip base). */
export function zipFolder(folder, zipPath, { flat = false } = {}) {
  const cwd = flat ? folder : path.dirname(folder);
  execFileSync("zip", ["-q", "-r", "-X", zipPath, flat ? "." : path.basename(folder)], { cwd });
  return zipPath;
}

/** A Mods.sqlite with one registered copy per row: { id, path, version, props: { Version } }. */
export function modsDb(file, rows) {
  const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
  const sql = [
    "CREATE TABLE ScannedFiles (ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT, LastWriteTime INTEGER);",
    "CREATE TABLE Mods (ModRowId INTEGER PRIMARY KEY, ModId TEXT, Version TEXT, Disabled INTEGER, ScannedFileRowId INTEGER);",
    "CREATE TABLE ModProperties (ModRowId INTEGER, Name TEXT, Value TEXT);",
    "CREATE TABLE LocalizedText (ModRowId INTEGER, Tag TEXT, Locale TEXT, Text TEXT);",
    ...rows.flatMap((r, i) => [
      `INSERT INTO ScannedFiles VALUES (${i + 1}, ${q(r.path)}, 0);`,
      `INSERT INTO Mods VALUES (${i + 1}, ${q(r.id)}, '1', 0, ${i + 1});`,
      `INSERT INTO ModProperties VALUES (${i + 1}, 'Name', ${q(r.id)});`,
    ]),
  ].join("\n");
  execFileSync("sqlite3", [file, sql]);
  return file;
}

/** A stand-in for the installed game: the base text tags it defines and its module ids. */
export function fakeVanilla(tags = ["LOC_BASE_TAG"]) {
  return {
    version: "9.9.9", roots: new Map(),
    textTags: () => new Map(tags.map((t) => [t, [{ file: "base-standard/text/en_us/Base.xml", scope: "game", ages: null }]])),
    modinfos: () => [{ id: "base-standard" }, { id: "core" }],
  };
}
