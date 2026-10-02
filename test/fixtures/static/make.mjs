// Synthetic fixtures for the static checker tests: a tiny fake game install, a tiny compiled schema built
// with the sqlite3 CLI, and helpers to write small fake mods. Nothing here comes from a real mod.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tmp(prefix = "tb-static-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeTree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

const modinfo = ({ id, groups, criteria = "", deps = "" }) => `<?xml version="1.0" encoding="utf-8"?>
<Mod id="${id}" version="1" xmlns="ModInfo">
  <Properties><Name>${id}</Name></Properties>
  ${deps}
  <ActionCriteria>
    <Criteria id="always"><AlwaysMet></AlwaysMet></Criteria>
    <Criteria id="antiquity"><AgeInUse>AGE_ANTIQUITY</AgeInUse></Criteria>
    <Criteria id="exploration"><AgeInUse>AGE_EXPLORATION</AgeInUse></Criteria>
    ${criteria}
  </ActionCriteria>
  <ActionGroups>${groups}</ActionGroups>
</Mod>`;

/** An action group; `actions` maps an action name to its items. */
export function group(id, scope, criteria, actions) {
  const body = Object.entries(actions)
    .map(([a, items]) => `<${a}>${items.map((i) => `<Item>${i}</Item>`).join("")}</${a}>`).join("");
  return `<ActionGroup id="${id}" scope="${scope}" criteria="${criteria}"><Actions>${body}</Actions></ActionGroup>`;
}

export { modinfo };

const BASE_DATA = `<?xml version="1.0" encoding="utf-8"?>
<Database>
  <TypeTags><Row Type="UNIT_X" Tag="TAG_A"/></TypeTags>
  <Nodes><Row NodeType="NODE_A"/></Nodes>
  <NodeUnlocks><Row NodeType="NODE_A" TargetType="UNIT_X"/></NodeUnlocks>
  <Scorings><Row VictoryType="VICTORY_A" TrackerType="TRACKER_OLD"/></Scorings>
</Database>`;

/**
 * A fake game install in the macOS bundle layout (or the Windows layout with `windows: true`).
 * @returns {string} the install path
 */
export function makeInstall(root, { windows = false } = {}) {
  const res = windows ? root : path.join(root, "Contents", "Resources");
  if (!windows) {
    writeTree(root, { "Contents/Info.plist": "<plist><dict><key>CFBundleShortVersionString</key><string>9.9.9</string></dict></plist>" });
  }
  writeTree(path.join(res, "Base", "modules", "base-standard"), {
    "base-standard.modinfo": modinfo({
      id: "base-standard",
      groups: group("base", "game", "always", { UpdateDatabase: ["data/base.xml"], UpdateText: ["text/en_us/Text.xml"] })
        + group("base-ant", "game", "antiquity", { UpdateDatabase: ["data/antiquity.xml"] })
        + group("base-shell", "shell", "always", { UpdateText: ["text/en_us/ShellText.xml"] }),
    }),
    "data/base.xml": BASE_DATA,
    "data/antiquity.xml": `<Database><TypeTags><Row Type="UNIT_ANT" Tag="TAG_A"/></TypeTags></Database>`,
    "text/en_us/Text.xml": `<Database><EnglishText><Row Tag="LOC_BASE_NAME"><Text>Base</Text></Row></EnglishText></Database>`,
    "text/en_us/ShellText.xml": `<Database><LocalizedText><Row Tag="LOC_SHELL_TAG" Language="en_US"><Text>Shell</Text></Row></LocalizedText></Database>`,
    "ui/panels/panel-x.js": "Controls.define('panel-x', { createInstance: PanelX });\nexport const GameInfoAlias = 1;",
  });
  writeTree(path.join(res, "Base", "modules", "core"), {
    "core.modinfo": modinfo({ id: "core", groups: "" }),
    "ui/input/focus-manager-v2.js": "const FocusTagName = 'focus-thing';\nControls.define(FocusTagName, {});",
    "ui/utilities/utilities.js": "export const Utils = {};",
  });
  writeTree(path.join(res, "DLC", "extra-civ"), { "modules/extra-civ.modinfo": modinfo({ id: "extra-civ", groups: "" }) });
  return root;
}

const GAMEPLAY_SQL = `
CREATE TABLE Types(Type TEXT NOT NULL PRIMARY KEY, Kind TEXT NOT NULL);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1100)
  INSERT INTO Types SELECT 'TYPE_' || i, 'KIND_X' FROM n;
INSERT INTO Types VALUES ('EFFECT_KEPT', 'KIND_EFFECT'), ('COLLECTION_OWNER', 'KIND_COLLECTION');
CREATE TABLE Traditions(TraditionType TEXT NOT NULL PRIMARY KEY, Name TEXT NOT NULL, CultureSlotType TEXT NOT NULL,
  Description TEXT, Weight INTEGER NOT NULL DEFAULT 1);
CREATE TABLE Nodes(NodeType TEXT NOT NULL PRIMARY KEY, Cost INTEGER NOT NULL DEFAULT 0);
CREATE TABLE NodeUnlocks(NodeType TEXT NOT NULL, TargetType TEXT NOT NULL, PRIMARY KEY (NodeType, TargetType),
  FOREIGN KEY (NodeType) REFERENCES Nodes(NodeType) ON DELETE CASCADE);
CREATE TABLE Scorings(VictoryType TEXT NOT NULL PRIMARY KEY, TrackerType TEXT NOT NULL, Points INTEGER);
CREATE TABLE TypeTags(Type TEXT NOT NULL, Tag TEXT NOT NULL, PRIMARY KEY (Type, Tag));
CREATE TABLE Modifiers(ModifierId TEXT NOT NULL PRIMARY KEY);
CREATE TABLE RequirementSets(RequirementSetId TEXT NOT NULL PRIMARY KEY);
CREATE TABLE Counters(Id INTEGER NOT NULL PRIMARY KEY, Name TEXT);
`;
const FRONTEND_SQL = "CREATE TABLE Leaders(LeaderType TEXT NOT NULL PRIMARY KEY, Name TEXT NOT NULL, IntroText TEXT NOT NULL);";
const LOCALIZATION_SQL = `CREATE TABLE LocalizedText(Language TEXT NOT NULL, Tag TEXT NOT NULL, Text TEXT, PRIMARY KEY (Language, Tag));
CREATE VIEW EnglishText AS SELECT Tag, Text FROM LocalizedText WHERE Language = 'en_US';`;

const sqlite = (file, sql) => execFileSync("sqlite3", [file], { input: sql });

/** A user folder whose Debug/ holds a loaded game's databases (or a boot-time copy with `boot: true`). */
export function makeUserDir(root, { boot = false } = {}) {
  const debug = path.join(root, "Debug");
  fs.mkdirSync(debug, { recursive: true });
  sqlite(path.join(debug, "gameplay-copy.sqlite"), boot ? "CREATE TABLE Types(Type TEXT, Kind TEXT);" : GAMEPLAY_SQL);
  sqlite(path.join(debug, "frontend-copy.sqlite"), FRONTEND_SQL);
  sqlite(path.join(debug, "localization-copy.sqlite"), LOCALIZATION_SQL);
  return root;
}

/** A mod folder: a modinfo built from groups plus the given files. */
export function makeMod(parent, id, { groups, files = {}, criteria = "", deps = "" }) {
  const root = path.join(parent, id);
  writeTree(root, { [`${id}.modinfo`]: modinfo({ id, groups, criteria, deps }), ...files });
  return root;
}
