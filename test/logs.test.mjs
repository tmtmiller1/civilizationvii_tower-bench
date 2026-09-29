import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pickTarget, scopeOf } from "../lib/cdp.mjs";
import { LogTail } from "../lib/logs.mjs";

test("tail reports only new whole lines, holds a partial line, and restarts after truncation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-logs-"));
  const file = path.join(dir, "UI.log");
  fs.writeFileSync(file, "old line\n");
  const tail = new LogTail(dir, ["UI.log"]);
  tail.seekToEnd();
  assert.deepEqual(tail.poll(), []);

  fs.appendFileSync(file, "first\r\nsecond half");
  assert.deepEqual(tail.poll().map((l) => l.text), ["first"]);
  fs.appendFileSync(file, "-done\n");
  assert.deepEqual(tail.poll().map((l) => l.text), ["second half-done"]);

  // The game truncates its logs on launch.
  fs.writeFileSync(file, "fresh\n");
  assert.deepEqual(tail.poll().map((l) => l.text), ["fresh"]);
});

test("a backlog read drops the first, probably cut, line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-logs-"));
  fs.writeFileSync(path.join(dir, "UI.log"), "aaaaaaaaaa\nbbbb\ncccc\n");
  const tail = new LogTail(dir, ["UI.log"]);
  tail.seekToEnd(8);
  assert.deepEqual(tail.poll().map((l) => l.text), ["cccc"]);
});

test("the game page wins over the shell page when both are listed", () => {
  const shell = { url: "fs://game/core/ui/shell/root-shell.html" };
  const game = { url: "fs://game/root-game.html" };
  assert.equal(scopeOf(shell), "shell");
  assert.equal(scopeOf(game), "game");
  assert.equal(pickTarget([shell, game]), game);
  assert.equal(pickTarget([shell]), shell);
  assert.equal(pickTarget([]), null);
});
