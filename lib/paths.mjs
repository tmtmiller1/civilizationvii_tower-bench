import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const home = os.homedir();

function platformDefaults() {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return { user: path.join(local, "Firaxis Games", "Sid Meier's Civilization VII"), install: null };
  }
  return {
    user: path.join(home, "Library", "Application Support", "Civilization VII"),
    install: path.join(
      home, "Library", "Application Support", "Steam", "steamapps", "common",
      "Sid Meier's Civilization VII", "CivilizationVII.app",
    ),
  };
}

export function resolvePaths(env = process.env) {
  const d = platformDefaults();
  const user = env.TOWER_BENCH_USER_DIR ?? d.user;
  return {
    user,
    logs: path.join(user, "Logs"),
    modsDb: path.join(user, "Mods.sqlite"),
    userMods: path.join(user, "Mods"),
    install: env.TOWER_BENCH_INSTALL ?? d.install,
    evidence: env.TOWER_BENCH_EVIDENCE_DIR ?? path.join(home, ".tower-bench", "evidence"),
    cdpPort: Number(env.TOWER_BENCH_CDP_PORT ?? 9444),
  };
}

// The engine exposes no build-version call to script (Network.getBuildVersion is absent on 1.5.0),
// so the version comes from the app bundle. Returns null when it can't be read.
export function gameVersion(paths) {
  if (!paths.install || process.platform !== "darwin") return null;
  try {
    return execFileSync("/usr/libexec/PlistBuddy", [
      "-c", "Print :CFBundleShortVersionString", path.join(paths.install, "Contents", "Info.plist"),
    ], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}
