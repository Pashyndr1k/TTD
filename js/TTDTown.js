// TTDTown.js — towns of the TTD remake: names (TTD's English and OpenTTD's Catalan generators),
// founding, houses (TTDData.HOUSES with TTD's zones, years and sizes), road growth, passenger and
// mail production per house, the growth rate from served stations, the desert rule (sub-tropical
// towns in the desert need food and water) and the local authority rating per company.
//
// Houses on the map: type T_HOUSE, sub = house (part) id, obj = the base tile of the building,
// density = construction stage 0..3 (3 — finished), town = town index.

/** @satisfies {Record<string, any>} */
const TownNames = {
    /** SeedChance / SeedModChance / SeedChanceBias of TTD's namegen.c. */
    chance(shift, max, seed) { return Math.floor((((seed >>> shift) & 0xffff) * max) / 65536); },
    modChance(shift, max, seed) { return ((seed >>> shift) >>> 0) % max; },
    bias(shift, max, seed, bias) { return TownNames.chance(shift, max + bias, seed) - bias; },

    english(seed) {
        const N = TTDData.TOWN_NAMES;
        let s = '';
        let i = TownNames.bias(0, N.original_english_1.length, seed, 50);
        if (i >= 0) s += N.original_english_1[i];
        s += N.original_english_2[TownNames.chance(4, N.original_english_2.length, seed)];
        s += N.original_english_3[TownNames.chance(7, N.original_english_3.length, seed)];
        s += N.original_english_4[TownNames.chance(10, N.original_english_4.length, seed)];
        s += N.original_english_5[TownNames.chance(13, N.original_english_5.length, seed)];
        i = TownNames.bias(15, N.original_english_6.length, seed, 60);
        if (i >= 0) s += N.original_english_6[i];
        if (s[0] === 'C' && (s[1] === 'e' || s[1] === 'i')) s = 'K' + s.slice(1);
        const repl = [['Cunt', 'East'], ['Slag', 'Pits'], ['Slut', 'Edin'], ['Drar', 'Quar'], ['Dreh', 'Bash'],
            ['Frar', 'Shor'], ['Grar', 'Aber'], ['Brar', 'Over'], ['Wrar', 'Inve']];
        for (const [a, b] of repl) if (s.startsWith(a)) s = b + s.slice(4);
        return s;
    },

    catalan(seed) {
        const N = TTDData.TOWN_NAMES, M = TownNames.modChance;
        if (M(0, 3, seed) === 0) return N.catalan_real[M(4, N.catalan_real.length, seed)];
        let s = '';
        if (M(0, 2, seed) === 0) s += N.catalan_pref[M(11, N.catalan_pref.length, seed)];
        if (TownNames.chance(0, 2, seed) === 0) {
            s += N.catalan_1m[M(4, N.catalan_1m.length, seed)] + N.catalan_2m[M(11, N.catalan_2m.length, seed)];
        } else {
            s += N.catalan_1f[M(4, N.catalan_1f.length, seed)] + N.catalan_2f[M(11, N.catalan_2f.length, seed)];
        }
        if (M(15, 5, seed) === 0) {
            if (M(5, 2, seed) === 0) s += N.catalan_3[M(4, N.catalan_3.length, seed)];
            else s += N.catalan_river1[M(4, N.catalan_river1.length, seed)];
        }
        return s;
    },

    make(style, seed) { return style === 1 ? TownNames.catalan(seed) : TownNames.english(seed); },
};

class Town {
    /** @param {number} id @param {number} tile centre tile @param {string} name */
    constructor(id, tile, name) {
        this.id = id;
        this.xy = tile;
        this.name = name;
        this.population = 0;
        this.numHouses = 0;
        /** Squared radii of the five town zones (TTD's t->radius). */
        this.radius = [4, 0, 0, 0, 0];
        this.growthRate = 250;     // town ticks (70 game ticks) between growth attempts
        this.growCounter = 0;
        this.fundMonths = 0;
        this.roadWorks = 0;
        this.hasChurch = false;
        this.hasStadium = false;
        /** Company index -> rating −1000..1000 (absent — no dealings yet). */
        this.ratings = {};
        this.statues = {};          // company -> true
        this.exclusive = -1;        // company with exclusive transport rights
        this.exclusiveMonths = 0;
        this.unwanted = {};         // company -> months banned after a failed bribe
        // Monthly statistics (TTD's max/act pass and mail; received food/water).
        this.paxMax = 0; this.paxAct = 0; this.lastPaxMax = 0; this.lastPaxAct = 0;
        this.mailMax = 0; this.mailAct = 0; this.lastMailMax = 0; this.lastMailAct = 0;
        this.food = 0; this.water = 0; this.lastFood = 0; this.lastWater = 0;
        this.goods = 0; this.lastGoods = 0;
        this.layout = 3;            // road grid spacing
    }

    rating(company) { return this.ratings[company] != null ? this.ratings[company] : Town.RATING_INITIAL; }

    changeRating(company, delta, min, max) {
        const cur = this.rating(company);
        let v = cur + delta;
        if (min != null && delta < 0) v = Math.max(Math.min(cur, min), v);
        if (max != null && delta > 0) v = Math.min(Math.max(cur, max), v);
        this.ratings[company] = IMath.clamp(v, -1000, 1000);
    }

    static ratingName(r) {
        if (r <= -400) return 'Appalling';
        if (r <= -200) return 'Very Poor';
        if (r <= 0) return 'Poor';
        if (r <= 200) return 'Mediocre';
        if (r <= 400) return 'Good';
        if (r <= 600) return 'Very Good';
        if (r <= 800) return 'Excellent';
        return 'Outstanding';
    }

    /** TTD's UpdateTownRadius. */
    updateRadius() {
        const T = Town.RADIUS_DATA;
        if (this.numHouses < 92) {
            this.radius = T[(this.numHouses / 4) | 0].slice();
        } else {
            const mass = (this.numHouses / 8) | 0;
            this.radius = [mass * mass, mass * 7, 0, mass * 4, mass * 3];
        }
    }

    /** Town zone of a tile: 0 (edge) .. 4 (centre). */
    zoneOf(map, t) {
        const dx = map.tx(t) - map.tx(this.xy), dy = map.ty(t) - map.ty(this.xy);
        const d = dx * dx + dy * dy;
        if (this.fundMonths && d <= 25) return 4;
        let z = 0;
        for (let i = 0; i < 5; i++) if (d < this.radius[i]) z = i;
        return z;
    }

    toJSON() { return Object.assign({}, this); }

    static fromJSON(o) {
        const t = new Town(o.id, o.xy, o.name);
        Object.assign(t, o);
        return t;
    }
}

Town.RATING_INITIAL = 500;
Town.TICKS = 70;   // game ticks per town tick
Town.RADIUS_DATA = [
    [4, 0, 0, 0, 0], [16, 0, 0, 0, 0], [25, 0, 0, 0, 0], [36, 0, 0, 0, 0], [49, 0, 4, 0, 0], [64, 0, 4, 0, 0],
    [64, 0, 9, 0, 1], [64, 0, 9, 0, 4], [64, 0, 16, 0, 4], [81, 0, 16, 0, 4], [81, 0, 16, 0, 4], [81, 0, 25, 0, 9],
    [81, 36, 25, 0, 9], [81, 36, 25, 16, 9], [81, 49, 0, 25, 9], [81, 64, 0, 25, 9], [81, 64, 0, 36, 9],
    [81, 64, 0, 36, 16], [100, 81, 0, 49, 16], [100, 81, 0, 49, 25], [121, 81, 0, 49, 25], [121, 81, 0, 49, 25],
    [121, 81, 0, 49, 36],
];
/** Growth: town ticks between attempts by number of served stations (TTD's _grow_count_values). */
Town.GROW_FUNDED = [60, 60, 60, 50, 40, 30];
Town.GROW_NORMAL = [160, 210, 150, 110, 80, 50];

/**
 * Town logic that needs the world: founding, growth, houses, production. Kept apart from the
 * Town record so saves stay plain data.
 */
/** @satisfies {Record<string, any>} */
const Towns = {
    /** House ids buildable in this climate (base parts only — a 2x2 stadium is one entry). */
    houseList(climate) {
        const bit = climate === 1 ? 0x4000 : 0x1000;
        return TTDData.HOUSES.filter(h => (h.flags & bit) && (h.flags & 0x1f));
    },

    /** Tiles of a house by its base id: [[dx, dy, partId], …]. */
    houseParts(id) {
        const e = TTDData.HOUSES[id].extra;
        if (e & 0x10) return [[0, 0, id], [0, 1, id + 1], [1, 0, id + 2], [1, 1, id + 3]];
        if (e & 0x04) return [[0, 0, id], [1, 0, id + 1]];
        if (e & 0x08) return [[0, 0, id], [0, 1, id + 1]];
        return [[0, 0, id]];
    },

    /** Found a town near tile t (does nothing if the land is unsuitable). */
    found(world, t, size) {
        const map = world.map;
        if (!Towns.siteOk(world, t)) return null;
        const id = world.towns.length;
        const seed = world.rng.next();
        let name = TownNames.make(world.settings.townNames, seed);
        for (let k = 0; k < 20 && world.towns.some(o => o.name === name); k++) name = TownNames.make(world.settings.townNames, world.rng.next());
        const town = new Town(id, t, name);
        town.layout = world.rng.chance(1, 2) ? 3 : 4;
        world.towns.push(town);
        // Centre crossroads.
        Towns.buildRoad(world, town, t, 15);
        const target = size || world.rng.range(8, 23);
        for (let i = 0; i < target * 4 && town.numHouses < target * 2; i++) Towns.grow(world, town, true);
        town.growthRate = 250;
        return town;
    },

    /** A town centre needs flat or gentle dry land away from other towns and the map edge. */
    siteOk(world, t) {
        const map = world.map, x = map.tx(t), y = map.ty(t);
        if (x < 6 || y < 6 || x > map.W - 7 || y > map.H - 7) return false;
        if (!map.isClearable(t) || map.slope(t) & GameMap.SLOPE_STEEP) return false;
        for (const o of world.towns) if (IMath.manhattan(x, y, map.tx(o.xy), map.ty(o.xy)) < 20) return false;
        let land = 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
            const n = map.idx(x + dx, y + dy);
            if (map.type[n] !== GameMap.T_WATER && !(map.slope(n) & GameMap.SLOPE_STEEP)) land++;
        }
        return land >= 40;
    },

    /** Put town road bits on a tile (merging with what is there). Returns false if impossible. */
    buildRoad(world, town, t, bits) {
        const map = world.map;
        const k = map.type[t];
        if (k === GameMap.T_ROAD && map.sub[t] === 0) {
            map.road[t] |= bits;
            map.markDirty(t);
            return true;
        }
        if (!map.isClearable(t) || map.slope(t) & GameMap.SLOPE_STEEP) return false;
        if (map.ground[t] === GameMap.G_FIELDS) return false;
        map.setClear(t, map.ground[t] === GameMap.G_DESERT ? GameMap.G_DESERT : GameMap.G_GRASS);
        map.type[t] = GameMap.T_ROAD;
        map.road[t] = bits;
        map.roadOwner[t] = GameMap.OWNER_TOWN;
        map.owner[t] = GameMap.OWNER_TOWN;
        map.town[t] = town.id;
        map.markDirty(t);
        return true;
    },

    /** Is tile t on this town's road grid lines? */
    onGrid(map, town, t) {
        const dx = map.tx(t) - map.tx(town.xy), dy = map.ty(t) - map.ty(town.xy), g = town.layout;
        return ((dx % g) + g) % g === 0 || ((dy % g) + g) % g === 0;
    },

    /**
     * One growth attempt (TTD's GrowTown): pick a town road tile near the centre, look at a random
     * neighbour: extend a road along the grid or put a house next to the road.
     */
    grow(world, town, generating) {
        const map = world.map, rng = world.rng;
        const cx = map.tx(town.xy), cy = map.ty(town.xy);
        const reach = 2 + Math.floor(Math.sqrt(town.numHouses + 4) * 1.6);
        // The town's own road tiles near the centre are where it grows from.
        const roads = [];
        for (let y = Math.max(1, cy - reach); y <= Math.min(map.H - 2, cy + reach); y++) {
            for (let x = Math.max(1, cx - reach); x <= Math.min(map.W - 2, cx + reach); x++) {
                const t = y * map.W + x;
                if (map.type[t] === GameMap.T_ROAD && map.town[t] === town.id && map.sub[t] === 0) roads.push(t);
            }
        }
        if (!roads.length) return false;
        for (let attempt = 0; attempt < 16; attempt++) {
            const t = rng.pick(roads);
            const x = map.tx(t), y = map.ty(t);
            const d = rng.int(4);
            const nx = x + Dir.DX[d], ny = y + Dir.DY[d];
            if (!map.valid(nx, ny)) continue;
            const n = map.idx(nx, ny);
            if (map.over[n] >= 0) continue;
            if (map.type[n] === GameMap.T_ROAD) {
                // Join neighbouring town roads so blocks close up.
                if (map.town[n] === town.id && map.sub[n] === 0 &&
                    Towns.onGrid(map, town, t) && Towns.onGrid(map, town, n)) {
                    const a = 1 << d, b = 1 << Dir.reverse(d);
                    if (!(map.road[t] & a)) {
                        const ra = map.road[t], rb = map.road[n];
                        map.road[t] |= a; map.road[n] |= b;
                        if (Track.roadEdgeZ(map, t, d) !== Track.roadEdgeZ(map, n, Dir.reverse(d))) { map.road[t] = ra; map.road[n] = rb; continue; }
                        map.markDirty(t); map.markDirty(n);
                        return true;
                    }
                }
                continue;
            }
            if (!map.isClearable(n)) continue;
            if (Towns.onGrid(map, town, n) && (map.road[t] & (1 << d) || Towns.onGrid(map, town, t))) {
                // Extend the grid road; it must meet at equal heights.
                if (map.slope(n) & GameMap.SLOPE_STEEP) continue;
                const a = 1 << d, b = 1 << Dir.reverse(d);
                const before = map.road[t];
                const ground = map.ground[n], type = map.type[n], trees = map.treeCount[n], ttype = map.treeType[n];
                map.road[t] |= a;
                if (!Towns.buildRoad(world, town, n, b)) { map.road[t] = before; continue; }
                if (Track.roadEdgeZ(map, t, d) !== Track.roadEdgeZ(map, n, Dir.reverse(d))) {
                    // Heights do not meet: undo.
                    map.road[t] = before;
                    map.setClear(n, ground);
                    if (type === GameMap.T_TREES) { map.type[n] = type; map.treeCount[n] = trees; map.treeType[n] = ttype; }
                    continue;
                }
                map.markDirty(t);
                return true;
            }
            if (Towns.onGrid(map, town, n)) continue;
            if (Towns.buildHouse(world, town, n, generating)) return true;
        }
        return false;
    },

    /** Pick and build a house on tile t (TTD's DoBuildTownHouse). */
    buildHouse(world, town, t, generating) {
        const map = world.map, rng = world.rng;
        if (!map.isClearable(t) || (map.slope(t) & GameMap.SLOPE_STEEP)) return false;
        if (map.ground[t] === GameMap.G_FIELDS) return false;
        const zone = town.zoneOf(map, t);
        const bit = world.climate === 1 ? 0x4000 : 0x1000;
        const mask = (1 << zone) | bit;
        const year = world.year;
        const list = TTDData.HOUSES.filter(h => (~h.flags & mask) === 0 && year >= h.minYear && year <= h.maxYear);
        if (!list.length) return false;
        for (let tries = 0; tries < 8; tries++) {
            const h = rng.pick(list);
            if ((h.name === 'Church' && town.hasChurch) || (h.name === 'Stadium' && town.hasStadium)) continue;
            if ((h.extra & 0x12) && !map.isFlat(t)) continue;
            const parts = Towns.houseParts(h.id);
            // Multi-tile: all tiles clearable, same build height, not on the grid.
            const z = map.buildZ(t);
            let ok = true;
            for (const [dx, dy] of parts) {
                const x = map.tx(t) + dx, y = map.ty(t) + dy;
                if (!map.valid(x, y)) { ok = false; break; }
                const p = map.idx(x, y);
                if (!map.isClearable(p) || map.buildZ(p) !== z || Towns.onGrid(map, town, p) || (map.slope(p) & GameMap.SLOPE_STEEP)) { ok = false; break; }
            }
            if (!ok) continue;
            const stage = generating ? (rng.chance(1, 7) ? rng.int(3) : 3) : 0;
            for (const [dx, dy, part] of parts) {
                const p = map.idx(map.tx(t) + dx, map.ty(t) + dy);
                map.setClear(p, map.ground[p] === GameMap.G_DESERT ? GameMap.G_DESERT : GameMap.G_GRASS);
                map.type[p] = GameMap.T_HOUSE;
                map.sub[p] = part;
                map.obj[p] = t;
                map.density[p] = stage;
                map.town[p] = town.id;
                map.owner[p] = GameMap.OWNER_TOWN;
                map.markDirty(p);
            }
            if (h.name === 'Church') town.hasChurch = true;
            if (h.name === 'Stadium') town.hasStadium = true;
            town.numHouses++;
            if (stage === 3) for (const [, , part] of parts) town.population += TTDData.HOUSES[part].pop;
            town.updateRadius();
            return true;
        }
        return false;
    },

    /** Remove the whole building a house tile belongs to. */
    removeHouse(world, t) {
        const map = world.map;
        const base = map.obj[t] >= 0 ? map.obj[t] : t;
        const id = map.sub[base];
        const town = world.towns[map.town[base]];
        const done = map.density[base] === 3;
        for (const [dx, dy, part] of Towns.houseParts(id)) {
            const p = map.idx(map.tx(base) + dx, map.ty(base) + dy);
            if (map.type[p] !== GameMap.T_HOUSE) continue;
            if (town && done) town.population -= TTDData.HOUSES[part].pop;
            map.setClear(p, GameMap.G_GRASS);
            map.density[p] = 3;
        }
        if (town) {
            town.numHouses = Math.max(0, town.numHouses - 1);
            if (TTDData.HOUSES[id].name === 'Church') town.hasChurch = false;
            if (TTDData.HOUSES[id].name === 'Stadium') town.hasStadium = false;
            town.updateRadius();
        }
    },

    /**
     * House tile loop (every 256 ticks per tile, TTD's TileLoop_Town): construction progress,
     * passengers and mail to nearby stations.
     */
    tileLoop(world, t) {
        const map = world.map, rng = world.rng;
        const town = world.towns[map.town[t]];
        if (!town) return;
        const part = TTDData.HOUSES[map.sub[t]];
        if (map.density[t] < 3) {
            if (rng.chance(1, 2)) {
                map.density[t]++;
                if (map.density[t] === 3) town.population += part.pop;
                map.markDirty(t);
            }
            return;
        }
        const r = rng.next();
        const recession = world.economy.recession > 0;
        const pop = part.pop, mail = part.mail;
        if ((r & 0xff) < pop) {
            let amt = ((r & 0xff) >> 3) + 1;
            if (recession) amt = (amt + 1) >> 1;
            town.paxMax += amt;
            town.paxAct += world.moveGoodsToStation(world.cargoSlot('passengers'), amt, t, 1, 1, { town: town.id });
        }
        if (((r >>> 8) & 0xff) < mail) {
            let amt = (((r >>> 8) & 0xff) >> 3) + 1;
            if (recession) amt = (amt + 1) >> 1;
            town.mailMax += amt;
            town.mailAct += world.moveGoodsToStation(world.cargoSlot('mail'), amt, t, 1, 1, { town: town.id });
        }
    },

    /** Town tick (every 70 game ticks): count down to the next growth attempt. */
    tick(world, town) {
        if (town.growCounter > 0) { town.growCounter--; return; }
        town.growCounter = town.growthRate;
        Towns.grow(world, town, false);
    },

    /** Monthly (TTD's UpdateTownGrowRate / UpdateTownRating / UpdateTownAmounts). */
    monthly(world, town) {
        const map = world.map;
        // Served stations within the town radius (loaded or unloaded recently).
        let n = 0;
        for (const st of world.stations) {
            if (!st) continue;
            const dx = map.tx(st.xy) - map.tx(town.xy), dy = map.ty(st.xy) - map.ty(town.xy);
            if (dx * dx + dy * dy > town.radius[0]) continue;
            if (st.recentlyServed()) n++;
            // Rating: +12 for an active station, −15 for one without service.
            if (st.owner >= 0) town.changeRating(st.owner, st.recentlyServed() ? 12 : -15);
        }
        for (const c in town.ratings) if (town.ratings[c] <= 200) town.changeRating(Number(c), 5);
        let m;
        if (town.fundMonths > 0) { m = Town.GROW_FUNDED[Math.min(n, 5)]; town.fundMonths--; }
        else {
            m = Town.GROW_NORMAL[Math.min(n, 5)];
            if (n === 0 && !world.rng.chance(1, 12)) m = 0;
        }
        // Sub-tropical desert towns grow only with food and water delivered last month.
        if (world.climate === 1 && map.zone[town.xy] === GameMap.Z_DESERT && town.population > 60 && (town.food === 0 || town.water === 0)) m = 0;
        town.growthRate = m ? Math.max(1, Math.floor(m / ((town.numHouses / 50 | 0) + 1))) : 1 << 30;
        if (town.growCounter > town.growthRate) town.growCounter = town.growthRate;
        // Month statistics.
        town.lastPaxMax = town.paxMax; town.lastPaxAct = town.paxAct;
        town.lastMailMax = town.mailMax; town.lastMailAct = town.mailAct;
        town.paxMax = town.paxAct = town.mailMax = town.mailAct = 0;
        town.lastFood = town.food; town.lastWater = town.water; town.lastGoods = town.goods;
        town.food = town.water = town.goods = 0;
        if (town.exclusiveMonths > 0 && --town.exclusiveMonths === 0) town.exclusive = -1;
        if (town.roadWorks > 0) town.roadWorks--;
        for (const c in town.unwanted) if (town.unwanted[c] > 0) town.unwanted[c]--;
    },

    /** Local authority actions: cost factor (× buildIndustry / 256) and effect (TTD's _town_action_costs). */
    ACTIONS: [
        { name: 'Advertising campaign (small)', factor: 2 },
        { name: 'Advertising campaign (medium)', factor: 4 },
        { name: 'Advertising campaign (large)', factor: 9 },
        { name: 'Fund local road reconstruction', factor: 35 },
        { name: 'Build statue of company owner', factor: 48 },
        { name: 'Fund new buildings', factor: 53 },
        { name: 'Buy exclusive transport rights', factor: 117 },
        { name: 'Bribe the local authority', factor: 175 },
    ],
};
