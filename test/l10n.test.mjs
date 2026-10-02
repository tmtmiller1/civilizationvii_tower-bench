import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, test } from "node:test";
import { scanGlyphs } from "../lib/engine-l10n.mjs";
import { l10nCheck, l10nLive } from "../lib/l10n.mjs";
import { canonLang, fontDecls, pathLanguage, placeholders } from "../lib/l10n-rules.mjs";
import { fakeVanilla, modinfo, textFile, tmp, writeTree } from "./fixtures/release/make.mjs";

const bench = { paths: { install: null } };
const lint = (files, vanilla = fakeVanilla()) => l10nCheck(bench, { dir: writeTree(path.join(tmp("tb-l10n-"), "m"), files), vanilla });
const rule = (r, id) => r.findings.filter((f) => f.rule === id);
const one = (r, id) => {
  const hits = rule(r, id);
  assert.equal(hits.length, 1, `${id}: ${JSON.stringify(r.findings.map((f) => f.rule))}`);
  return hits[0];
};

const EN = textFile([["LOC_FIXTURE_HELLO", "Hello {1_Name}"], ["LOC_FIXTURE_BYE", "Bye"]]);

test("tags used in data and scripts are checked against the mod's English text and the base game", async () => {
  const r = await lint({
    "fixture.modinfo": modinfo({ scripts: ["ui/main.js"], text: ["text/en_us/Text.xml"], data: ["data/units.xml"] }),
    "text/en_us/Text.xml": EN,
    "data/units.xml": '<Database><Units><Row UnitType="UNIT_X" Name="LOC_UNIT_X_NAME" Description="LOC_BASE_TAG"/></Units></Database>',
    "ui/main.js": [
      'Locale.compose("LOC_FIXTURE_HELLO");',
      'if (reason === "LOC_ENGINE_REASON") skip();',
      'const k = "LOC_FIXTURE_" + kind;',
      'const p = "LOC_FIXTURE";',
      '// "LOC_IN_A_COMMENT"',
    ].join("\n"),
  });
  const shown = one(r, "undefined-tag");
  assert.equal(shown.severity, "error");
  assert.deepEqual(shown.evidence.tags.map((t) => t.tag), ["LOC_UNIT_X_NAME"]);
  const scripted = one(r, "undefined-script-tag");
  assert.equal(scripted.severity, "warn");
  assert.deepEqual(scripted.evidence.tags.map((t) => t.tag), ["LOC_ENGINE_REASON"], "prefixes and comments are not uses");
  assert.equal(r.gameVersion, "9.9.9");
});

test("without the base game, or with a non-base dependency, an undefined tag is only a warning", async () => {
  const files = {
    "fixture.modinfo": modinfo({ text: ["text/en_us/Text.xml"], data: ["data/x.xml"] }),
    "text/en_us/Text.xml": EN,
    "data/x.xml": '<Database><Things><Row Name="LOC_NOWHERE"/></Things></Database>',
  };
  const r = await lint(files, null);
  assert.equal(one(r, "undefined-tag").severity, "warn");
  assert.match(one(r, "undefined-tag").text, /not read/);
  assert.equal(r.gameVersion, null);
});

test("each translation is compared with English in one finding per kind", async () => {
  const r = await lint({
    "fixture.modinfo": modinfo({ loc: {}, text: ["text/en_us/Text.xml", ["text/de_de/Text.xml", "de_DE"], ["text/fr_fr/Text.xml", "fr_FR"]] }),
    "text/en_us/Text.xml": EN,
    "text/de_de/Text.xml": textFile([["LOC_FIXTURE_HELLO", "Hallo {1_Name}", "de_DE"], ["LOC_FIXTURE_EXTRA", "Mehr", "de_DE"]]),
    "text/fr_fr/Text.xml": textFile([["LOC_FIXTURE_HELLO", "Salut {1_Name}", "fr_FR"], ["LOC_FIXTURE_BYE", "Salut", "fr_FR"]]),
  });
  assert.deepEqual(r.languages, [
    { lang: "de_DE", tags: 2, missing: 1, extra: 1 },
    { lang: "fr_FR", tags: 2, missing: 0, extra: 0 },
  ]);
  const missing = one(r, "missing-translation");
  assert.deepEqual(missing.evidence.byLang, { de_DE: ["LOC_FIXTURE_BYE"] });
  assert.equal(one(r, "extra-translation").severity, "info");
});

test("language codes the game lacks, locale attributes that disagree with the rows, and misnamed folders", async () => {
  const r = await lint({
    "fixture.modinfo": modinfo({ text: ["text/en_us/Text.xml", ["text/zh/Text.xml", "zh_Hans_CN"],
      ["text/ko_kr/Text.xml", "ja_JP"], ["text/tr/Text.xml", "tr_TR"]] }),
    "text/en_us/Text.xml": EN,
    "text/zh/Text.xml": textFile([["LOC_FIXTURE_BYE", "Bye", "zh_CN"]]),
    "text/ko_kr/Text.xml": textFile([["LOC_FIXTURE_BYE", "Bye", "ja_JP"]]),
    "text/tr/Text.xml": textFile([["LOC_FIXTURE_BYE", "Bye", "tr_TR"]]),
  });
  assert.match(one(r, "language-unknown").text, /zh_CN/);
  assert.match(one(r, "locale-unknown").text, /tr_TR/);
  assert.match(one(r, "path-language-mismatch").text, /named for ko_KR, rows in ja_JP/);
  assert.deepEqual(rule(r, "locale-mismatch"), [], "the item's locale matches its rows");
  const mm = await lint({
    "fixture.modinfo": modinfo({ text: ["text/en_us/Text.xml", ["text/Text_de.xml", "de_DE"]] }),
    "text/en_us/Text.xml": EN,
    "text/Text_de.xml": textFile([["LOC_FIXTURE_BYE", "Tschuss", "fr_FR"]]),
  });
  assert.equal(one(mm, "locale-mismatch").severity, "error");
});

test("placeholders that use other values are flagged; renamed labels and {LOC_X} references are not", async () => {
  const r = await lint({
    "fixture.modinfo": modinfo({ text: ["text/en_us/Text.xml", "text/ja/Text.xml"] }),
    "text/en_us/Text.xml": textFile([["LOC_FIXTURE_HELLO", "Hello {1_Name}"], ["LOC_FIXTURE_BYE", "Bye {1_Num : number #}"],
      ["LOC_FIXTURE_REF", "Wilderness"]]),
    "text/ja/Text.xml": textFile([["LOC_FIXTURE_HELLO", "Konnichiwa {2_Name}", "ja_JP"], ["LOC_FIXTURE_BYE", "Sayonara {1_Zahl}", "ja_JP"],
      ["LOC_FIXTURE_REF", "{LOC_BASE_TAG}", "ja_JP"]]),
  });
  const p = one(r, "placeholder-mismatch");
  assert.deepEqual(p.evidence.byLang.ja_JP.map((t) => t.tag), ["LOC_FIXTURE_HELLO"]);
});

test("duplicate tags and text listed under UpdateDatabase are errors", async () => {
  const r = await lint({
    "fixture.modinfo": modinfo({ text: ["text/en_us/Text.xml"], data: ["text/en_us/Wrong.xml"] }),
    "text/en_us/Text.xml": textFile([["LOC_FIXTURE_HELLO", "a"], ["LOC_FIXTURE_HELLO", "b"], ["LOC_BASE_TAG", "c"]]),
    "text/en_us/Wrong.xml": textFile([["LOC_FIXTURE_OTHER", "x"]]),
  });
  const dup = one(r, "duplicate-loc-tag");
  assert.equal(dup.severity, "error");
  assert.deepEqual(dup.evidence.tags.map((t) => t.tag).sort(), ["LOC_BASE_TAG", "LOC_FIXTURE_HELLO"]);
  assert.equal(one(r, "text-in-database-action").severity, "error");
});

test("a mod shipping CJK text is warned about font lists that cannot draw it", async () => {
  const files = (css, js = "") => ({
    "fixture.modinfo": modinfo({ scripts: ["ui/main.js"], text: ["text/en_us/Text.xml", ["text/ja/Text.xml", "ja_JP"]] }),
    "text/en_us/Text.xml": EN,
    "text/ja/Text.xml": textFile([["LOC_FIXTURE_BYE", "Sayonara", "ja_JP"]]),
    "ui/main.css": css,
    "ui/main.js": js,
  });
  const bad = await lint(files(".a { font-family: BodyFont, sans-serif; }", 'ctx.font = "14px BodyFont, BodyFont-JP";'));
  const f = one(bad, "cjk-font");
  assert.equal(f.severity, "warn");
  assert.equal(f.evidence.declarations.length, 2, "the CSS list names no CJK face; the canvas list does not START with one");
  const good = await lint(files('.a { font-family: "BodyFont", "BodyFont-JP", "BodyFont-KR"; }'));
  assert.deepEqual(rule(good, "cjk-font"), []);
  const v = await lint(files(".a { font-family: var(--f); }"));
  assert.equal(one(v, "font-family-var").severity, "warn");
  assert.deepEqual(rule(v, "cjk-font"), [], "a var() list is reported once, as font-family-var");
  const english = await lint({ ...files(".a { font-family: BodyFont; }"), "text/ja/Text.xml": EN,
    "fixture.modinfo": modinfo({ text: ["text/en_us/Text.xml"] }) });
  assert.deepEqual(rule(english, "cjk-font"), [], "no CJK text, no CJK warning");
});

test("the modinfo's LocalizedText block and the files it names define tags in every language they hold", async () => {
  const r = await lint({
    "fixture.modinfo": modinfo({ loc: {}, locFile: "text/ModInfo.xml" }).replace("<LocalizedText>",
      '<LocalizedText><Text id="LOC_FIXTURE_NAME"><en_US>Fixture</en_US><de_DE>Vorrichtung</de_DE></Text>'),
    "text/ModInfo.xml": textFile([["LOC_FIXTURE_DESC", "A fixture"], ["LOC_FIXTURE_DESC", "Eine", "de_DE"]]),
  });
  assert.deepEqual(rule(r, "undefined-tag"), []);
  assert.equal(r.english, 2);
  assert.deepEqual(r.languages, [{ lang: "de_DE", tags: 2, missing: 0, extra: 0 }]);
});

test("small parsers: language codes, folder hints, placeholders, font declarations", () => {
  assert.equal(canonLang("ZH_HANS_CN"), "zh_Hans_CN");
  assert.equal(canonLang("zh_CN"), null);
  assert.equal(pathLanguage("text/ja_jp/Text.xml"), "ja_JP");
  assert.equal(pathLanguage("l10n/Text_zh-TW.xml"), "zh_Hant_HK");
  assert.equal(pathLanguage("text/de/Text.xml"), "de_DE");
  assert.equal(pathLanguage("data/desert.xml"), null);
  assert.deepEqual([...placeholders("{1_Name} has {2_Amount : number #,###} of {LOC_X}")], ["1_Name", "2_Amount"]);
  assert.deepEqual(fontDecls("a.css", ".x{font-family: 'Title Font', serif !important}").map((d) => d.families), [["Title Font", "serif"]]);
  assert.deepEqual(fontDecls("a.js", 'el.style.fontFamily = `${f}`; c.font = "bold 12px/1.2 BodyFont-SC, BodyFont";')
    .map((d) => [d.kind, d.families[0]]), [["canvas", "BodyFont-SC"]]);
});

const g = /** @type {any} */ (globalThis);
const saved = { document: g.document, getComputedStyle: g.getComputedStyle };
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; } });

function el(text, style = {}, kids = [], extra = {}) {
  const node = { tagName: "DIV", id: "", className: "", childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
    children: kids, parentElement: null, style: { display: "block", visibility: "visible", opacity: "1", fontFamily: "BodyFont", ...style },
    getBoundingClientRect: () => ({ width: 10, height: 10 }), ...extra };
  for (const k of kids) k.parentElement = node;
  return node;
}

test("the live walk finds replacement glyphs and CJK text drawn with no CJK face", () => {
  const box = el("Score □□");
  const cjk = el("日本", { fontFamily: "BodyFont, sans-serif" });
  const fine = el("日本", { fontFamily: "BodyFont-JP, BodyFont" });
  const hidden = el("�", { display: "none" });
  const body = el("", {}, [box, cjk, fine, hidden]);
  g.document = { body, documentElement: { lang: "ja", className: "" }, querySelector: () => null };
  g.getComputedStyle = (e) => e.style;
  const r = scanGlyphs({});
  assert.deepEqual(r.issues.map((i) => i.rule), ["replacement-glyph", "cjk-no-face"]);
  assert.match(r.issues[0].detail, /U\+25A1/);
  assert.equal(r.lang, "ja");
  assert.equal(scanGlyphs({ scope: "#none" }).error, "no element matches #none");
});

test("the live check runs the walk through the bench and names the technique for each rule", async () => {
  const calls = [];
  const fake = {
    requireConnection: async () => {},
    cdp: { call: async (fn, args) => { calls.push([fn.name, args]); return { visited: 3, issues: [{ rule: "cjk-no-face", path: "div", detail: "x" }] }; } },
  };
  const r = await l10nLive(/** @type {any} */ (fake), { scope: "#panel" });
  assert.deepEqual(calls, [["scanGlyphs", { scope: "#panel", max: 20000 }]]);
  assert.ok(Array.isArray(r.issues[0].techniques));
  const failing = { ...fake, cdp: { call: async () => ({ error: "no element matches #x" }) } };
  await assert.rejects(l10nLive(/** @type {any} */ (failing), { scope: "#x" }), /no element matches/);
});
