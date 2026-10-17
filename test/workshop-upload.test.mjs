import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { uploadPlan, workshopUpload } from "../lib/workshop-upload.mjs";
import { cleanMod, tmp } from "./fixtures/release/make.mjs";

const ME = 76561198000000001n;

/** A dist folder like the Tower mods': the built mod, a preview and a .vdf naming them. */
function dist({ preview = "preview.png", previewBytes = 2048, id = "3000000001", extra = "" } = {}) {
  const root = tmp("tb-upload-");
  cleanMod(path.join(root, "mod"));
  if (preview) fs.writeFileSync(path.join(root, preview), Buffer.alloc(previewBytes));
  const lines = [`"appid" "1295660"`, id ? `"publishedfileid" "${id}"` : "", `"contentfolder" "mod"`,
    preview ? `"previewfile" "${preview}"` : "", `"title" "Fixture"`, `"changenote" "Version 1.1.0\nFixes things."`, extra];
  const vdf = path.join(root, "workshop_item.vdf");
  fs.writeFileSync(vdf, `"workshopitem"\n{\n${lines.filter(Boolean).join("\n")}\n}\n`);
  return { root, vdf };
}

/** A fake Steam client: the item's owner and timestamps, and every update sent. */
function fakeSteam({ owner = ME, item = true, moves = true } = {}) {
  const state = { timeUpdated: 1000, previewUrl: "", sent: /** @type {any[]} */ ([]), closed: false, appId: 0 };
  const steam = async (appId) => {
    state.appId = appId;
    return {
      close: () => { state.closed = true; },
      client: {
        localplayer: { getSteamId: () => ({ steamId64: ME }), getName: () => "tester" },
        workshop: {
          getItem: async () => (item ? { title: "Fixture", owner: { steamId64: owner }, ...state } : null),
          updateItem: async (id, update, app) => {
            state.sent.push({ id, update, app });
            if (moves) { state.timeUpdated = 2000; if (update.previewPath) state.previewUrl = "https://images.example/p.png"; }
            return { itemId: id, needsToAcceptAgreement: false };
          },
        },
      },
    };
  };
  return { steam, state };
}

test("the plan sends the files, change note and preview, resolved against the .vdf, and keeps the page text", () => {
  const { root, vdf } = dist({ extra: `"description" "Typed on Steam by hand"` });
  const p = uploadPlan(vdf);
  assert.deepEqual(p.problems, []);
  assert.equal(p.itemId, "3000000001");
  assert.equal(p.content, path.join(root, "mod"));
  assert.equal(p.preview, path.join(root, "preview.png"));
  assert.equal(p.previewBytes, 2048);
  assert.equal(p.changeNote, "Version 1.1.0\nFixes things.");
  assert.deepEqual(p.kept, ["title", "description", "visibility", "tags"]);
  assert.ok(!("description" in p));
});

test("--preview-only sends just the image, and --preview picks another one", () => {
  const { root, vdf } = dist({ preview: null });
  const other = path.join(root, "shot.jpg");
  fs.writeFileSync(other, Buffer.alloc(10));
  const p = uploadPlan(vdf, { preview: other, previewOnly: true });
  assert.deepEqual(p.problems, []);
  assert.equal(p.content, null);
  assert.equal(p.changeNote, null);
  assert.equal(p.preview, other);
  assert.deepEqual(p.kept.slice(0, 2), ["files", "change note"]);
  assert.match(uploadPlan(vdf, { previewOnly: true }).problems.join(), /needs an image/);
});

test("the plan names each problem: no item id, missing or oversized preview, wrong type, missing content", () => {
  assert.match(uploadPlan(dist({ id: "" }).vdf).problems.join(), /no publishedfileid/);
  assert.match(uploadPlan(dist({ previewBytes: 1024 * 1024 + 1 }).vdf).problems.join(), /1025 KB; Steam takes up to 1 MB/);
  assert.match(uploadPlan(dist({ preview: "preview.bmp" }).vdf).problems.join(), /PNG, JPG or GIF/);
  const { root, vdf } = dist();
  fs.rmSync(path.join(root, "preview.png"));
  fs.rmSync(path.join(root, "mod", "fixture.modinfo"));
  const problems = uploadPlan(vdf).problems.join();
  assert.match(problems, /preview .* doesn't exist/);
  assert.match(problems, /no \.modinfo/);
});

test("without send it reads the item and sends nothing", async () => {
  const { steam, state } = fakeSteam();
  const r = await workshopUpload(uploadPlan(dist().vdf), { steam });
  assert.equal(r.sent, false);
  assert.equal(r.user.name, "tester");
  assert.equal(r.before.timeUpdated, 1000);
  assert.deepEqual(state.sent, []);
  assert.equal(state.appId, 1295660);
  assert.equal(state.closed, true);
});

test("it refuses an item that belongs to another account, or that Steam can't find, and sends nothing", async () => {
  const plan = uploadPlan(dist().vdf);
  const other = fakeSteam({ owner: 76561198000000002n });
  await assert.rejects(workshopUpload(plan, { send: true, steam: other.steam }), /belongs to 76561198000000002/);
  assert.deepEqual(other.state.sent, []);
  assert.equal(other.state.closed, true);
  const gone = fakeSteam({ item: false });
  await assert.rejects(workshopUpload(plan, { send: true, steam: gone.steam }), /no Workshop item 3000000001/);
});

test("a plan with problems never opens Steam", async () => {
  const { steam, state } = fakeSteam();
  await assert.rejects(workshopUpload(uploadPlan(dist({ id: "" }).vdf), { send: true, steam }), /no publishedfileid/);
  assert.equal(state.appId, 0);
});

test("with send it uploads exactly the plan and watches the item change", async () => {
  const { root, vdf } = dist();
  const { steam, state } = fakeSteam();
  const r = await workshopUpload(uploadPlan(vdf), { send: true, steam, settleMs: 1 });
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].id, 3000000001n);
  assert.equal(state.sent[0].app, 1295660);
  assert.deepEqual(state.sent[0].update, {
    contentPath: path.join(root, "mod"), changeNote: "Version 1.1.0\nFixes things.", previewPath: path.join(root, "preview.png"),
  });
  assert.equal(r.watched, true);
  assert.equal(r.after.previewUrl, "https://images.example/p.png");
});

test("an upload Steam takes but the item never shows is reported as not watched", async () => {
  const { steam } = fakeSteam({ moves: false });
  const plan = uploadPlan(dist().vdf, { previewOnly: true });
  const r = await workshopUpload(plan, { send: true, steam, settleMs: 1, tries: 3 });
  assert.equal(r.sent, true);
  assert.equal(r.watched, false);
  assert.equal(r.after.timeUpdated, 1000);
});

test("a refused update says why, and for an item the game made, that a preview won't go through", async () => {
  const refused = (creatorAppId) => {
    const { steam } = fakeSteam();
    return async (appId) => {
      const s = await steam(appId);
      const getItem = s.client.workshop.getItem;
      s.client.workshop.getItem = async (...a) => ({ ...(await getItem(...a)), creatorAppId });
      s.client.workshop.updateItem = async () => { throw new Error("access denied"); };
      return s;
    };
  };
  const plan = uploadPlan(dist().vdf, { previewOnly: true });
  await assert.rejects(workshopUpload(plan, { send: true, steam: refused(1295660) }),
    /refused the update \(access denied\)\. This item was made as app 1295660.*in a browser/);
  await assert.rejects(workshopUpload(plan, { send: true, steam: refused(3688890) }), (e) => {
    assert.match(e.message, /refused the update \(access denied\)$/);
    return true;
  });
});
