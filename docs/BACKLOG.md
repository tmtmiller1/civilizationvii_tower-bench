# Tower Bench backlog

Everything still to build, watch or fix in Tower Bench, in the order to do it. Started 2026-10-16 from the workspace's
watch list, its overnight-run prompts and the 2026-10-15 next-work prompts; those no longer list Tower Bench work, so
this file is the one place it lives. Take an item off when it's done and say where it was recorded (the README's
"Verified, and how far" section for anything watched, the changelog for anything built).

## Lab ground rules

- One game at a time, and only after `uptime` shows a quiet machine. The Mac was hard-reset twice on 2026-10-15 around
  lab games, once with synthetic keys in flight and once with none, while four or five sessions shared the machine.
- Scripted probes only. No synthetic key events, not even single presses.
- Back up `Mods.sqlite` somewhere a reboot won't wipe (not the scratchpad) and note its sha256. After a crash or reset,
  run `lab stop`, check that `~/.tower-bench/runs/current.json` points at the right run, and compare the registry with
  the backup.
- Ask the other sessions before taking the game, and tell them when it's free.

## 1. Watch the commands that have only run against fakes

These shipped in 0.2.0 and are tested offline. Mark each one watched, failed or blocked in the README.

- `lab run` end to end: seeded game, a recipe with `snapshot`, `turns`, `diff`, `eval` and `expect`, then restore.
  Tried on 2026-10-15 at about 19:49 (`~/.tower-bench/runs/2026-10-15T23-48-18`, backup only). The Mac reset at about
  19:52 while the game was launching, so nothing was read and `lab stop` never ran. The recipe was a seed-4242
  Antiquity start, a snapshot, two turns, a diff against the snapshot, and `Game.turn >= 3`. Start here.
- `nightly run` on a small suite (`nightly init`, then trim the suite to one or two mods so it's one or two games), and
  later its launchd start from `nightly schedule`. The quiet-period check refuses a run within 30 minutes of a save;
  after another session's lab game that's expected, so wait it out or set `quietMinutes` in the suite.
- The hint for a land unit sent to water, as shown on a live write.
- `undo` and the game-state actions (`do`) that haven't been used in a game.
- `cost` against a running game.
- The lab halves of `dbdiff` and `mods conflicts --prove`.
- Connected `doctor` and `l10n live`.
- `sim diff` on a mod, `fuzz`, `arena`.
- `canvas count`, coverage and the CDP routes.
- Log signatures: a scratch mod with one duplicate base row, and `logs` names the incident.
- A published mod that loads Brython at runtime, alone in a lab game: does its `brython.js` load. It decides whether
  the console's `--lang py|lua` is worth building.
- `canvas stress`, the one approved deliberate crash, then a second game with `--reload-at 30000`. Lab only, and only
  on a day the owner is around: launches have hard-reset this Mac.

Blocked until the setup exists:

- `game snapshot`, `diff` and `impact` against a new game build: needs a real game update.
- The Windows default paths: needs Windows.
- The refusal in a real multiplayer or hotseat game: needs a network or hotseat game.

## 2. Lab tooling that cost runs on 2026-10-15

Each of these cost one or more lab games during the overnight runs. Build each with tests against the simulated lab,
the way the other lab commands are tested, then watch it on one real game.

- `lab turns` said it was "blocked by NOTIFICATION_ADVANCED_START" or "NOTIFICATION_PLAYER_MET" when the local player
  had in fact been eliminated. Check `Players.get(0).isAlive` first and say "the local player is out".
- A `lab soak` (or `lab turns --autoplay`): an idle local player loses its city in 28 to 78 turns, and multi-turn
  Autoplay leaves a mod's per-turn work undone. Run one-turn Autoplay in a loop, clear the new age's curtain with
  `UI.notifyUIReady()`, and take a reading every N turns. It replaces the hand-made `loop1.sh` the overnight run used.
- Pop-ups (mod dialogs, the Advisor Council, wonder placards) blocked camera input in probes. A helper that closes
  whatever the context stack holds would save every probe from writing its own.

## 3. The engine-closed command

Design: `tools/plans/tower-bench-engine-closed-plan.md` (2026-10-03). Start only after `lab run` and `nightly run` in
section 1 are watched; the recheck recipes and the nightly hook lean on both.

What the bench gets: a parser for the workspace's `engine-closed.md` (`lib/engine-closed.mjs`), a status per entry
(current, stale, unverified, opened?), `closed`, `closed show <id>` and `closed recheck` commands, recheck results kept
like techniques (`engine-closed-watched.json`, last 20 runs per id), and a nightly hook that reruns every recheck
recipe on a new game version and reports still closed, possibly opened, and stale with no recipe.

Where the file stands, counted 2026-10-15 with a quick script (the parser should replace this count):

- 332 entries, up from the plan's 247: Map, plots and constructibles 127; UI runtime 77; JS engine APIs 35; Loader,
  packaging and databases 31; Population and cities 27; Persistence and storage 15; AI data 9; Crashes 6; Contested 5.
- Evidence: 298 watched with a date, and only 88 of those name a version (`on 1.5.0`); 13 watched with no date; 10
  inferred; one each of "reported" and "clipboard", two "read"; 7 with no `Evidence:` (five are the Contested ones).
  Most entries need the derived version, so the patch-date table matters.
- The entries added on 2026-10-15 are the model of a well-formed one: `Evidence: watched 2026-10-15 on 1.5.0, seed
  4242, ...` followed by a `Source:` link.

Steps:

1. Parser and status model, tested against a fixed copy of `engine-closed.md` in `test/fixtures/`. Report how many
   entries parse cleanly and list the rest by heading.
2. The commands, offline first, in the CLI's existing style and help text.
3. Doc-side changes to `engine-closed.md` (plan `:80-85`): propose them as a diff for the owner; don't rewrite entries
   in bulk.
4. Three recheck recipes for entries a seeded lab game can test cheaply (the plan suggests the single-call API
   verdicts), run in one lab session.
5. The nightly hook, only after those three pass.

Open questions for the owner (plan `:95-101`):

- Does the bench read the workspace's `engine-closed.md` or ship a generic copy? The doc names mods in its Sources,
  and the bench ships no mod names. The plan leans toward shipping the parser and reading a path the user gives.
- Where the patch-date table lives and who updates it. The nightly run could add a new version with the date it
  first saw it.

Done means: watched in a lab game, `closed` lists every entry with no silent drops, one recheck recipe passes and
shows `current`, the same recipe made to fail shows `opened?`, and a simulated version bump turns the rest `stale`.
Recorded in the README's "Verified, and how far" section, with the gate (`npm run verify`) green and an
`[Unreleased]` changelog line.

## 4. Release

- `next-release` holds `dd7cb55` (release-check flags any hidden folder) and the Workshop uploader, uncommitted. Its
  `[Unreleased]` entries are written. The owner pushes Tower Bench; nothing here pushes, tags or uploads.
- Workshop previews: Steam refuses a preview on an item made by steamcmd. What's next is in
  [workshop-preview-plan.md](workshop-preview-plan.md).
