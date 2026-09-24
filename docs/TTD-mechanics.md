# Transport Tycoon Deluxe — rules and mechanics, and what this remake implements

This is the reference the 3D remake is built from. The numbers come from the source of
**OpenTTD 0.5.3** (the same generation as the `openttd.exe` in `TTD.zip`, and a faithful
re-implementation of TTD). The files are `table/engines.h`, `table/build_industry.h`,
`table/town_land.h`, `table/landscape_const.h`, `economy.c`, `station_cmd.c`, `town_cmd.c`,
`industry_cmd.c` and `engine.c`. `js/TTDData.js` is converted from those tables.

Each section ends with a **Remake** note: how the game implements it, and where it is simpler
than TTD.

## 0. Your settings (`TTD.zip` → `openttd.cfg`)

| Setting | Value | Meaning | Constant |
|---|---|---|---|
| `landscape` | desert | Sub-tropical climate | `TTD_CLIMATE = 1` |
| `map_x`, `map_y` | 7, 7 | 128 × 128 tiles | `TTD_MAP_SIZE_LOG2 = 7` |
| `starting_year` / `ending_year` | 1941 / 2051 | | `TTD_START_YEAR`, `TTD_END_YEAR` |
| `currency` / `units` | USD / metric | $ = £ × 2; km/h | `TTD_CURRENCY = 1` |
| `town_name` | catalan | OpenTTD's Catalan name generator | `TTD_TOWN_NAMES = 1` |
| `diff_custom` | `7,0,1,2,100,4,1,2,2,2,0,2,3,1,1,1,1,2` | See the next table | |
| `inflation` | true | Prices +4 %/yr, payments +3 %/yr | `TTD_INFLATION = 1` |
| `gradual_loading` | true | 5 units per car per loading step | `TTD_GRADUAL_LOADING = 1` |
| `modified_catchment` | true | Catchment radius by station part | `TTD_DATA.CATCHMENT` |
| `forbid_90_deg` | true | Trains can't turn 90° on one tile edge | `Track.smooth` |
| `realistic_acceleration` | true | Heavy trains slow on hills | `TTD_TRAIN_ACCEL = 1` |
| `autorenew` | true, 6 months, 100 000 | Old vehicles are replaced at a depot | `TTD_AUTORENEW*` |
| `servint_*` | 150 / 150 / 360 / 100 days | Service intervals | `TTD_SERVICE_DAYS_*` |
| `station_spread` | 12 | Maximum station size | `Commands.joinable` |
| `road_side` | right | Road vehicles keep to one lane | `Track.roadPoint` |

The 18 fields of `diff_custom` decoded (OpenTTD 0.5 `GameDifficulty`):

| # | Field | Value | Meaning |
|---|---|---|---|
| 1 | Max competitors | 7 | AI companies (not in the remake) |
| 2 | Competitor start | 0 | Immediately |
| 3 | Number of towns | 1 | Normal: {11, 23, 46}[n] + rand(0..7), scaled by map area |
| 4 | Number of industries | 2 | Normal |
| 5 | Max loan | 100 | £100,000 |
| 6 | Interest | 4 | 4 % per year (also the inflation rate) |
| 7 | Vehicle running costs | 1 | Medium (×1) |
| 8–9 | Competitor speed, intelligence | 2, 2 | AI only |
| 10 | Breakdowns | 2 | Normal |
| 11 | Subsidy multiplier | 0 | ×1.5 |
| 12 | Construction costs | 2 | High: ×9/8 on building **and** buying vehicles |
| 13 | Terrain | 3 | Mountainous |
| 14 | Sea / lakes | 1 | Low |
| 15 | Economy | 1 | Variable (recessions, production swings) |
| 16 | Line reverse | 1 | Trains reverse only at the end of a line |
| 17 | Disasters | 1 | On |
| 18 | Town council | 2 | Hostile |

## 1. Time

- 1 day = 74 ticks. A tick is 30 ms in TTD, so a day is about 2.2 s and a year about 13.5 min.
- Cycles:
  - **185 ticks (2.5 days):** station ratings update; cargo in vehicles ages by one "day".
  - **256 ticks:** industries produce; every tile is visited once by the tile loop (houses make passengers and mail).
  - **70 ticks:** one town growth tick.
- Daily: running costs, reliability decay, breakdown checks.
- Monthly: loan interest, property maintenance, inflation, industry changes, subsidies, town growth rates.
- Quarterly: performance rating, bankruptcy check.
- Yearly: finances roll over, vehicle profits reset.

**Remake:** these are the same cycles (`World.tick`). `TTD_TICK_MS = 27` and fast forward is ×`TTD_FAST_FORWARD`.

## 2. Map and terrain

- Tiles have 4 corners with whole height levels 0–15. Neighbouring corners differ by at most one level.
- A tile is one of:
  - flat;
  - an incline (one side raised);
  - a 1- or 3-corner slope;
  - steep (the diagonal differs by two).
- Sea level is 0.
- The sub-tropical climate splits land into desert, rainforest and normal zones.
- Building on slopes (the "build on slopes" patch) puts a foundation under anything that is not
  a straight piece of track or road along an incline.
- Terraforming one corner costs £250 and drags the neighbouring corners along.

**Remake:** `GameMap` (`js/TTDMap.js`) has corner heights, TTD's slope bits and foundations.
Track and road only connect across an edge when both ends are at the same height.
The generator is simplex noise shaped into levels, the sea and desert/rainforest zones.
Land lowered to sea level next to water floods.

## 3. Cargo and payment

`income = dist × f × amount × rate >> 21`:

- `dist` is the Manhattan distance between the source and destination stations.
- The time factor `f` is 255 for fast deliveries. After `days1` it falls by 1 per "day", and
  after `days1 + days2` by 2 per day, down to a floor of 31.
- A "day" here is 2.5 real days.

| Temperate | Rate | days1 | days2 | Sub-tropical | Rate | days1 | days2 |
|---|---|---|---|---|---|---|---|
| Passengers | 3185 | 0 | 24 | Passengers | 3185 | 0 | 24 |
| Coal | 5916 | 7 | 255 | Rubber | 4437 | 2 | 20 |
| Mail | 4550 | 20 | 90 | Mail | 4550 | 20 | 90 |
| Oil | 4437 | 25 | 255 | Oil | 4892 | 25 | 255 |
| Livestock | 4322 | 4 | 18 | Fruit | 4209 | 0 | 15 |
| Goods | 6144 | 5 | 28 | Goods | 6144 | 5 | 28 |
| Grain | 4778 | 4 | 40 | Maize | 4322 | 4 | 40 |
| Wood | 5005 | 15 | 255 | Wood | 7964 | 15 | 255 |
| Iron Ore | 5120 | 9 | 255 | Copper Ore | 4892 | 12 | 255 |
| Steel | 5688 | 7 | 255 | Water | 4664 | 20 | 80 |
| Valuables | 7509 | 1 | 32 | Diamonds | 5802 | 10 | 255 |
|  |  |  |  | Food | 5688 | 0 | 30 |

For example, 100 t of coal carried 50 tiles in 8 "days" pays £3,582.
`tests/ttd-sim.test.mjs` checks this exact number.

**Remake:** exact (`World.income`). Waiting and loaded cargo are packets that keep their source
station and age, so a transfer keeps the whole trip for the final payment.

## 4. Industries

- **Raw industries** add `rate` of their product every 256 ticks, about rate × 8.8 per month.
- **Secondary industries** turn delivered cargo into their product 1:1. Cargo goes to the
  nearest accepting producer within 40 tiles of the station.
- **Hand-over to stations:** only the two best-rated stations around an industry get anything.
  - One station: it receives `amount × rating / 256 + 1`.
  - Two stations: the second one's rating is halved first, then the cargo is split by rating.
- **Monthly changes (original economy):** one random industry has a 1-in-3 chance of changing.
  - It doubles with a 2/3 chance if more than 60 % was transported last month, otherwise with 1/3.
  - Otherwise it halves. At the lowest level it closes.
  - Processing industries close after 5 years with no production.
  - New industries appear with a 3 % chance per month.

Sub-tropical chains:

| Source | Cargo | Destination |
|---|---|---|
| Copper ore mine | copper ore | factory |
| Rubber plantation | rubber | factory |
| Lumber mill | wood | factory |
| Factory | goods | towns |
| Fruit plantation | fruit | food processing plant |
| Farm | maize | food processing plant |
| Food processing plant | food | towns |
| Oil wells | oil | oil refinery |
| Oil refinery | goods | towns |
| Water supply | water | water tower |
| Diamond mine | diamonds | bank |

Sub-tropical placement rules:

- Water supply: desert only.
- Plantations, farm and factory: not in the desert.
- Lumber mill: rainforest, and only when funded (it fells trees for 45 t of wood each).
- Oil refinery: near the map edge.
- Water tower and bank: inside a town.

Temperate chains:

| Source | Cargo | Destination |
|---|---|---|
| Coal mine | coal | power station |
| Forest | wood | sawmill |
| Farm | grain and livestock | factory |
| Iron ore mine | iron ore | steel mill |
| Steel mill | steel | factory |
| Oil wells | oil | refinery |
| Sawmill, factory, refinery | goods | towns |
| Bank | valuables | bank |

**Remake:** all temperate and sub-tropical industry types with TTD's layouts, production rates,
conflicting types and placement rules (`js/TTDIndustry.js`). Industries can also be funded
from the industry list. Oil rigs (sea platforms) are left out.

## 5. Stations

- **Catchment (modified):** rail 4, bus and lorry stops 3, small airport 4, dock 5.
- **Acceptance:** a cargo is accepted when the 1/8 values of the houses and industry tiles in
  the catchment add up to 8.
- **Rating** starts at 175/255 (69 %) and is recomputed every 185 ticks, moving at most 2 points per update:

| Part | Points |
|---|---|
| Last vehicle's max speed | (speed − 85) / 4 |
| Age of the last vehicle | +33 new, +20 at 1 year, +10 at 2 years |
| Statue in the town | +26 |
| Days since the last pickup | ≤ 3: +130, ≤ 6: +95, ≤ 12: +50, ≤ 21: +25 |
| Cargo waiting | ≤ 100: +40 … > 1500: −90 |

- **Cargo loss:** at a rating of 64 or less with 200+ waiting, 1–32 units are lost. At 127 or
  less, a few units may be lost.

**Remake:** exact (`Station.updateRatings`, `World.moveGoodsToStation`). Station names are
the town's name plus TTD's suffixes (Central, North, Halt…). Parts built next to your station
join it, up to a spread of 12.

## 6. Towns

- **Houses:** 110 TTD building types with population, mail, the years they are built in, the
  town zone (0 = edge … 4 = centre) and sizes of 1×1, 2×1, 1×2 or 2×2 tiles.
- **Production:** each house tile, every 256 ticks, makes `r/8 + 1` passengers when a random
  byte `r` is below its population, and mail the same way.
- **Growth:** the number of stations served in the last ~50 days sets the growth pace (TTD's
  `_grow_count_values`, faster while "fund new buildings" is active).
  - A town with no service grows only by a 1-in-12 chance each month.
  - **Desert towns** with more than 60 people only grow if food *and* water were delivered last month.
- **Local authority rating** (−1000 to 1000, starts at 500):
  - Felling a tree costs 35, demolishing a house costs its penalty.
  - Each active station earns +12 a month; each station without service loses 15.
- **Actions:** advertising (small, medium, large), road reconstruction, statue, fund new
  buildings, exclusive rights, bribe (1 in 15 gets caught).
- A **hostile** council refuses demolition below 112 points and new stations at "Very Poor".

**Remake:** implemented (`js/TTDTown.js`). The road network grows on a grid of 3 or 4 tiles
instead of TTD's organic layouts.

## 7. Vehicles

Vehicles are TTD's full list for the two climates, 1920–2051 (`TTDData.ENGINES`), with TTD's
prices, running costs, speeds, power, weight, capacity and lifespans.

- **Sub-tropical has no locomotive until the Wills 2-8-0** (around 1944). In your 1941 start,
  road vehicles, ships and aircraft come first, as in the real game.
- **Reliability:** each model rolls a start (48–73 %), a maximum (75–100 %) and a final value
  (25–50 %) along a lifecycle curve. Vehicles lose reliability every day and are reset by a
  depot service.
- **Breakdowns:** checked daily against TTD's `_breakdown_chance` table.
- **Autorenew** replaces vehicles near the end of their life.
- **Speeds:** trains accelerate by power/weight and slow on hills. Planes fly at TTD's quarter speed.
- **Orders:** go to station, with full load, unload, transfer or non-stop; go to depot, service or stop.
- **Loading** (gradual): unload first, paying on delivery. Then load 5 units per car per step
  (10 for ships, 20 for aircraft) every 40 / 20 / 10 / 20 ticks.

**Remake:**

- **Trains** follow A* paths and don't turn 90°. They reverse at the end of a line and stop at
  the far end of the platform.
- **Block signals:** a train may pass a signal only while the block behind it is empty.
  Without signals trains can crash, as in TTD.
- **Road vehicles** use drive-through stops, queue behind each other and wait at level
  crossings. A train hitting a road vehicle on a crossing destroys it.
- **Ships** sail on water tiles to the water in front of a dock.
- **Aircraft** taxi, take off, cruise, approach and land. They need a free terminal and hold
  above the airport otherwise. Fast jets can crash on a small airport.

## 8. Finances

- **Start:** £100,000 cash and a £100,000 loan. The loan changes in £10,000 steps.
- **Interest:** loan × rate / 12, charged monthly.
- **Property maintenance:** £50 per station part per month.
- **Other:** £25 a month.
- **Finance categories:** TTD's 13, kept for this year and the last two.
- **Company value:** £2,500 per station part + vehicle values + money − loan.
- **Performance rating** (TTD's 9 parts, 1000 points) is recalculated each quarter. The final
  score in the end year sets your title.
- **Bankruptcy:** three quarters with negative money give warnings; the fourth ends the game.
- **Recessions** (variable economy) halve production for a year.

**Remake:** implemented (`js/TTDWorld.js`, `js/TTDCompany.js`).

## 9. Subsidies

- Each month there is a 1 in 4 chance of a new offer, with at most 8 at once.
- Possible offers:
  - passengers between towns of 400+ people up to 70 tiles apart;
  - freight from a poorly served industry to an accepting industry;
  - goods or food to a town of 900+ people.
- The first delivery wins the subsidy. The stations must be within 9 tiles of the source and
  of the destination.
- A won subsidy pays ×1.5 / ×2 / ×3 / ×4 for a year. Unclaimed offers expire after 12 months.

**Remake:** implemented (`Subsidies` in `js/TTDWorld.js`).

## 10. Construction prices (Medium; ×9/8 with your High costs)

| Item | Price |
|---|---|
| Rail track | £100 per piece |
| Road | £95 per half |
| Signals | £65 |
| Train depot | £600 |
| Road depot | £500 |
| Ship depot | £700 |
| Rail station | (platforms × 200 + 180) × length |
| Bus or lorry stop | £200 |
| Dock | £350 |
| Airport | £600 per tile |
| Clear grass / rough / rocks / fields | £20 / 40 / 200 / 500 |
| Trees | £20 × (count + 1), ×4 for rainforest trees and cacti |
| Demolish a house | £1600 × its factor / 256 |
| Bridge | length factor × £275 × type price / 256 |
| Tunnel | £450 per entrance, ×1.125 for each tile |

## What the remake leaves out

- **AI competitors:** the remake is single-player.
- **Oil rigs and sub-arctic/toyland climates:** the data is there, but they aren't used.
- **Pre-signals and path signals:** only block signals (one-way and two-way) are implemented.
- **Intermediate stops:** trains without "non-stop" orders don't halt at stations they pass through.
- **Disasters.**
- **Graphs, the league table and the minimap.**
- **Refitting, shares and company buyouts.**
- **Other:** canals, buoys and waypoints.
