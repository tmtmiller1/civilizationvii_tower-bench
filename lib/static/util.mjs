import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Build output, VCS and test folders are not part of what the game loads.
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".github", "ci", "types", "__MACOSX", "test", "tests", "devtools"]);

/** Decodes a file the way the game's tools tolerate: UTF-8 (BOM stripped), UTF-16 with a BOM, else Latin-1. */
export function readText(file) {
  const buf = fs.readFileSync(file);
  const bom = buf.subarray(0, 2).toString("hex");
  if (bom === "fffe" || bom === "feff") return new TextDecoder(bom === "fffe" ? "utf-16le" : "utf-16be").decode(buf.subarray(2));
  const body = buf.subarray(0, 3).toString("hex") === "efbbbf" ? buf.subarray(3) : buf;
  return decodeUtf8(body) ?? body.toString("latin1");
}

function decodeUtf8(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * Every file under root, as absolute paths. `all` keeps the folders a mod's build would leave out.
 * @param {string} root
 * @param {{ all?: boolean }} [opts]
 * @returns {string[]}
 */
export function walkFiles(root, opts = {}) {
  /** @type {string[]} */
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop());
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (opts.all || (!SKIP_DIRS.has(e.name) && !e.name.startsWith("_archived"))) stack.push(full);
      } else {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/** Forward-slash path of `full` relative to `root`. */
export const relPath = (root, full) => path.relative(root, full).split(path.sep).join("/");

/**
 * Runs one query against a SQLite file through the sqlite3 CLI, read-only.
 * @param {string} dbPath
 * @param {string} sql
 * @returns {any[]}
 */
export function sqliteJson(dbPath, sql) {
  const out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  return out.trim() ? JSON.parse(out) : [];
}

/** JSON with object keys sorted, so equal values compare equal as strings. */
export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

/**
 * Pairs of distinct entries, in order.
 * @template T
 * @param {T[]} list
 * @returns {Generator<[T, T]>}
 */
export function* pairs(list) {
  for (let x = 0; x < list.length; x++) {
    for (let y = x + 1; y < list.length; y++) yield [list[x], list[y]];
  }
}

/**
 * Appends to a Map of arrays.
 * @template K, V
 * @param {Map<K, V[]>} map
 * @param {K} key
 * @param {V} value
 */
export function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** "a, b, c, +N more" for the first n entries. */
export function listMore(items, n, fmt = (x) => `\`${x}\``) {
  const more = items.length > n ? `, +${items.length - n} more` : "";
  return items.slice(0, n).map(fmt).join(", ") + more;
}

export const code = (s) => `\`${String(s).replaceAll("`", "'")}\``;
