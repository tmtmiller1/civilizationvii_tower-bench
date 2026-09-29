import { execFileSync } from "node:child_process";
import path from "node:path";

// Mods.sqlite, not Modding.log, is the record of which copy of a mod the game will load. It is read
// through the sqlite3 CLI in read-only mode so the game's own handle on the file is never disturbed.
export function readMods(dbPath) {
  // Names are often LOC tags; the mod's own LocalizedText rows resolve them (en_US, then any locale).
  const sql = `SELECT m.ModRowId AS row, m.ModId AS id, m.Version AS version, m.Disabled AS disabled,
      s.Path AS path, s.LastWriteTime AS lastWrite,
      COALESCE(
        (SELECT t.Text FROM ModProperties p JOIN LocalizedText t ON t.ModRowId = p.ModRowId AND t.Tag = p.Value
          WHERE p.ModRowId = m.ModRowId AND p.Name = 'Name' ORDER BY t.Locale = 'en_US' DESC LIMIT 1),
        (SELECT Value FROM ModProperties p WHERE p.ModRowId = m.ModRowId AND p.Name = 'Name')) AS name
    FROM Mods m JOIN ScannedFiles s USING (ScannedFileRowId) ORDER BY m.ModId`;
  const out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}

export function sourceOf(modPath, paths) {
  const p = modPath.replaceAll("\\", "/");
  const workshop = p.match(/\/workshop\/content\/1295660\/(\d+)\//);
  if (workshop) return { kind: "workshop", label: `Workshop ${workshop[1]}` };
  const userMods = paths.userMods.replaceAll("\\", "/");
  if (p.startsWith(userMods + "/")) {
    const rel = p.slice(userMods.length + 1);
    const nested = /(^|\/)(dist|build|out)\//.test(rel.split("/").slice(1).join("/") + "/");
    return nested
      ? { kind: "nested", label: `Mods/${rel.split("/")[0]} (nested build output)` }
      : { kind: "local", label: `Mods/${rel.split("/")[0]}` };
  }
  if (/\/(DLC|Base)\/modules?\//.test(p) || /\/Resources\/DLC\//.test(p)) return { kind: "official", label: "Official content" };
  return { kind: "other", label: path.dirname(modPath) };
}

// Groups copies by mod id. A duplicated id is the root of the "my edits do nothing" and blank-screen
// failures: the game loads one copy and the edited one is ignored.
export function modHealth(rows, paths) {
  const byId = new Map();
  for (const r of rows) {
    const enabled = !r.disabled;
    const entry = { ...r, enabled, source: sourceOf(r.path, paths) };
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(entry);
  }
  const mods = [];
  for (const [id, copies] of byId) {
    const enabledCopies = copies.filter((c) => c.enabled);
    const issues = [];
    if (enabledCopies.length > 1) {
      issues.push({ severity: "error", text: `${enabledCopies.length} copies are enabled. The game loads one, and edits to the other do nothing.` });
    } else if (copies.length > 1) {
      const live = enabledCopies[0];
      issues.push({
        severity: live?.source.kind === "workshop" ? "warn" : "info",
        text: live
          ? `${copies.length} copies installed. Live: ${live.source.label}. Edits to the others do nothing.`
          : `${copies.length} copies installed, none enabled.`,
      });
    }
    if (copies.some((c) => c.source.kind === "nested")) {
      issues.push({ severity: "warn", text: "A copy sits inside another mod folder's build output. It can shadow the source copy." });
    }
    // Test probes left enabled ride along into every game, including a real campaign.
    if (enabledCopies.length && /probe|repro|harness|-test$/i.test(id)) {
      issues.push({ severity: "warn", text: "A test probe is enabled, so it loads into every game you start, including your campaign. Remove it from Mods/ when the test is done." });
    }
    mods.push({
      id,
      name: copies.find((c) => c.name && !c.name.startsWith("LOC_"))?.name ?? copies[0].name ?? id,
      enabled: enabledCopies.length > 0,
      official: copies.every((c) => c.source.kind === "official"),
      copies,
      issues,
    });
  }
  const rank = { error: 0, warn: 1, info: 2 };
  const worst = (m) => Math.min(...m.issues.map((i) => rank[i.severity]), 3);
  mods.sort((a, b) => worst(a) - worst(b) || a.id.localeCompare(b.id));
  return mods;
}
