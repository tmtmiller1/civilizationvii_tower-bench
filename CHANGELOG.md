# Changelog

All notable changes to Tower Bench are documented here. This project follows semantic versioning.

## [Unreleased]

- Logs: a failed database action reads as one incident. The file and action group that failed and the outcome (the game
  will not start that content, or the main-menu configuration fails) are errors with hints; the rollback lines after
  them are noise. New signatures for invalid references to removed types, imports of `.chunk.js` bundle files, and
  `SOURCE ERROR` module failures, which are now attributed to their mod. Python and Lua errors from in-page
  interpreters are classified too.
- Registry view (`registry`, Registry tab): replaced legacy components, ui-next components above base priority, and
  the mods applied to this game against those enabled for the next launch.
- Canvas resource pool: `canvas probe` looks for a readable counter, `canvas count` and `agent canvas on` count paint
  calls, and `canvas stress` (lab games only) finds where the game dies.
- Techniques library: a Techniques tab and `techniques` command, and "How to do this instead" links from log lines,
  lint hits, mod-copy warnings and refused deploys.
- `mods conflicts` and `check <mod-folder>` (Mods tab, Deploy tab Pre-flight): static conflicts among the mods the game
  will load, and a pre-flight verdict per mod against the installed game, each finding with a way to prove it and a
  technique that fixes it.
- `doctor <mod-folder>`: the usual causes of "my mod does not work", in order, stopping at the first with the next
  action. `crash`: triage of the newest crash report with its signature, repeats, the logs its run left and the
  bisect command.
- Game updates: `game snapshot`, `game diff` and `game impact` index the installed game and report which mods an
  update breaks, with fixes.
- `dbdiff`: what a mod changed in the compiled database (two lab games), or between any two SQLite files.
  `mods conflicts --prove` checks predicted conflicts in lab games and stores the verdicts.
- Game-state actions (`do`, Actions tab): yields, units, cities, research and map, each verified, logged and undone
  where the engine allows. Undo refuses past a change that cannot be undone unless told to skip it.
- `cost`: per-turn cost of a mod, off against on.
- `release-check` and `l10n`, plus lint rules for text that draws as boxes.
- Techniques are marked watched by the bench when a lab recipe that lists them passes.
- Feature tabs register themselves; evidence shows before and after values for game-state actions.
- `mcp`: an MCP server over stdio so AI assistants can use the bench; read-only unless started with
  `--allow-writes`, `--allow-lab` or `--allow-eval`, every call logged as evidence.
- Examples in the README and the lint placeholder no longer name particular mods.

## [0.1.0] - 2026-09-29

First public release.

- Inspect and change a running game from the CLI or a local web UI: status, plots, the live gameplay database, and a
  console that lists an engine object's methods instead of printing `{}`.
- Verified writes for units, towns, terrain, features and resources, each re-read until observed and given a verdict
  (`LANDED`, `NO EFFECT`, `UNEXPECTED`, `ALREADY`, `REFUSED`, `THREW`), recorded as evidence and undoable.
- Whole-map snapshots and diffs in words, and a live hex map with a diff overlay.
- Deploy to the copy of a mod the game actually loads, reload the UI, and prove each UI file is served as in source.
- Event bridge (`events watch/wait`) and the optional `tower-bench-agent` mod that records from page load through
  reloads.
- Watches and invariants sampled once per turn; GameFace UI lint; classified log tails; mod-copy health from
  `Mods.sqlite`, filterable by id, name or author.
- Switch mods on or off, or choose which copy of a mod loads, for the next launch: refused while the game runs,
  verified by reading the registry back, and undoable.
- Seeded hands-free test games (`lab`), recipes, and bisection over enabled mods, restoring the player's files and mod
  registry after every game.
