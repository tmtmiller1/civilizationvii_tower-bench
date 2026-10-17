# Workshop preview images: what we tried, and the plan

Status: open. `workshop-upload` is built and tested, and it sends files and change notes. Steam refuses a main preview
image on every item we have, through every route tried so far. The browser is still how a thumbnail gets on a page.

## The problem

Every Tower mod goes up to the Workshop with steamcmd (`workshop_build_item`). A `.vdf` with a `previewfile` line fails
at "Uploading preview image..." with `k_EPublishedFileStorageSystemLegacyCloud == eStorage` and then "Access Denied",
and Steam rolls the whole update back, files included. That's why every release uses the no-preview `.vdf` and the
thumbnail is added on the Workshop page in a browser afterwards. Mods uploaded with Firaxis's official tools get their
preview image without any trouble, so the goal was to send it the way those tools do.

## What we tried

All of it was on Demographics (item 3737200066), on 15 October 2026, with the Steam client on macOS signed in as the
item's owner. Each attempt sent only the preview, so the unreleased 2.8.3 files weren't shipped by accident. The item
was left unchanged every time: no preview, last updated 11 October.

1. **steamcmd with `previewfile`.** Access Denied, as before (also seen on 7, 11 and 12 October, on Demographics and
   on the first upload of Strategic Resources That Matter).
2. **The Steamworks Workshop API running as the game (app 1295660).** `workshop-upload --preview-only --yes`, through
   steamworks.js. Steam answered "access denied". Steam's `cloud_log.txt` says
   `[AppID 1295660] UGC Upload Access Denied for file previewfile_3737200066.png`. The game's app isn't allowed to store
   an image file at all.
3. **Comparing our items with everyone else's.** Steam's public `GetPublishedFileDetails` for all 15 Tower items and
   the 45 other Civ VII items installed on this Mac:

   | | Creator app | Main preview |
   | --- | --- | --- |
   | All 15 Tower items (made by steamcmd) | 1295660 (the game) | none |
   | All 45 other items | 3688890 | every one |

   App 3688890 is almost certainly the Civilization VII Development Tools. The account owns it, but it isn't installed
   (it looks Windows-only).
4. **The same API call running as 3688890.** The auto-mode classifier stops Claude from running a process as another
   app's id ("credential exploration"), so the owner ran a short `node -e` script by hand. Steam's logs:
   - `cloud_log.txt`: `[AppID 3688890] UGC Upload OK for file previewfile_3737200066.png` (13,757 bytes stored)
   - `workshop_log.txt`: `Upload starting for workshop item 3737200066 by AppID 3688890`, then
     `Upload finished for workshop item 3737200066 : Failure`

   So Steam stores the image when it comes from the tools' app. It just won't attach it to an item the game's app made.
5. **Partisans, 16 October 2026.** `workshop-upload --preview-only --yes` on item 3821080590, a day-old item made by
   steamcmd as 1295660. Same result: `UGC Upload Access Denied for file previewfile_3821080590.png` at 18:08:37, item
   unchanged. A new item made by steamcmd is no different from an old one.

## What we know now

- The game's app (1295660) can't upload a preview image. That's a setting on Civ VII's side, not on any one item.
- The tools' app (3688890) can upload the image, but it can't update an item that 1295660 created.
- An item's creator app is fixed when the item is made, and there's no call that changes it.
- So none of the 15 existing Tower items can get a main preview from a script. The browser stays the way for them.
- It's very likely, though nobody has watched it, that an item made as 3688890 takes a preview, because all 45 that
  have one were made that way.

## What `workshop-upload` does today

`node tower-bench.mjs workshop-upload <file.vdf> [--preview F] [--preview-only] [--yes]`, in `lib/workshop-upload.mjs`.

- It runs as the `.vdf`'s app (1295660) through the running Steam client, so there's no password or Steam Guard prompt.
- It sends the files, the change note and the preview. The title, description, visibility and tags stay as they are on
  Steam.
- Without `--yes` it checks everything and stops before sending. It also shows which app made the item.
- When Steam refuses a preview on an item that wasn't made as 3688890, the error says so and points to the browser.
- It needs the optional `steamworks.js` 0.4.0 dependency. Steam takes about 7 seconds to start up as the app.
- Its tests run against a fake Steam client. A real files-and-change-note upload through it hasn't been watched yet.

## The plan

1. **Watch a files-and-change-note upload through `workshop-upload`** on the next real release, with no preview. If it
   works, it can replace steamcmd for updates to the existing items and save the password and Steam Guard step. Run it
   once and check the page and the change notes tab.
2. **Test a new item made as 3688890.** Make one private throwaway item (visibility Private, a dummy mod folder, the
   icon thumbnail) with `createItem` and then `updateItem`, both run as 3688890, then check that its `preview_url` is
   set. The owner has to run it by hand, because the classifier blocks Claude from running as that app. Delete the
   item afterwards.
3. **If step 2 works, add a way to run as the tools' app.** Either `--as-tools` on `workshop-upload`, or reading the
   item's creator app and running as that. Add `workshop-create` too, so a brand-new mod is made as 3688890 from its
   first upload and gets previews from then on. Tests first, against the fake client.
4. **Leave the existing 15 items alone.** Moving one to a new item made as 3688890 would give it a new page and lose
   its subscribers, ratings and comments. That's the owner's decision, mod by mod, and it isn't part of this plan.
5. **If step 2 fails,** write that down here and in `engine-closed.md`, and stop. The browser is then the only way.

## Files and evidence

- Steam's own record of each attempt: `~/Library/Application Support/Steam/logs/workshop_log.txt` and `cloud_log.txt`,
  15 October 2026, 15:44 (as 1295660) and 15:51 (as 3688890).
- The thumbnail used: `working_screenshots/demographics-icon-thumbnail.png`. It's the Demographics icon on the existing
  preview's background and frame, 1024 by 1024 and 14 KB.
- The script the owner ran for attempt 4, from `tools/tower-bench`:

  ```
  node --input-type=module -e '
  const { openSteam } = await import("./lib/workshop-upload.mjs");
  const s = await openSteam(3688890);
  try { console.log("ok", await s.client.workshop.updateItem(3737200066n, { previewPath: "<absolute path to png>" }, 1295660)); }
  catch (e) { console.log("error:", e?.message ?? e); } finally { s.close(); }'
  ```

- Public item details, no key needed:
  `curl -s -X POST https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/ -d itemcount=1 -d 'publishedfileids[0]=<id>'`.
  Look at `creator_app_id`, `preview_url` and `hcontent_preview`.
