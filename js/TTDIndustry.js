// TTDIndustry.js — industries of the TTD remake (TTDData.INDUSTRIES = TTD's _industry_specs):
// placement rules (distance to industries of the same and "conflicting" types, desert /
// rainforest / map-edge checks, banks and water towers inside towns), production every 256
// ticks, hand-over to the two best-rated stations around, secondary production from delivered
// cargo (1:1), the monthly production changes of the original economy and closures.
//
// On the map: type T_INDUSTRY, obj = industry index, sub = tile number inside the layout.

class Industry {
    constructor(id, type, xy, w, h) {
        this.id = id;
        this.type = type;
        this.xy = xy;             // top-left (north) tile
        this.w = w;
        this.h = h;
        this.town = -1;
        this.layout = 0;
        this.tiles = [];
        this.prodLevel = 16;      // TTD's prod_level: 4 (closing) .. 128, 16 — normal
        /** Produced cargos: { slot, rate, waiting, thisMonth, lastMonth, movedThis, movedLast, pctLast }. */
        this.produced = [];
        this.accepts = [];
        this.incoming = 0;        // delivered cargo waiting to be processed (TTD's cargo_waiting)
        this.founded = 0;
        this.lastProdYear = 0;
        this.closing = false;
        this.deliveredThis = 0;
        this.deliveredLast = 0;
    }

    get spec() { return TTDData.INDUSTRIES[this.type]; }

    toJSON() { return Object.assign({}, this); }

    static fromJSON(o) {
        const i = new Industry(o.id, o.type, o.xy, o.w, o.h);
        Object.assign(i, o);
        return i;
    }
}

/** @satisfies {Record<string, any>} */
const Industries = {
    /** Industry types that exist in a climate. */
    typesFor(climate) {
        const bit = climate === 1 ? 4 : 1;
        return TTDData.INDUSTRIES.filter(s => s && (s.climates & bit)).map(s => s.id);
    },

    /** Production rate of a spec cargo scaled by the production level. */
    rateOf(ind, k) {
        const base = ind.spec.produces[k] ? ind.spec.produces[k][1] : 0;
        return Math.max(1, Math.min(255, Math.round(base * ind.prodLevel / 16)));
    },

    /** Build height of an industry: all its tiles share one foundation height. */
    baseZ(world, ind) {
        if (ind._z != null) return ind._z;
        let z = 0;
        for (const t of ind.tiles) z = Math.max(z, world.map.buildZ(t));
        ind._z = z;
        return z;
    },

    name(world, ind) {
        const town = world.towns[ind.town];
        return (town ? town.name + ' ' : '') + ind.spec.name;
    },

    /** Is the spec allowed at the top-left tile t with layout [w, h]? Returns the build height or -1. */
    check(world, type, t, w, h, funding) {
        const map = world.map, spec = TTDData.INDUSTRIES[type];
        const x = map.tx(t), y = map.ty(t);
        if (x < 2 || y < 2 || x + w > map.W - 2 || y + h > map.H - 2) return -1;
        const inTown = spec.id === 12 || spec.id === 16 || spec.id === 22;   // banks, water tower
        let lo = 99, hi = -1;
        for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
            const p = map.idx(x + dx, y + dy);
            const k = map.type[p];
            if (inTown ? k !== GameMap.T_HOUSE : !map.isClearable(p)) return -1;
            if (map.slope(p) & GameMap.SLOPE_STEEP) return -1;
            if (map.ground[p] === GameMap.G_FIELDS) return -1;
            lo = Math.min(lo, map.tileMinZ(p)); hi = Math.max(hi, map.tileMaxZ(p));
        }
        if (hi - lo > 1 || lo === 0 && hi === 0) return -1;
        const zone = map.zone[t];
        switch (spec.check) {
            case 'CHECK_REFINERY': {
                const lim = world.settings.refineryLimit || 16;
                if (Math.min(x, y, map.W - x - w, map.H - y - h) > lim) return -1;
                break;
            }
            case 'CHECK_PLANTATION':
                if (world.climate === 1 && zone === GameMap.Z_DESERT) return -1;
                break;
            case 'CHECK_WATER':
                if (world.climate === 1 && zone !== GameMap.Z_DESERT) return -1;
                break;
            case 'CHECK_LUMBERMILL':
                if (zone !== GameMap.Z_RAINFOREST) return -1;
                break;
            case 'CHECK_OIL_RIG':
                return -1;   // oil rigs (sea platforms) are not generated in this remake
        }
        // Temperate oil wells are only built before 1950.
        if (type === 11 && world.climate === 0 && world.year > 1950) return -1;
        // Distance to others of the same or conflicting type (TTD's CheckIfTooCloseToIndustry).
        for (const o of world.industries) {
            if (!o) continue;
            const d = IMath.distMax(x, y, map.tx(o.xy), map.ty(o.xy));
            if (o.type === type && d <= 14 && !(inTown)) return -1;
            if (spec.conflicts.includes(o.type) && d <= 14) return -1;
        }
        if (inTown) {
            const town = world.nearestTown(t);
            if (!town || IMath.manhattan(x, y, map.tx(town.xy), map.ty(town.xy)) > 8) return -1;
            if ((type === 12 || type === 16) && town.population < 1200 && !funding) return -1;
            for (const o of world.industries) if (o && o.type === type && o.town === town.id) return -1;
        }
        return hi;
    },

    /** Build an industry of `type` at top-left tile t (checked before). */
    build(world, type, t, layoutIndex, z) {
        const map = world.map, spec = TTDData.INDUSTRIES[type];
        const lay = spec.layouts[layoutIndex];
        const w = /** @type {number} */ (lay[0]), h = /** @type {number} */ (lay[1]);
        const tiles = /** @type {number[][]} */ (lay[2]);
        const id = world.industries.length;
        const ind = new Industry(id, type, t, w, h);
        ind.layout = layoutIndex;
        ind.founded = world.year;
        ind.lastProdYear = world.year;
        const town = world.nearestTown(t);
        ind.town = town ? town.id : -1;
        ind.accepts = spec.accepts.slice();
        ind.produced = spec.produces.map((p, k) => ({ slot: p[0], rate: 0, waiting: 0, thisMonth: 0, lastMonth: 0, movedThis: 0, movedLast: 0, pctLast: 0 }));
        ind.produced.forEach((p, k) => { p.rate = spec.produces[k][1] ? Industries.rateOf(ind, k) : 0; });
        const x = map.tx(t), y = map.ty(t);
        for (let k = 0; k < tiles.length; k++) {
            const [dx, dy] = tiles[k];
            const p = map.idx(x + dx, y + dy);
            if (map.type[p] === GameMap.T_HOUSE) Towns.removeHouse(world, p);
            map.setClear(p, map.ground[p] === GameMap.G_DESERT ? GameMap.G_DESERT : GameMap.G_GRASS);
            map.type[p] = GameMap.T_INDUSTRY;
            map.obj[p] = id;
            map.sub[p] = k;
            map.owner[p] = GameMap.OWNER_NONE;
            ind.tiles.push(p);
        }
        world.industries.push(ind);
        world.acceptanceDirty = true;
        return ind;
    },

    /** Try to place an industry of `type` somewhere (map generation / a new one during play). */
    place(world, type, attempts) {
        const map = world.map, spec = TTDData.INDUSTRIES[type], rng = world.rng;
        for (let a = 0; a < (attempts || 2000); a++) {
            const li = rng.int(spec.layouts.length);
            const [w, h] = spec.layouts[li];
            let t;
            if (type === 12 || type === 16 || type === 22) {
                const town = rng.pick(world.towns);
                if (!town) return null;
                t = map.idx(IMath.clamp(map.tx(town.xy) + rng.range(-4, 4), 2, map.W - 3), IMath.clamp(map.ty(town.xy) + rng.range(-4, 4), 2, map.H - 3));
            } else {
                t = map.idx(rng.range(2, map.W - 3), rng.range(2, map.H - 3));
            }
            const z = Industries.check(world, type, t, w, h, false);
            if (z < 0) continue;
            return Industries.build(world, type, t, li, z);
        }
        return null;
    },

    /** Map generation: TTD's create table scaled by the map area and the "number of industries". */
    generate(world) {
        const table = TTDData.CREATE_TABLES[world.climate];
        const area = world.map.W * world.map.H / 65536;
        const mult = [0, 0.5, 1, 1.5][IMath.clamp(world.settings.industries, 0, 3)];
        for (const [count, type] of table) {
            if (!TTDData.INDUSTRIES[type] || type === 5) continue;
            let n = count * area * mult;
            n = Math.floor(n) + (world.rng.float() < n % 1 ? 1 : 0);
            if (mult > 0 && n === 0 && world.rng.chance(1, 2)) n = 1;
            for (let i = 0; i < n; i++) Industries.place(world, type, 3000);
        }
    },

    /** Every 256 ticks: produce, then hand the cargo to stations (TTD's ProduceIndustryGoods + TransportIndustryGoods). */
    produce(world, ind) {
        const spec = ind.spec;
        // Secondary industries turn delivered cargo into their product 1:1.
        if (ind.incoming > 0 && ind.produced.length) {
            ind.produced[0].waiting = Math.min(0xffff, ind.produced[0].waiting + ind.incoming);
            ind.incoming = 0;
        }
        for (let k = 0; k < ind.produced.length; k++) {
            const p = ind.produced[k];
            if (spec.produces[k][1] > 0) p.waiting = Math.min(0xffff, p.waiting + p.rate);
            if (p.waiting > 5) {
                let cw = Math.min(p.waiting, 255);
                p.waiting -= cw;
                if (world.economy.recession > 0) cw = (cw + 1) >> 1;
                p.thisMonth += cw;
                ind.lastProdYear = world.year;
                p.movedThis += world.moveGoodsToStation(p.slot, cw, ind.xy, ind.w, ind.h, { industry: ind.id });
            }
        }
        // Farms plant fields around themselves (1 in 8).
        if ((spec.id === 9 || spec.id === 24) && world.rng.chance(1, 8)) Industries.plantField(world, ind);
    },

    /** A field of 2..4 tiles next to a farm. */
    plantField(world, ind) {
        const map = world.map, rng = world.rng;
        const x = map.tx(ind.xy) + rng.range(-5, ind.w + 4), y = map.ty(ind.xy) + rng.range(-5, ind.h + 4);
        const sx = rng.range(1, 3), sy = rng.range(1, 3);
        for (let dy = 0; dy < sy; dy++) for (let dx = 0; dx < sx; dx++) {
            if (!map.valid(x + dx, y + dy)) continue;
            const t = map.idx(x + dx, y + dy);
            if (map.type[t] !== GameMap.T_CLEAR || map.ground[t] === GameMap.G_ROCKS || map.ground[t] === GameMap.G_DESERT) continue;
            map.ground[t] = GameMap.G_FIELDS;
            map.density[t] = 3;
            map.markDirty(t);
        }
    },

    /** Every 512 ticks a lumber mill fells a tree within 40 tiles: +45 wood. */
    lumber(world, ind) {
        const map = world.map, rng = world.rng;
        for (let a = 0; a < 40; a++) {
            const x = map.tx(ind.xy) + rng.range(-20, 20), y = map.ty(ind.xy) + rng.range(-20, 20);
            if (!map.valid(x, y)) continue;
            const t = map.idx(x, y);
            if (map.type[t] !== GameMap.T_TREES || map.treeType[t] !== GameMap.TREE_JUNGLE) continue;
            map.setClear(t, GameMap.G_GRASS);
            ind.produced[0].waiting = Math.min(0xffff, ind.produced[0].waiting + 45);
            return;
        }
    },

    /** Delivered cargo goes to the nearest accepting producer within (spread + 8) * 2 of the station. */
    deliver(world, slot, amount, stationXY) {
        const map = world.map;
        let best = null, u = (12 + 8) * 2;
        for (const ind of world.industries) {
            if (!ind || !ind.accepts.includes(slot)) continue;
            const d = IMath.manhattan(map.tx(ind.xy), map.ty(ind.xy), map.tx(stationXY), map.ty(stationXY));
            if (d < u) { u = d; best = ind; }
        }
        if (!best) return;
        best.deliveredThis += amount;
        if (best.produced.length && best.produced[0].slot !== slot) best.incoming = Math.min(0xffff, best.incoming + amount);
    },

    /** Month end: statistics; production changes of TTD's original economy for one random industry. */
    monthly(world) {
        for (const ind of world.industries) {
            if (!ind) continue;
            for (const p of ind.produced) {
                p.pctLast = p.thisMonth ? Math.min(255, Math.floor(p.movedThis * 256 / p.thisMonth)) : 0;
                p.lastMonth = p.thisMonth; p.movedLast = p.movedThis;
                p.thisMonth = 0; p.movedThis = 0;
            }
            ind.deliveredLast = ind.deliveredThis;
            ind.deliveredThis = 0;
        }
        const list = world.industries.filter(Boolean);
        if (!list.length) return;
        const rng = world.rng;
        // Economy "variable": one random industry each month has a 1/3 chance to change.
        if (world.settings.economy > 0 || rng.chance(1, 2)) {
            const ind = rng.pick(list);
            if (rng.chance(1, 3)) Industries.changeProduction(world, ind);
        }
        // Processing industries without production for 5 years close.
        for (const ind of list) {
            if (ind.spec.life === 'CLOSABLE' && world.year - ind.lastProdYear >= 5 && rng.chance(1, 180)) {
                Industries.close(world, ind, ind.spec.closure);
            }
        }
        // New industries: 3% per month.
        if (rng.chance(3, 100)) {
            const table = TTDData.CREATE_TABLES[world.climate];
            const total = table.reduce((s, e) => s + (TTDData.INDUSTRIES[e[1]] && e[1] !== 5 ? e[0] : 0), 0);
            let r = rng.int(total), type = -1;
            for (const [c, id] of table) {
                if (!TTDData.INDUSTRIES[id] || id === 5) continue;
                if (r < c) { type = id; break; }
                r -= c;
            }
            if (type >= 0) {
                const ind = Industries.place(world, type, 200);
                if (ind) world.addNews('New ' + ind.spec.name + ' under construction near ' + (world.towns[ind.town] ? world.towns[ind.town].name : 'nowhere') + '!', { tile: ind.xy, kind: 'economy' });
            }
        }
    },

    changeProduction(world, ind) {
        const spec = ind.spec, rng = world.rng;
        if (!spec.produces.length || !spec.produces[0][1]) return;   // secondary: follows its input
        const pct = ind.produced.length ? ind.produced[0].pctLast : 0;
        const onlyDecrease = ind.type === 11 && world.climate === 0;
        let up = !onlyDecrease && (pct > 153 ? rng.chance(2, 3) : rng.chance(1, 3));
        if (up) {
            if (ind.prodLevel >= 128) return;
            ind.prodLevel *= 2;
            ind.produced.forEach((p, k) => { p.rate = Industries.rateOf(ind, k); });
            world.addNews(spec.up.replace('{INDUSTRY}', Industries.name(world, ind)), { tile: ind.xy, kind: 'economy' });
        } else {
            if (ind.prodLevel <= 4) {
                if (spec.life !== 'NOT_CLOSABLE') Industries.close(world, ind, spec.closure);
                return;
            }
            ind.prodLevel >>= 1;
            ind.produced.forEach((p, k) => { p.rate = Industries.rateOf(ind, k); });
            world.addNews(spec.down.replace('{INDUSTRY}', Industries.name(world, ind)), { tile: ind.xy, kind: 'economy' });
        }
    },

    close(world, ind, msg) {
        world.addNews((msg || '{INDUSTRY} announces imminent closure!').replace('{INDUSTRY}', Industries.name(world, ind)), { tile: ind.xy, kind: 'economy', big: true });
        Industries.remove(world, ind);
    },

    remove(world, ind) {
        const map = world.map;
        for (const t of ind.tiles) if (map.type[t] === GameMap.T_INDUSTRY && map.obj[t] === ind.id) map.setClear(t, GameMap.G_ROUGH);
        world.industries[ind.id] = null;
        world.acceptanceDirty = true;
    },
};
