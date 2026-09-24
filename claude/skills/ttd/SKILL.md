---
name: ttd
description: The Transport Tycoon Deluxe remake built on the kit — the simulation (World, GameMap, towns, industries, stations, companies, vehicles, commands), its data tables (TTDData from OpenTTD 0.5.3), the 3D view (TTDTerrain3D, TTDModels3D, TTDRender3D), tools and HUD (TTDTools, TTDGui, Game). Read before editing any js/TTD*.js file or js/Game.js, before changing game rules, prices, vehicles, industries or houses, and before adding a tool, window or vehicle type.
---

# TTD remake: how the game code is organised

Rules first, 3D second. Everything that decides the game — heights, track, cargo, money — lives
in plain JS that runs in node without Babylon (tests/ttd-sim.test.mjs plays whole routes). The
3D view only reads the world; the HUD only calls commands. docs/TTD-mechanics.md lists every TTD
formula and says what is implemented or left out.

## Files (load order in index.html)

| File | What |
|---|---|
| `TTDUtil.js` | `Rng` (seeded), `Dir` (TTD DiagDir 0 NE, 1 SE, 2 SW, 3 NW), `Calendar` (days since 1900), `Money` (pounds, shown in the chosen currency), `IMath` (clamp, distances, heap) |
| `TTDData.js` | converted OpenTTD 0.5.3 tables: `CARGOS` per climate, `PRICES`, `BRIDGES`, `AIRPORTS`, `CATCHMENT`, `BREAKDOWN_CHANCE`, `ENGINES`, `INDUSTRIES`, `CREATE_TABLES`, `HOUSES`, `TOWN_NAMES` |
| `TTDMap.js` | `GameMap`: corner heights, tile arrays (`type`, `ground`, `zone`, `rail`, `road`, `signals`, `obj`, `sub`, `town`, `over`, `wz` …), slopes and foundations, `pieceEdgeZ`, terraform planning, generation, dirty chunks, save |
| `TTDTrack.js` | `Track`: the six track pieces, trackdirs, piece geometry and heights, rail/road connectivity; `PathFinder.search` (A*) |
| `TTDTown.js` | `Town`, `TownNames` (TTD English, Catalan), `Towns`: founding, grid road growth, houses, the house tile loop, monthly growth rate and ratings, `ACTIONS` |
| `TTDIndustry.js` | `Industry`, `Industries`: placement checks, production, delivery, monthly changes, closure, fields, lumber mill |
| `TTDStation.js` | `Station`: parts, catchment, acceptance, cargo packets, TTD's rating |
| `TTDCompany.js` | `Company`: money, loan, 13 finance categories, quarters, score parts |
| `TTDVehicle.js` | `Vehicle` base (orders, gradual loading and payment, breakdowns, service, autorenew), `Vehicles` (prices, running costs, build/sell, cargo ageing, wormhole points) |
| `TTDTrain.js` | `Train` (steps along pieces, signals, stop at platform end, reversing, depots), `Trains` (occupancy, blocks, routing, collisions) |
| `TTDRoadVehicle.js` | `RoadVehicle` (lanes, drive-through stops, queueing, level crossings), `RoadVehicles` routing |
| `TTDShip.js`, `TTDAircraft.js` | ships over water tiles; aircraft state machine and `Airports` layouts |
| `TTDWorld.js` | `World`: settings (from `TTD_*` constants), clock and cycles, `moveGoodsToStation`, `income`, engines lifecycle, monthly/quarterly/yearly economy, `Subsidies`, save/load, `createEmpty` |
| `TTDCommands.js` | `Commands`: every player action with TTD cost and checks; `run(world, fn, exec)` is TTD's DC_EXEC pattern |
| `TTDTerrain3D.js` | `TTDTerrain3D` (chunked tile terrain, atlas, sea plane; stands in for the kit's `Terrain3D` for the camera and picking) and `MeshData` (flat-shaded vertex-colour geometry builder) |
| `TTDModels3D.js` | `Models`: procedural buildings, industries, track, roads, stations, depots, bridges, vehicles |
| `TTDRender3D.js` | `TTDRender3D`: chunk content meshes, tree/vehicle/signal instances, overlays, picking |
| `TTDTools.js` | `Tools` helpers (autorail, road drag) and `Tool` (preview + apply for every build tool, query, order picking) |
| `TTDGui.js` | `Gui`: toolbar, build/option bars, the info window views, news, new game dialog — through `UI.get` only |
| `Game.js` | `Game`: owns world, view, camera, gui, tool; clock (pause, fast forward), input, save/load |

## Units and coordinates

- Logic works in tiles and height levels. Tile (0, 0) is the north corner; x grows toward SW,
  y toward SE (TTD). World px: x · `TTD_TILE`, y · `TTD_TILE`, height · `TTD_LEVEL`
  (`TTDRender3D.T`, `.L`). The camera azimuth −135° puts tile (0, 0) at the top of the screen.
- Corners of tile (x, y): N (x, y), W (x+1, y), S (x+1, y+1), E (x, y+1). Edges NE, SE, SW, NW
  are the sides toward Dir.NE…; `Track.MID[d]` is the midpoint of edge d in tile-local space.
- Money is kept in pounds (TTD's base) and shown with `Money.format` in the chosen currency.
- Dates are whole days (`Calendar`); `world.year`, `world.month` are derived.

## Rules that keep the game consistent

1. **The world changes only through Commands** (or the simulation itself). A command checks and
   prices with `exec = false`; `Commands.run` pays and executes. The HUD never writes tile arrays.
2. **Mark what changed.** `map.markDirty(t)` for anything visible on a tile (the renderer rebuilds
   the chunk), `world.railVersion++` for any track or signal change (paths and block caches),
   `world.acceptanceDirty = true` when houses, industries or station parts change.
3. **Heights join at edges.** Track and road connect only when both piece ends are at the same
   height (`Track.edgeZ`, `GameMap.pieceEdgeZ`): flat tiles, inclines along the piece, a foundation
   at the highest corner otherwise. The renderer draws the same surface (`TTDRender3D.surfaceZ`).
4. **Stable ids.** Towns, industries, stations, depots, wormholes and vehicles are indices; a
   removed one becomes `null`, never spliced out (orders and tiles refer to them).
5. **Data, not code, for TTD content.** A new vehicle, industry or house is a record in
   `TTDData.js` (regenerate from OpenTTD tables or add by hand); models pick a look by kind
   (`Models.vehicleKind`, industry id, house name).
6. **HUD by id.** New windows are `Gui.v…()` views returning `{ title, text, info, rows, acts }`;
   the rows and buttons are copies of the `wr`/`wl`/`wb` templates in `UILayout.js` (skill `ui`).
7. **Tunable numbers are `TTD_*` constants** in `Constants.js` with a row in the editor schema
   (`ttd-world`, `ttd-newgame` groups); TTD's own tables stay in `TTDData.js`.

## Adding things

- **A command:** `Commands.name(world, …, exec)` returning `Commands.ok(cost)` / `fail(err)`;
  call it through `Commands.run` (tools use `game.run(fn)`), mark dirty as above.
- **A tool:** a name in `Tool.label`, `preview` and `apply` (TTDTools.js), a button in
  `Gui.barItems`, options in `Gui.renderOpts`.
- **A window:** a `v…` method in `Gui` and an entry in `Gui.render`'s table; open it with
  `gui.open(kind, ref)`.
- **A vehicle class:** subclass `Vehicle` with `tick`, `placeInDepot`, `release`; add it to
  `Vehicles.build`/`fromJSON`, a model kind in `Models.vehicle`, `vehicleKind`.

## Testing

`node tools/check.mjs` runs `tests/ttd-sim.test.mjs`: TTD's payment example, map invariants,
terraform, rating steps, a bus line, a railway, two trains on a signalled loop, save/load. New
rules get a scenario there (`World.createEmpty` gives a flat map; `Towns.found` a town). Visual
changes are checked in the browser pane (skill `verify`); `window.app.game` exposes the world,
renderer and camera for scripted checks.
