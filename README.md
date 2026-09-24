# Transport Tycoon 3D

A 3D remake of **Transport Tycoon Deluxe** that runs in the browser. It is built on
[ArcEngine](https://github.com/xaidan777/ArcEngine), an LLM-oriented Babylon.js game kit.

The rules follow TTD as re-implemented by OpenTTD 0.5.3, the version in `TTD.zip`:

- the cargo payment formula;
- station ratings;
- industry chains and production changes;
- town growth, including sub-tropical desert towns that need food and water;
- the local authority;
- the loan, interest and inflation;
- subsidies and the performance score.

Vehicle, industry and house stats are converted from OpenTTD's own data tables.
[`docs/TTD-mechanics.md`](docs/TTD-mechanics.md) lists every rule with its numbers, what is
implemented, and what is left out.

New games default to the settings in `TTD.zip`'s `openttd.cfg`:

- sub-tropical climate;
- a 128×128 map;
- start in 1941;
- dollars;
- Catalan town names;
- your custom difficulty (£100k max loan at 4 %, high construction costs, mountainous terrain, hostile town councils).

## Run

You only need [Node.js](https://nodejs.org/). There is no `npm install` and no build step.

```
run.bat            # or: node tools/dev-server.mjs    -> http://localhost:8080
editor.bat         # or: node _utils/editor/server.mjs -> http://localhost:8090/_utils/editor/
check.bat          # or: node tools/check.mjs          (type check + tests)
build.bat          # or: node tools/build.mjs          -> dist/*.zip
```

## Play

- **Camera:**
  - drag with the left mouse button (no tool selected) or the middle button to scroll;
  - wheel to zoom;
  - drag with the right button to turn;
  - WASD / arrows to fly, Q/E up and down, R to reset.
- **Keys:** P pauses, F fast-forwards, Esc cancels a tool.
- **Toolbar (TTD's layout):**
  - Game: new, save, load, currency, help.
  - Info: towns, subsidies, stations, finances, company, industries (and funding new ones).
  - Vehicle lists and news.
  - Construction: railway, roads, docks, airports, demolish, landscaping and the "?" land info tool.
- **A first route:**
  1. Railway → Station near a town or industry. The blue area is the catchment.
  2. Track: drag to lay it. Diagonal drags lay diagonal track; a click near a tile corner lays
     a corner piece, drawn as a curve. Track follows TTD's slope rules and ramps up hills.
  3. Depot next to the track.
  4. Click the depot → New vehicles → buy an engine, then add wagons.
  5. In the train window: Go To… → click station A, Go To… → click station B, then Start.
- **Road services:** road + bus or lorry stops + a road depot.
  - Roads work like TTD's. Drag along a row from the half tile you press to the half tile you
    release; a click builds a half. A slanted drag zig-zags along X and Y (TTD's diagonal
    road) and is drawn as a diagonal road; turns are drawn as curves.
  - A drag joins the road it starts or ends at, and crossing a road makes a junction.
  - A drag is built whole or not at all. On slopes the road gets TTD's foundations.
  - Lead a half road into a depot's entrance; depots don't join the road by themselves.
  - Towns grow their own roads the TTD way, along your roads too.
- **Ships:** a dock and a ship depot on the sea.
- **Aircraft:** buy them in an airport's hangar.
- **Signals** split track into blocks, one train per block. Click a signal again to make it one-way.
- **Saves** go to the browser's local storage. The game also autosaves yearly, as in your config.

## Layout

The rules run without 3D: `js/TTDWorld.js` and the other `js/TTD*.js` files. The 3D view is in
`js/TTDRender3D.js`, `js/TTDModels3D.js` and `js/TTDTerrain3D.js`. The HUD is `js/TTDGui.js`,
with every element laid out in `js/UILayout.js` so it can be edited in the editor's UI tab.

`CLAUDE.md` and the skills in `claude/skills/` explain the architecture to coding agents.
`claude/skills/ttd` covers the game code.

`tests/ttd-sim.test.mjs` plays whole services tick by tick in Node: a bus line, a railway, and
two trains on a signalled loop.
