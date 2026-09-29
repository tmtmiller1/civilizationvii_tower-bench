// The game's script globals, as seen by the functions in lib/engine.mjs that run inside its page.
// They are untyped here on purpose: the bench reads them defensively and re-checks every result.
declare const Autoplay: any, Cities: any, Configuration: any, Database: any, DirectionTypes: any, engine: any,
  FeatureTypes: any, Game: any, GameContext: any, GameInfo: any, GameplayMap: any, GameModeTypes: any,
  GameSetup: any, Locale: any, MapCities: any, MapConstructibles: any, MapUnits: any, Network: any,
  PlayerOperationTypes: any, Players: any, ResourceTypes: any, UI: any, Units: any, WorldBuilder: any;
