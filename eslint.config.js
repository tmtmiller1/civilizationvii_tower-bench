// Dev-only ESLint flat config: the same gate as the tower mods. The bench itself has no runtime
// dependencies; eslint, typescript and the Node types are for `npm run verify` only.
import globals from "globals";

// Engine globals referenced by the functions in lib/engine.mjs, which run inside the game's page.
const ENGINE_GLOBALS = Object.fromEntries([
  "Autoplay", "Cities", "Configuration", "Controls", "Database", "DirectionTypes", "engine", "Game", "GameContext", "GameInfo",
  "FeatureTypes", "GameplayMap", "GameSetup", "GameModeTypes", "Locale", "MapCities", "MapConstructibles", "MapUnits",
  "Modding", "Network", "PlayerOperationTypes", "Players", "ResourceTypes", "RevealedStates", "UI", "UnitCommandTypes",
  "Units", "Visibility", "WorldBuilder", "YieldTypes",
].map((name) => [name, "readonly"]));

const RULES = {
  complexity: ["error", 10],
  "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true, IIFEs: true }],
  "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
  "max-len": ["error", {
    code: 120, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreRegExpLiterals: true,
  }],
  "max-params": ["error", 5],
  "max-depth": ["error", 4],
  "max-statements": ["error", 18],
  "no-undef": "error",
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
  eqeqeq: ["error", "always", { null: "ignore" }],
};

export default [
  { ignores: ["node_modules/**", "dist/**"] },
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { ...globals.node } },
    rules: RULES,
  },
  {
    files: ["lib/engine.mjs", "lib/engine-*.mjs", "lib/events.mjs", "lib/lab.mjs", "lib/deploy.mjs", "test/**/*.mjs"],
    languageOptions: { globals: { ...globals.browser, ...ENGINE_GLOBALS } },
  },
  {
    files: ["ui/**/*.js"],
    languageOptions: { sourceType: "module", globals: { ...globals.browser } },
  },
  {
    // Page-side functions are sent to the game as source text, so each carries its helpers nested in
    // its own body and the line count measures the whole bundle. Complexity and statement limits still
    // apply to every nested helper.
    files: ["lib/engine.mjs", "lib/engine-*.mjs"],
    rules: { "max-lines-per-function": "off" },
  },
  {
    // Tests are flat lists of cases; the size rules measure nothing useful there.
    files: ["test/**/*.mjs"],
    rules: { "max-lines-per-function": "off", "max-statements": "off", "max-lines": "off" },
  },
];
