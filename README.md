# Tower Bench

A live test bench for Civilization VII mods. Inspect and change a running game from a browser or the command line,
see exactly what changed between two moments, check that your deployed code is the code the game runs, lint the live
UI for GameFace failures, and turn a manual test into a repeatable one that runs itself. Every write is re-read until
the change is actually observed, recorded as evidence, and can be undone. Runs on macOS and anywhere else Node 22 does.

```
node tower-bench.mjs serve                          # web UI at http://127.0.0.1:4380
node tower-bench.mjs --help                         # every command
```

No dependencies. It talks to the game's UI debugger (Chrome DevTools Protocol on port 9444) with Node's built-in
`WebSocket`, and reads `Mods.sqlite` through the `sqlite3` CLI that ships with macOS.

## Requirements

- Node 22 or later.
- The `sqlite3` command-line tool (ships with macOS).
- Civilization VII running with its UI debugger on port 9444. On macOS, game 1.5.0, it answered with `AppOptions.txt`
  left at its defaults; if nothing answers, set `UIDebugger 1` there and relaunch.

## Inspect and change the game

```
node tower-bench.mjs status                         # scope, turn, players, selected unit
node tower-bench.mjs plot selected                  # or: plot cursor, plot unit, plot 12 30
node tower-bench.mjs place unit UNIT_WARRIOR cursor --owner 3 --yes
node tower-bench.mjs set terrain TERRAIN_COAST 40 22 --yes
node tower-bench.mjs undo --yes
node tower-bench.mjs eval 'Players.get(0)'          # objects list their properties and methods
node tower-bench.mjs sql 'SELECT UnitType FROM Units LIMIT 5'
```

**Verified writes.** A write is sent, then the plot is re-read every 50 ms until the intended change appears or the
wait (3 s by default) runs out. The engine's own answers are recorded but never trusted, because `sendRequest` is
fire-and-forget and `canStart` checks request shape, not placement.

| Verdict | Meaning |
| --- | --- |
| `LANDED` | The change was observed, with the time it took |
| `NO EFFECT` | Nothing changed within the wait. Some writes only land at the turn roll |
| `UNEXPECTED` | Something else changed on the plot; the result offers an undo back to the original |
| `ALREADY` | The plot already had that state, so nothing was sent |
| `REFUSED` | Rejected before sending: unknown player, off-map plot, unknown type, nothing to remove |
| `THREW` | The engine call threw |

Supported: place and remove units, found and remove towns, set terrain, set or clear features and resources, for any
player. Requests go out as the local player with `Owner` naming the target civ, the route the engine accepts.

**Undo** reverts today's most recent landed write that has not been undone. The history is the evidence log, so it
survives restarts and the CLI and web UI share it. **Mod code**: each write result carries the minimal standalone call
that does the same thing. **Console**: engine objects serialise to `{}` through JSON, which hides the API, so objects
are described instead, with every method name on their prototype chain. SQL takes one `SELECT` (or `WITH ...
SELECT`) at a time against the live gameplay database; anything that writes is refused before it reaches the game.

## Map and world diff

```
node tower-bench.mjs snap before                    # the whole map in one call
node tower-bench.mjs diff before                    # everything that changed since, in words
node tower-bench.mjs diff before after --json
```

A snapshot holds the owner, terrain, feature and resource of every plot, every unit and settlement, and each player's
gold. A diff groups the changes the way a mod question is asked: tiles moving between players ("2 tiles Augustus (0) ->
Ashurbanipal (1)"), plots retyped, units appearing, dying or moving, settlements founded, lost, captured or growing.
Settlements are matched by plot, so a capture reads as a capture.

The web UI's **Map** tab draws the live map as hexes, tinted by owner, with settlements and units. Click a plot to
inspect and change it. "Changes since" overlays a diff: territory changes, retyped plots, units that appeared and
units that are gone. The row offset and which way north runs are read from the engine, not assumed.

## Deploy, and prove it is live

```
node tower-bench.mjs deploy ~/code/my-mod            # plan: which copy is live, what differs
node tower-bench.mjs deploy ~/code/my-mod --yes      # copy, then prove
node tower-bench.mjs deploy ~/code/my-mod --prove    # copy nothing: does the game serve your source?
```

The target is whichever copy `Mods.sqlite` says the game loads. A deploy into a **Workshop** copy is refused, because
Steam replaces that folder and every other copy is ignored; two enabled copies are refused too. After copying UI files
it calls `UI.reloadUI()` (skip with `--no-reload`), because `UIFileWatcher` does not reload the page for a changed
UIScript. A stamp on the page then shows whether it reloaded, and each UI file the game now serves is hashed and
compared with the source: `SERVED`, `STALE` or `UNREADABLE`. Data and text files are compiled when a game starts, so
they are reported as needing a new game rather than pretended live. A mod with its own deploy script
(`scripts/deploy.mjs`, `install-dev.sh`) should keep using it, since it can ship files the modinfo does not declare;
`--prove` then answers "is my edit live?" on its own.

## Engine events

```
node tower-bench.mjs events list City                 # 269 declared gameplay events, filtered
node tower-bench.mjs events watch CityTransfered UnitMoved --log
node tower-bench.mjs events wait CityTransfered --match "e.names.player === 'Augustus'" --timeout 120
```

The event bridge subscribes with the engine's own `engine.on` inside the page and buffers every event with a page id,
a sequence number, the turn, the raw payload and readable names (`cityID=Nineveh`, `player=Augustus`; player ids are
resolved only through `Players.get`). The bench drains the buffer continuously. When the page is replaced (a reload or
an age transition) the new page id shows it, the bridge re-subscribes, and the break is recorded as an explicit gap
rather than silently missing events. With `--log` every event is also written to `UI.log`, so one recorded just before
a crash survives it; events that arrive both live and from the log are kept once. Everything received is appended to
`~/.tower-bench/events/<local date>.jsonl`.

In a recipe, `{ "events": [...] }` starts listening and `{ "await": { "event", "match", "timeoutMs" } }` waits for a
matching event; `"none": true` instead requires that none arrives, e.g. "no settlement changes hands in five turns".
`match` is a JS expression over the event `e`. This replaces the probe that hooks an event, waits and logs.

**The agent** closes the one gap live reading cannot: code that must run from page load and straight through a reload.
`agent install --yes CityTransfered` writes a small mod, `tower-bench-agent`, whose UIScript is the same bridge code
with the list baked in. It records from the moment the page loads, through every reload and age transition, and always
writes to `UI.log`. The bench picks those lines up and live sessions share its buffer; a live session can add
subscriptions but never remove the agent's. With an empty list (`agent off`) it does nothing, which matters because an
installed mod loads into every game. The game registers it at its next launch; `agent set` changes its list from the
next page load; `agent remove --yes` moves it out of `Mods/`.

The zero-install alternative, CDP's `Page.addScriptToEvaluateOnNewDocument`, is not available: Cohtml's method table
names `navigate` and `reload` from the Page domain but not that method.

## Watches and invariants

```
node tower-bench.mjs watch add gold 'Players.get(0).Treasury.goldBalance'
node tower-bench.mjs watch invariant no-negative-pop 'Players.get(0).Cities.getCities().every(c => c.population > 0)'
node tower-bench.mjs watch sample
```

While `serve` runs, every watch and invariant is evaluated once per turn, browser open or not. Watches become a series
(the web UI draws a sparkline); an invariant passes only when it returns exactly `true`, and every violation is written
to the evidence log with the turn.

## UI lint

```
node tower-bench.mjs lint --scope .demographics-screen
```

Walks the running UI and flags GameFace failures, judged the way GameFace actually reports them (each watched on
1.5.0, 2026-09-26, by planting the fault in the live UI):

| Rule | What GameFace does | How it is seen |
| --- | --- | --- |
| `italic` | italic text lays out at zero height and draws nothing | computed `font-style: italic` on an element with text; the report includes its collapsed size |
| `border-color` | a dropped `border-color` (a shorthand, or one set through `var()`) reads `initial` | a border with width and style whose colour is `initial` or `currentcolor` |
| `subpixel-border` | a border under 1 px can lose an edge under `transform: scale` | computed width between 0 and 1 px |
| `unresolved-text` | a LOC tag, an engine type name, or a `data-l10n-id` tag that did not resolve, shown as text | visible own text matching the LOC pattern |

CSS grid cannot be checked here: GameFace strips `display: grid` from the style and computes `block`, so only the
log signature (`near text: 1fr`) reveals it, and the Logs view catches that. On an idle map view the whole UI gave 2
hits in 511 elements, both the base game's own; point `--scope` at a mod's root to lint just that mod.

## Mods and logs

`mods` reads `Mods.sqlite` and groups copies by mod id: two enabled copies is an error, a Workshop copy live over a
local one is a warning, a copy inside another mod's `dist/` is a shadow, and an enabled test probe is flagged because it
loads into every game, your campaign included. Names and authors are resolved through each mod's own `LocalizedText`,
and `--filter` (or the box in the Mods tab) matches id, name or author, so `--filter tower` lists one author's mods.

```
node tower-bench.mjs mods --filter canals
node tower-bench.mjs mods live tower-canals "Mods/tower-canals" --yes    # load this copy, switch the others off
node tower-bench.mjs mods off example-probe --yes
node tower-bench.mjs undo --yes
```

The same changes are buttons in the Mods tab. They change which mods the game loads at its next launch, so they are
refused while the game is running, while a lab run holds a backup of the registry, and while writes are disarmed. Each
change is read back from `Mods.sqlite` (`LANDED`, `NO EFFECT` or `ALREADY`), recorded as evidence and undone by Undo
like a map write. `live` is the fix for two enabled copies of one id; `on` never enables a second copy. A flag the game
left empty (`NULL`, shown as "default") is only replaced when you change that copy, and undo puts `NULL` back rather
than guessing 0 or 1: the game uses it for more than one state. Official content is left to the game's add-ons screen.

`logs` tails `UI.log`, `Modding.log`, `Database.log` and `Scripting.log` and classifies lines against signatures from
real failures:

| Signature | Severity | What it means |
| --- | --- | --- |
| `near text: 1fr`, `display: grid` | error | GameFace has no CSS grid; the stylesheet stopped parsing |
| `does not provide an export named` | error | Usually a stale copy of the mod is loading instead of your edits |
| `No registered handler for 'x (ReplaceUIScript)'` | warn | A Civ VI action verb; the Civ VII loader has none, so the group does nothing |
| `No registered handler for 'x (UpdateText)'` | noise | A valid verb not handled in this scope; official content logs it too |
| `There were issues loading '<file>'` | warn | One bad row, such as a duplicate LOC tag, can drop a whole text file |
| SQLite constraint failures | error | A database action was rejected |
| `Failed loading resource:` | warn | A missing asset; the base game logs some of these itself |
| Uncaught / TypeError / ReferenceError | error | A script threw |

## Test games, recipes and bisection

```
node tower-bench.mjs lab start --seed 4242 --age AGE_ANTIQUITY
node tower-bench.mjs lab turns 5
node tower-bench.mjs lab stop
node tower-bench.mjs lab run my-test.json            # seeded game -> recipe -> restore
node tower-bench.mjs recipe record > my-test.json     # today's landed writes as a recipe
node tower-bench.mjs bisect --turns 30 --replicates 2
```

**The lab** backs up `Mods.sqlite`, `LocalStorage.sqlite`, `HallofFame.sqlite`, every `*Options*.txt` and
`Saves/Single/auto`, then starts a Play Now game entirely over CDP from the main menu: no probe mod, no registry
change. Seeded Play Now games are deterministic. `lab turns` ends turns without Autoplay (Autoplay spends the
treasury) and refuses to run in any game the lab did not start. `lab stop` quits the game and restores every backed-up
file and every registry flag by path; whatever the test game wrote is moved into the run folder, never deleted. Before
starting it refuses if the game or another lab or bisect run is running, and warns about enabled probe mods. Set
`TOWER_BENCH_HARNESS` to a regular expression matching your own test scripts to have them block a start too.
`lab stop` only quits the game the lab started; any other running game is refused, not killed.

**A recipe** is a test written as JSON: a seed and start age, then steps (`snapshot`, `write`, `turns`, `diff`,
`expect`, `eval`, `lint`, `sample`, `events`, `await`). Positions can anchor to the local player's first unit with an
offset, so one recipe works on any seed. `recipe record` turns the writes you landed by hand today into a recipe,
skipping any you undid. A recipe is code, like a test file: `expect` and `eval` run in the game and `await` matches run
in Node with your user's rights, so run recipes you wrote or have read.

```json
{ "name": "strand-check", "seed": 4242, "age": "AGE_ANTIQUITY",
  "steps": [ { "snapshot": "start" },
             { "write": { "op": "unit.place", "args": { "at": "unit", "dx": 1, "type": "UNIT_SPEARMAN", "owner": 1 } } },
             { "turns": 2 },
             { "diff": "start" },
             { "expect": "Players.get(1).Units.getUnitIds().length > 0" } ] }
```

**Bisection** answers "which mod does this need?" by isolation. It runs the failure with every candidate on (it must
fail) and every candidate off (it must pass), then halves the set until one mod remains, and confirms that everything
else without it is clean. A failure is a crash (the game exits, a new `.ips` appears) or a failed recipe. Crashes here
are not fully deterministic, so each configuration runs `--replicates` times: it fails if any replicate fails and is
clean only if all are. Verdicts: `ISOLATED`, `INTERACTION` (needs mods from both halves), `NOT REPRODUCED`,
`NOT A CANDIDATE` (fails with every candidate off), `INCONCLUSIVE`. Each trial is a full lab cycle, so the registry and
your files are restored after every game.

## Safety

- Map writes (place, remove, set, undo) and mod switches are disarmed until armed in the UI or confirmed with `--yes` on the CLI. The
  console, watches and deploy are not gated by arming: the console runs whatever JavaScript you give it in the game,
  and deploy copies files and reloads the game's UI. The SQL console refuses anything but a single read.
- Every player id is resolved through `Players.get` before a request is sent: an invalid id passed to some engine
  calls segfaults the game.
- The server binds to `127.0.0.1` only, refuses any other `Host` header, refuses a `POST` without an
  `X-Tower-Bench: 1` header, and refuses any request a browser marks as cross-site, so a web page open in your
  browser cannot drive or load the game through it. It serves only its own page and scripts.
- `deploy` refuses a modinfo that lists a file outside the mod folder, and the bench only connects to a debugger
  socket on this machine.
- The debugger port itself is the game's, not this tool's. While the game runs with it open, anything on the machine
  can reach it.

## Configuration

| Variable | Default (macOS) |
| --- | --- |
| `TOWER_BENCH_USER_DIR` | `~/Library/Application Support/Civilization VII` |
| `TOWER_BENCH_INSTALL` | the Steam app bundle, used for the build version |
| `TOWER_BENCH_CDP_PORT` | `9444` |
| `TOWER_BENCH_EVIDENCE_DIR` | `~/.tower-bench/evidence`; snapshots, watches and lab runs live beside it |
| `TOWER_BENCH_HARNESS` | unset; a regular expression for your own test scripts, which then block `lab start` and `bisect` |

On Windows the user directory defaults to `%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VII`.

## Verified, and how far

**Watched working, 2026-09-26, game 1.5.0:**

- 70 tests at the time, stable across 15 consecutive runs (78 now, with the security tests). They cover the in-game
  functions run against a fake engine: the write verification loop reaching each verdict, the snapshot reading row shift
  and north from the engine, watches and invariants, and the page-side hash matching the Node-side one. The event bridge
  is tested end to end through the real page-side function: subscribe, fire, drain, readable names, unsubscribe via
  `engine.off`, buffer overflow counted as dropped, a simulated reload caught as a gap, de-duplication against `UI.log`
  including a clipped line, `waitFor` and `none`, recipe `await` steps, and the agent script loading on its own and
  keeping its list and logging when a live session unsubscribes. Two deliberate breaks of the bridge (pinning, page
  identity) each turned a test red. They also cover world diffs, recipe execution and recording, the bisection search
  (culprit, interaction, flaky failures, both "no" answers), deploy planning and its refusals, watch series, lab restore
  (files back byte for byte, `NULL` kept as `NULL`, nothing deleted, new registry rows left alone), log signatures
  against lines from real game logs, and every CLI command run as a subprocess.
- Against real data: `mods` found 107 ids, 71 enabled, 7 duplicated ids and 3 enabled test probes. `logs` classified
  1,326 lines. `deploy` refused `universal-auto-explore` because its Workshop copy is live, and planned Demographics
  correctly: its live copy dates from 09-24 and differs from the 09-26 source.
- In headless Chrome: all nine tabs with zero console errors or exceptions. The lint rules flagged all six traps in a
  fixture page and none of its decoys. The map drew a synthetic 96x60 world with a diff overlay, and a click on a plot's
  pixel centre mapped back to that plot. The server refused a foreign `Host`, a headerless `POST` and a disarmed write.

**Watched live, 2026-09-26, game 1.5.0, a seeded lab game (seed 4242) started by `lab start`:**

- `lab start` backed up and started the Play Now game hands-free over CDP; `lab turns` ended five turns without
  Autoplay, passing the `COMMAND_UNITS` blocker; `status` read the game. `lab stop` then quit it and restored the
  player's files: all 11 autosaves, `LocalStorage.sqlite`, `HallofFame.sqlite` and 9 options files byte-identical to
  the backup, 114 registry rows unchanged (the only new row was `tower-bench-agent`), and the test game's 7 autosaves
  and file copies set aside in the run folder, not deleted.
- Writes: unit place and undo, terrain FLAT -> HILL and undo all `LANDED` in 82 to 156 ms, each confirmed by re-read.
  A forest requested on a desert plot cleared the plot's sagebrush instead; that run exposed that `NO EFFECT` was
  hiding a real change, and the `UNEXPECTED` verdict (with an undo back to the original) was added for it.
- Events: `events wait` caught `PlayerTurnActivated` live; `events watch` streamed only the requested event, with
  readable names including Unicode city names. `UnitMoved` arrives for units the local player cannot see.
- The agent registered at launch, attached at page load, recorded 72 events with no sequence gaps, kept its pinned
  list while live sessions subscribed and unsubscribed, and after `UI.reloadUI()` wrote its unload marker and
  re-attached on the new page within 1 s, recording 63 more. The live watcher reported the reload as a gap.
- `Page.reload` over CDP and `UIFileWatcher` did not reload the page; `UI.reloadUI()` did.
- `bisect` with `recipes/bisect-selftest.json` (fails only when Emigration is loaded) over four mods returned
  `ISOLATED: emigration` in the five games predicted, each 30 to 40 s: all on failed, none on was clean, the half with
  Emigration failed, Emigration alone failed, everything but Emigration was clean. The last game's `Modding.log`
  applied Demographics, Cultural Diffusion and Readable Tooltips and never named Emigration. After all five, the
  player's autosaves, LocalStorage, Hall of Fame and options were byte-identical to before the first game, all 115
  registry rows unchanged, and no crash reports.

- Snapshots and diff: two known writes between snapshots diffed to exactly those two changes and nothing else, and
  undoing both diffed back to nothing. Across two AI turns the diff agreed with the agent's recorded events: every
  settlement founded matched a `CityAddedToMap`, every unit that moved was accounted for. That check caught the bench
  counting each city 7 times (`MapCities.getCity` answers for every owned plot);
  fixed, and `remove town` on a territory plot now refuses instead of destroying the city.
- The map drew the real 74x46 world with the engine's layout (odd rows shifted, north at y+1) and a diff overlay.
- Lint: all four rules above flagged a planted fault in the live UI after three were corrected to GameFace's actual
  behaviour; hidden elements and plain captions were not flagged.
- Watches: `serve` sampled once per turn across a two-turn roll; an always-true invariant held and an always-false
  one wrote exactly one `VIOLATED` evidence entry per turn.
- Deploy: `--prove` on Demographics found 150 files served identical to source and 60 stale, the 60 being exactly
  the UI files that differ on disk (read over XHR; GameFace has no `fetch`). A real deploy copied a changed file,
  reloaded the UI itself, served the new bytes, and the new code's marker was live in the page on the same turn.

**NOT verified yet:** the `lab run` command as a whole (its parts ran inside bisect), and the Windows default paths.
The code was restructured for 0.1.0 after the live runs above (every function kept its engine calls and their
order, checked against the original side by side on a fake engine); the in-game paths have not been re-watched since.


## Engine behaviour this relies on

Each of these was watched in the game before the bench relied on it: writes land after the call and the return value
proves nothing; an operation sent under another player's id is refused; `CREATE_ELEMENT {Kind: "CITY"}` silently
rejects some founding spots; `WorldBuilder.MapPlots.setTerrain` lands about a tick later and does not rebuild the
navigation graph for a navigable river. The lab relies on these, also watched: Play Now honours the mod registry where
a loaded save does not, nothing gameplay-side lands before `UI.notifyUIReady()`, Autoplay spends the treasury, the
registry is restored by path because row ids change on re-scan, and a crash report lands 20 to 50 s after the game
dies. The `DESTROY_ELEMENT` argument shapes follow the SDK's own `tuner-input.ts`.

## Contributing

`npm install` once, then `npm run verify` before a change: type check, lint and tests, with zero errors. The bench
itself has no runtime dependencies; the installed packages are the checkers only.

## License

MIT. See [LICENSE](LICENSE). Tower Bench is not affiliated with or endorsed by Firaxis Games or 2K. Civilization is
a trademark of Take-Two Interactive Software.
