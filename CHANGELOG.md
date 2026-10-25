# Changelog

All notable changes to Tower Bench are documented here. This project follows semantic versioning.

## [Unreleased]

- `lab start --setup` takes a mod's own setup parameter whose id has a hyphen in it, such as Emigration's
  `EMIG-AiStrategy=EMIG_AI_STRATEGY_OFF`. It used to refuse the value as a bad setup value.

## [0.3.0] - 2026-10-25

- `lab start --setup fast` starts the test game with an abbreviated age, friendly independents and Settler difficulty,
  so an idle test player keeps its city and the age ends sooner. Single values work too
  (`--setup fast,MapSize=MAPSIZE_TINY`). After the game starts, the lab reads each value back from the running game
  and warns about any it didn't take.
- `lab start --quick` turns on quick combat and quick movement, turns off the historic-moment animation and skips the
  era welcome screens for that game. The option files go back at `lab stop`, like the rest.
- `lab drive <turns>` plays turns with one-turn Autoplay re-armed from inside the game, so the mods' per-turn work
  runs every turn and no shell round trip is needed. It closes pop-ups as it goes, takes a reading every
  `--every` turns from `--sample file.js`, picks back up after a new age reloads the page, and writes its lines to
  `drive.log` in the run folder.
- `lab popups [clear|list|suspend|resume]` closes, lists or holds back the game's pop-ups and pushed screens, and
  names each one it closes. `--keep` leaves the named categories alone. Watched 2026-10-17 on two age changes and a
  Modern game: `list` named the end-of-age pop-ups and the pushed screens, `clear` named each pop-up it closed and
  `screen-dialog-box`, and the camera moved after. A screen that closes along with its pop-up
  (`screen-tech-civic-complete`, `advisor-council-popup`, `mouse-guard`) closes but isn't named.
- `lab turns` carries on through the end of an age: the last turn counts once the next age's first turn is up and
  its loading screen has cleared, where before it timed out waiting on the age change. Watched 2026-10-17: "turn 120
  -> 1, into the next age", and the next command found the game past its loading screen.
- `lab drive <turns> --stop-before-age-end <points>` stops the drive once the age's progress is within that many
  points of its maximum, and says so. If the age ends inside the drive anyway, the drive stops there. Watched
  2026-10-17 in three games: `lab drive 200 --stop-before-age-end 10` stopped at "age progress 110 of 120, within 10
  of the age's end" after 100 to 109 turns.
- `lab age-change` crosses into the next age without Autoplay: it ends one turn at a time until the age changes,
  names each end-of-age screen as it comes up and what cleared it, takes the victories screen's Exit and the civ
  select's Choose (`--civ` picks the civ), clears the new age's loading screen and reports the new age and turn.
  Watched 2026-10-17 crossing Exploration into Modern and Antiquity into Exploration: "turn 120 -> 1, into the next
  age", "loading curtain cleared by UI.notifyUIReady()", "into AGE_MODERN, turn 1". Neither game showed the endgame
  cinematic, the victories screen or the civ select (the game picked the next civ itself), so those steps and `--civ`
  haven't run in a game yet.
- `release-check` warns about any hidden folder in a package, any folder whose name starts with a dot, where before it
  only knew a few editor and CI folders by name.
- `workshop-upload <file.vdf>` uploads a Workshop item's files, change note and preview image through the running Steam
  client, as Civilization VII, with no password prompt. The title, description, visibility and tags stay as they are
  on Steam. Without `--yes` it checks everything and sends nothing, and shows which app made the item. On an item made
  by steamcmd, Steam still refuses the preview, and the error says why. Needs the new optional `steamworks.js`
  dependency.
- `workshop-tags <mod-folder...>` sets each item's Workshop tags from the mod's `docs/steam-workshop-tags.txt`, so items
  uploaded with steamcmd show up under the Workshop's category filters. It checks each tag against the Workshop's
  own list and sends nothing but the tags. Without `--yes` it shows the tags before and after. Watched 2026-10-25 on
  16 items.

## [0.2.0] - 2026-10-06

- Writes, game-state actions, undo, recipe steps and the console are refused in a multiplayer (network or hotseat)
  game, and when the bench cannot tell whether the game is multiplayer.
- The same changes are refused unless the game was launched with the tuner on (`EnableTuner 1` in `AppOptions.txt`,
  without `AchievementsRestrictedByTuner 0`), so a game the bench changes cannot earn achievements.
- Extensions: `lib/extensions.mjs` lets a separate tool add commands, flags, server routes and a page tab.
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
- `nightly`: overnight checks after a game update (index, impact, pre-flight, l10n, every recipe in lab games) with a
  morning report of what newly fails; schedulable with launchd. `lab` and `bisect` refuse while a nightly runs.
- `atlas`: an engine API reference built from the game's own scripts, declaration files, findings docs and a
  read-only live crawl; search, show, diff between versions, Markdown export.
- `sim diff` / `sim repeat`: the same seeded game with a mod off and on, the first divergence, and a determinism
  control; `fuzz`: random verified actions with invariants, failures shrunk to a minimal recipe; `arena`: balance
  across seeds with bootstrap intervals. `lab` and `bisect` refuse while any long run is going.
- `coverage`: which of a mod's functions and branches ran, from the debugger's Profiler or from counting copies
  deployed to the live copy and restored afterwards.
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
