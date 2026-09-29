import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { textFromModFiles } from "../lib/mods.mjs";

function mod(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-names-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return path.join(dir, "m.modinfo");
}

const MODINFO = `<Mod id="m"><Properties><Name>LOC_M_NAME</Name></Properties><ActionGroups>
  <ActionGroup id="shell" scope="shell"><Actions><UpdateText><Item>text/de_de/T.xml</Item><Item>text/en_us/T.xml</Item></UpdateText></Actions></ActionGroup>
</ActionGroups></Mod>`;

test("a name tag defined in the mod's own text files resolves, English first", () => {
  const p = mod({
    "m.modinfo": MODINFO,
    "text/de_de/T.xml": `<Database><LocalizedText><Row Tag="LOC_M_NAME" Language="de_DE"><Text>Kanäle</Text></Row></LocalizedText></Database>`,
    "text/en_us/T.xml": `<Database><EnglishText>\n  <Row Tag="LOC_M_NAME">\n    <Text>Canals</Text>\n  </Row>\n</EnglishText></Database>`,
  });
  assert.equal(textFromModFiles(p, "LOC_M_NAME"), "Canals");
});

test("the attribute form resolves; an unknown tag, a missing file or a climbing path gives null", () => {
  const p = mod({ "m.modinfo": MODINFO, "text/en_us/T.xml": `<Database><EnglishText><Row Tag="LOC_M_NAME" Text="Canals"/></EnglishText></Database>` });
  assert.equal(textFromModFiles(p, "LOC_M_NAME"), "Canals");
  assert.equal(textFromModFiles(p, "LOC_OTHER"), null);
  assert.equal(textFromModFiles("/no/such/m.modinfo", "LOC_M_NAME"), null);
  const climbing = mod({ "m.modinfo": MODINFO.replaceAll("text/en_us/T.xml", "../outside.xml").replaceAll("text/de_de/T.xml", "../outside.xml") });
  fs.writeFileSync(path.join(path.dirname(path.dirname(climbing)), "outside.xml"), `<Row Tag="LOC_M_NAME" Text="leaked"/>`);
  assert.equal(textFromModFiles(climbing, "LOC_M_NAME"), null);
});
