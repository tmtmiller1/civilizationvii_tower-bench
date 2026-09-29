# Changelog

All notable changes to Tower Bench are documented here. This project follows semantic versioning.

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
  `Mods.sqlite`.
- Seeded hands-free test games (`lab`), recipes, and bisection over enabled mods, restoring the player's files and mod
  registry after every game.
