// TTDCommands.js — every change the player makes to the world, TTD-style: each command checks
// what it may do and what it costs (TTD's prices × the construction-cost setting × inflation),
// and only changes the world when exec is true (TTD's DC_EXEC). Result: { ok, cost, err }.
// Costs go to the Construction line of the finances; town ratings react like in TTD (felling
// trees, demolishing buildings, removing town roads, local authority permission for stations).

/** @satisfies {Record<string, any>} */
const Commands = {
    ok(cost) { return { ok: true, cost: cost || 0, err: '' }; },
    fail(err) { return { ok: false, cost: 0, err }; },

    /** Pay for a command that succeeded (exec) — or report the cost of a failed-for-money one. */
    run(world, fn, exec) {
        const probe = fn(false);
        if (!probe.ok || !exec) return probe;
        const c = world.player;
        if (probe.cost > 0 && c.money < probe.cost) return Commands.fail('Not enough cash - requires ' + Money.format(probe.cost));
        const r = fn(true);
        if (r.ok && r.cost) c.spend(r.cost, Company.C_CONSTRUCTION);
        if (r.ok) world.emit('built', r);
        return r;
    },

    // --- Clearing ------------------------------------------------------------------------

    /** Is a vehicle on (or in) this tile? */
    vehicleOn(world, t) {
        const map = world.map, x = map.tx(t), y = map.ty(t);
        for (const v of world.vehicles) {
            if (!v || v.state === 'depot') continue;
            if (v.type === 'air' && v.phase === 'fly') continue;
            for (const p of v.parts || []) if (!p.hidden && Math.floor(p.x) === x && Math.floor(p.y) === y) return true;
            if (v.type === 'train') for (const s of v.steps) if (s.t === t && s.w < 0) return true;
        }
        return false;
    },

    /** Town rating needed for the player to remove town property (0 road, 1 house, 2 bridge). */
    townAllows(world, town, kind) {
        if (!town) return true;
        const need = 16 + [[0, 128, 384], [48, 192, 480], [96, 384, 768]][world.settings.townTolerance][kind === 2 ? 1 : 0];
        return town.rating(0) >= need;
    },

    /** Cost to clear clear land / trees (what building on a tile pays first). */
    clearCost(world, t) {
        const map = world.map, k = map.type[t];
        if (k === GameMap.T_TREES) {
            const heavy = map.treeType[t] === GameMap.TREE_JUNGLE || map.treeType[t] === GameMap.TREE_CACTUS;
            return world.price('removeTrees') * (map.treeCount[t] + 1) * (heavy ? 4 : 1);
        }
        if (k !== GameMap.T_CLEAR) return 0;
        switch (map.ground[t]) {
            case GameMap.G_ROUGH: return world.price('clearRough');
            case GameMap.G_ROCKS: return world.price('clearRocks');
            case GameMap.G_FIELDS: return world.price('clearFields');
            case GameMap.G_DESERT: return world.price('clearRough');
        }
        return world.price('clearGrass');
    },

    /** Clear a land/trees tile before building (trees cost town rating). */
    clearForBuild(world, t, exec) {
        const map = world.map;
        const cost = Commands.clearCost(world, t);
        if (exec) {
            if (map.type[t] === GameMap.T_TREES) {
                const town = world.nearestTown(t, 20);
                if (town) town.changeRating(0, -35 * map.treeCount[t], -1000);
            }
            map.setClear(t, map.ground[t] === GameMap.G_DESERT || map.zone[t] === GameMap.Z_DESERT ? GameMap.G_DESERT : GameMap.G_GRASS);
        }
        return cost;
    },

    /** Demolish whatever is on tile t (the bulldozer). */
    demolish(world, t, exec) {
        const map = world.map;
        if (!map.valid(map.tx(t), map.ty(t))) return Commands.fail('Off edge of map');
        const k = map.type[t];
        if (k !== GameMap.T_CLEAR && k !== GameMap.T_TREES && Commands.vehicleOn(world, t)) return Commands.fail('Vehicle in the way');
        switch (k) {
            case GameMap.T_CLEAR: {
                const cost = Commands.clearCost(world, t);
                if (map.ground[t] === GameMap.G_GRASS || map.ground[t] === GameMap.G_DESERT) return Commands.fail('Already cleared');
                if (exec) Commands.clearForBuild(world, t, true);
                return Commands.ok(cost);
            }
            case GameMap.T_TREES: {
                const cost = Commands.clearCost(world, t);
                if (exec) Commands.clearForBuild(world, t, true);
                return Commands.ok(cost);
            }
            case GameMap.T_WATER:
                if (map.sub[t] === GameMap.WATER_SUB_DEPOT) return Commands.removeDepot(world, t, exec);
                return Commands.fail('Can\'t clear water');
            case GameMap.T_HOUSE: {
                const base = map.obj[t] >= 0 ? map.obj[t] : t;
                const h = TTDData.HOUSES[map.sub[base]];
                const town = world.towns[map.town[base]];
                if (!Commands.townAllows(world, town, 1)) return Commands.fail(town.name + ' local authority refuses to allow this');
                const cost = world.price('removeHouse') * h.removeCost / 256;
                if (exec) {
                    Towns.removeHouse(world, base);
                    if (town) town.changeRating(0, -h.ratingMod, -1000);
                    world.acceptanceDirty = true;
                }
                return Commands.ok(cost);
            }
            case GameMap.T_RAIL:
                if (map.sub[t] === GameMap.RAIL_SUB_DEPOT) return Commands.removeDepot(world, t, exec);
                if (map.owner[t] !== 0) return Commands.fail('Owned by another company');
                {
                    let cost = 0, n = 0;
                    for (let tr = 0; tr < 6; tr++) if (map.rail[t] & (1 << tr)) n++;
                    cost = world.price('removeRail') * n;
                    if (map.signals[t]) cost += world.price('removeSignals');
                    if (exec) { map.setClear(t, GameMap.G_GRASS); world.railVersion++; }
                    return Commands.ok(cost);
                }
            case GameMap.T_ROAD: {
                if (map.sub[t] === GameMap.ROAD_SUB_DEPOT) return Commands.removeDepot(world, t, exec);
                if (map.sub[t] === GameMap.ROAD_SUB_CROSSING) {
                    // Remove the rail first (TTD removes one thing at a time).
                    if (map.owner[t] !== 0) return Commands.fail('Owned by another company');
                    if (exec) { map.rail[t] = 0; map.sub[t] = 0; map.signals[t] = 0; map.owner[t] = map.roadOwner[t]; world.railVersion++; map.markDirty(t); }
                    return Commands.ok(world.price('removeRail'));
                }
                return Commands.removeRoad(world, t, map.road[t], exec);
            }
            case GameMap.T_STATION: return Commands.removeStationPart(world, t, exec);
            case GameMap.T_TUNBRIDGE: return Commands.removeWormhole(world, map.obj[t], exec);
            case GameMap.T_INDUSTRY: return Commands.fail('Can\'t demolish an industry');
            case GameMap.T_OBJECT: return Commands.fail('Can\'t demolish this object');
        }
        return Commands.fail('Can\'t clear this area');
    },

    // --- Rail --------------------------------------------------------------------------------

    /** Does the slope allow a piece along `axis` (-1 diagonal) — and does it need a foundation? */
    slopeFor(world, t, axis) {
        const map = world.map;
        const s = map.slope(t);
        if (s === 0) return { ok: true, found: false };
        if (axis >= 0 && map.inclineAxis(t) === axis) return { ok: true, found: false };
        return { ok: true, found: true };
    },

    buildRail(world, t, track, railType, exec) {
        const map = world.map;
        if (!map.valid(map.tx(t), map.ty(t))) return Commands.fail('Off edge of map');
        const bit = 1 << track;
        const k = map.type[t];
        let cost = world.price('buildRail');
        if (k === GameMap.T_RAIL) {
            if (map.sub[t] !== 0) return Commands.fail('Can\'t build railway track here');
            if (map.owner[t] !== 0) return Commands.fail('Owned by another company');
            if (map.rail[t] & bit) return Commands.fail('Already built');
            if (map.railType[t] !== railType) return Commands.fail('Must convert the rail type first');
            // Straight pieces on inclines can't share the tile with diagonal ones.
            const sl = Commands.slopeFor(world, t, Track.AXIS[track]);
            if (map.inclineAxis(t) >= 0 && (Track.AXIS[track] !== map.inclineAxis(t) || map.rail[t])) return Commands.fail('Land sloped in wrong direction');
            if (exec) { map.rail[t] |= bit; map.signals[t] &= ~(3 << (track * 2)); map.markDirty(t); world.railVersion++; }
            return Commands.ok(cost);
        }
        if (k === GameMap.T_ROAD && map.sub[t] === 0) {
            // Level crossing: straight road across the straight track, flat land.
            const roadAxis = map.road[t] === 5 ? 0 : map.road[t] === 10 ? 1 : -1;
            if (track > 1 || roadAxis < 0 || roadAxis === track) return Commands.fail('Must remove road first');
            if (!map.isFlat(t)) return Commands.fail('Flat land required');
            if (exec) {
                map.sub[t] = GameMap.ROAD_SUB_CROSSING;
                map.rail[t] = bit;
                map.railType[t] = railType;
                map.owner[t] = 0;
                map.markDirty(t);
                world.railVersion++;
            }
            return Commands.ok(cost);
        }
        if (!map.isClearable(t)) return Commands.fail(Commands.occupiedMsg(world, t));
        if (map.over[t] >= 0 && world.wormholes[map.over[t]] && map.tileMaxZ(t) + 1 >= world.wormholes[map.over[t]].z) return Commands.fail('Bridge in the way');
        const sl = Commands.slopeFor(world, t, Track.AXIS[track]);
        if (!sl.ok) return Commands.fail('Land sloped in wrong direction');
        if (sl.found) cost += world.price('terraform');
        cost += Commands.clearCost(world, t);
        if (exec) {
            Commands.clearForBuild(world, t, true);
            map.type[t] = GameMap.T_RAIL;
            map.rail[t] = bit;
            map.railType[t] = railType;
            map.owner[t] = 0;
            map.markDirty(t);
            world.railVersion++;
        }
        return Commands.ok(cost);
    },

    removeRail(world, t, track, exec) {
        const map = world.map, bit = 1 << track;
        if (!(Track.railBits(map, t) & bit) || map.type[t] === GameMap.T_STATION || map.type[t] === GameMap.T_TUNBRIDGE) return Commands.fail('There is no railway track');
        if (map.owner[t] !== 0) return Commands.fail('Owned by another company');
        if (Commands.vehicleOn(world, t)) return Commands.fail('Train in the way');
        let cost = world.price('removeRail');
        if (map.signals[t] & (3 << (track * 2))) cost += world.price('removeSignals');
        if (exec) {
            if (map.type[t] === GameMap.T_ROAD) { map.rail[t] = 0; map.sub[t] = 0; map.signals[t] = 0; map.owner[t] = map.roadOwner[t]; }
            else {
                map.rail[t] &= ~bit;
                map.signals[t] &= ~(3 << (track * 2));
                if (!map.rail[t]) map.setClear(t, GameMap.G_GRASS);
            }
            map.markDirty(t);
            world.railVersion++;
        }
        return Commands.ok(cost);
    },

    /** Signals on a piece: none -> two-way -> one-way -> the other way -> two-way… */
    buildSignal(world, t, track, exec) {
        const map = world.map;
        if (map.type[t] !== GameMap.T_RAIL || map.sub[t] !== 0 || !(map.rail[t] & (1 << track))) return Commands.fail('There is no railway track here');
        if (map.owner[t] !== 0) return Commands.fail('Owned by another company');
        // TTD: signals only on tiles with one track or two parallel diagonal pieces.
        const bits = map.rail[t];
        const pairs = bits === (1 << track) || bits === 12 || bits === 48;
        if (!pairs) return Commands.fail('No suitable railway track (junction)');
        const cur = (map.signals[t] >> (track * 2)) & 3;
        const next = cur === 0 ? 3 : cur === 3 ? 1 : cur === 1 ? 2 : 3;
        const cost = cur === 0 ? world.price('buildSignals') : 0;
        if (exec) {
            map.signals[t] = (map.signals[t] & ~(3 << (track * 2))) | (next << (track * 2));
            map.markDirty(t);
            world.railVersion++;
        }
        return Commands.ok(cost);
    },

    removeSignal(world, t, track, exec) {
        const map = world.map;
        if (map.type[t] !== GameMap.T_RAIL || !((map.signals[t] >> (track * 2)) & 3)) return Commands.fail('No signals here');
        if (exec) { map.signals[t] &= ~(3 << (track * 2)); map.markDirty(t); world.railVersion++; }
        return Commands.ok(world.price('removeSignals'));
    },

    occupiedMsg(world, t) {
        const k = world.map.type[t];
        return ['', 'Railway track in the way', 'Road in the way', 'Building must be demolished first', '', 'Station in the way',
            'Can\'t build on water', 'Industry in the way', 'Bridge or tunnel in the way', 'Object in the way'][k] || 'Area occupied';
    },

    // --- Roads -------------------------------------------------------------------------------

    buildRoad(world, t, bits, exec) {
        const map = world.map;
        if (!map.valid(map.tx(t), map.ty(t))) return Commands.fail('Off edge of map');
        const k = map.type[t];
        let n = 0;
        if (k === GameMap.T_ROAD && map.sub[t] === 0) {
            const add = bits & ~map.road[t];
            if (!add) return Commands.fail('Already built');
            const all = map.road[t] | add;
            if (map.inclineAxis(t) >= 0 && !(all === 5 && map.inclineAxis(t) === 0 || all === 10 && map.inclineAxis(t) === 1 ||
                (all & ~(map.inclineAxis(t) === 0 ? 5 : 10)) === 0)) return Commands.fail('Land sloped in wrong direction');
            for (let d = 0; d < 4; d++) if (add & (1 << d)) n++;
            if (exec) { map.road[t] = all; map.markDirty(t); }
            return Commands.ok(world.price('buildRoad') * n);
        }
        if (k === GameMap.T_RAIL && map.sub[t] === 0) {
            // Level crossing on straight track.
            const tr = map.rail[t];
            if (!(tr === 1 && bits === 10) && !(tr === 2 && bits === 5)) return Commands.fail('Must remove railway track first');
            if (!map.isFlat(t)) return Commands.fail('Flat land required');
            if (exec) {
                map.type[t] = GameMap.T_ROAD;
                map.sub[t] = GameMap.ROAD_SUB_CROSSING;
                map.road[t] = bits;
                map.roadOwner[t] = 0;
                map.markDirty(t);
                world.railVersion++;
            }
            return Commands.ok(world.price('buildRoad') * 2);
        }
        if (!map.isClearable(t)) return Commands.fail(Commands.occupiedMsg(world, t));
        if (map.over[t] >= 0 && world.wormholes[map.over[t]] && map.tileMaxZ(t) + 1 >= world.wormholes[map.over[t]].z) return Commands.fail('Bridge in the way');
        const ax = bits === 5 || bits === 1 || bits === 4 ? 0 : bits === 10 || bits === 2 || bits === 8 ? 1 : -1;
        let cost = Commands.clearCost(world, t);
        const sl = Commands.slopeFor(world, t, ax);
        if (map.inclineAxis(t) >= 0 && ax !== map.inclineAxis(t)) cost += world.price('terraform');
        else if (sl.found) cost += world.price('terraform');
        for (let d = 0; d < 4; d++) if (bits & (1 << d)) n++;
        cost += world.price('buildRoad') * n;
        if (exec) {
            Commands.clearForBuild(world, t, true);
            map.type[t] = GameMap.T_ROAD;
            map.road[t] = bits;
            map.roadOwner[t] = 0;
            map.owner[t] = 0;
            map.markDirty(t);
        }
        return Commands.ok(cost);
    },

    removeRoad(world, t, bits, exec) {
        const map = world.map;
        if (map.type[t] !== GameMap.T_ROAD || map.sub[t] === GameMap.ROAD_SUB_DEPOT) return Commands.fail('There is no road here');
        const rem = bits & map.road[t];
        if (!rem) return Commands.fail('There is no road here');
        if (map.roadOwner[t] === GameMap.OWNER_TOWN) {
            const town = world.towns[map.town[t]];
            if (!Commands.townAllows(world, town, 0)) return Commands.fail((town ? town.name : 'The') + ' local authority refuses to allow this');
        } else if (map.roadOwner[t] !== 0) return Commands.fail('Owned by another company');
        if (Commands.vehicleOn(world, t)) return Commands.fail('Road vehicle in the way');
        let n = 0;
        for (let d = 0; d < 4; d++) if (rem & (1 << d)) n++;
        if (exec) {
            if (map.roadOwner[t] === GameMap.OWNER_TOWN) {
                const town = world.towns[map.town[t]];
                if (town) town.changeRating(0, -50 * n, -100);
            }
            if (map.sub[t] === GameMap.ROAD_SUB_CROSSING) {
                map.type[t] = GameMap.T_RAIL; map.sub[t] = 0; map.road[t] = 0; map.owner[t] = 0;
                world.railVersion++;
            } else {
                map.road[t] &= ~rem;
                if (!map.road[t]) map.setClear(t, GameMap.G_GRASS);
            }
            map.markDirty(t);
        }
        return Commands.ok(world.price('removeRoad') * n);
    },

    // --- Depots ------------------------------------------------------------------------------

    /** kind 'rail' | 'road' | 'ship'; dir — the entrance edge. */
    buildDepot(world, t, kind, dir, railType, exec) {
        const map = world.map;
        if (!map.valid(map.tx(t), map.ty(t))) return Commands.fail('Off edge of map');
        let cost;
        if (kind === 'ship') {
            const n = map.neighbour(t, dir), m = map.neighbour(t, Dir.reverse(dir));
            if (map.type[t] !== GameMap.T_WATER || map.sub[t] || map.tileMaxZ(t) !== 0) return Commands.fail('Must be built on water');
            if (n < 0 || m < 0 || !map.isWater(n) || !map.isWater(m)) return Commands.fail('Must be built on water');
            cost = world.price('buildShipDepot');
        } else {
            if (!map.isClearable(t)) return Commands.fail(Commands.occupiedMsg(world, t));
            if (map.slope(t) & GameMap.SLOPE_STEEP) return Commands.fail('Land sloped in wrong direction');
            cost = world.price(kind === 'rail' ? 'buildTrainDepot' : 'buildRoadDepot') + Commands.clearCost(world, t);
            if (!map.isFlat(t)) cost += world.price('terraform');
        }
        if (exec) {
            const id = world.depots.length;
            world.depots.push({ id, t, kind, dir, owner: 0 });
            if (kind === 'ship') {
                map.sub[t] = GameMap.WATER_SUB_DEPOT;
            } else {
                Commands.clearForBuild(world, t, true);
                map.type[t] = kind === 'rail' ? GameMap.T_RAIL : GameMap.T_ROAD;
                map.sub[t] = kind === 'rail' ? GameMap.RAIL_SUB_DEPOT : GameMap.ROAD_SUB_DEPOT;
                if (kind === 'rail') { map.rail[t] = 1 << Track.axisTrack(Dir.axis(dir)); map.railType[t] = railType || 0; world.railVersion++; }
                else {
                    map.road[t] = 1 << dir;
                    // Join the road in front of the entrance (straight roads only, like a drag would).
                    const n = map.neighbour(t, dir);
                    if (n >= 0 && map.type[n] === GameMap.T_ROAD && map.sub[n] === 0) {
                        map.road[n] |= 1 << Dir.reverse(dir);
                        map.markDirty(n);
                    }
                }
            }
            map.obj[t] = id;
            map.owner[t] = 0;
            map.markDirty(t);
        }
        return Commands.ok(cost);
    },

    removeDepot(world, t, exec) {
        const map = world.map;
        const d = world.depotAt(t);
        if (!d) return Commands.fail('No depot here');
        if (world.vehicles.some(v => v && (v.depot === d.id || v.serviceDepot === d.id) && v.state === 'depot' && v.type !== 'air')) return Commands.fail('Vehicles in the depot');
        if (Commands.vehicleOn(world, t)) return Commands.fail('Vehicle in the way');
        const cost = world.price(d.kind === 'rail' ? 'removeTrainDepot' : d.kind === 'road' ? 'removeRoadDepot' : 'removeShipDepot');
        if (exec) {
            world.depots[d.id] = null;
            for (const v of world.vehicles) if (v) {
                if (v.serviceDepot === d.id) v.serviceDepot = -1;
                v.orders = v.orders.filter(o => !(o.kind === 'depot' && o.dest === d.id));
                if (v.cur >= v.orders.length) v.cur = 0;
            }
            if (d.kind === 'ship') { map.sub[t] = 0; map.obj[t] = -1; map.markDirty(t); }
            else { map.setClear(t, GameMap.G_GRASS); if (d.kind === 'rail') world.railVersion++; }
        }
        return Commands.ok(cost);
    },

    // --- Stations ------------------------------------------------------------------------------

    /** Station to join for new parts on these tiles (adjacent own station), or null. */
    joinable(world, tiles) {
        const map = world.map;
        for (const t of tiles) {
            const x = map.tx(t), y = map.ty(t);
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                if (!map.inside(x + dx, y + dy)) continue;
                const st = world.stationAt(map.idx(x + dx, y + dy));
                if (st && st.owner === 0) {
                    // Station spread (openttd.cfg station_spread = 12).
                    const xs = st.parts.map(p => map.tx(p.t)).concat(tiles.map(p => map.tx(p)));
                    const ys = st.parts.map(p => map.ty(p.t)).concat(tiles.map(p => map.ty(p)));
                    if (Math.max(...xs) - Math.min(...xs) < 12 && Math.max(...ys) - Math.min(...ys) < 12) return st;
                }
            }
        }
        return null;
    },

    /** The local authority must not be too angry (> Very Poor) to let a station be built. */
    stationAllowed(world, t) {
        const town = world.nearestTown(t, 20);
        if (town && town.rating(0) <= -200) return 'Local authority of ' + town.name + ' refuses to allow another station in this town';
        return null;
    },

    newStation(world, t, suffixHint) {
        const town = world.nearestTown(t);
        const id = world.stations.length;
        let name = town ? town.name : 'Station';
        if (town) {
            const used = new Set(world.stations.filter(Boolean).map(s => s.name));
            const order = suffixHint ? [suffixHint].concat(Station.SUFFIXES) : Station.SUFFIXES;
            for (const s of order) if (!used.has(town.name + s)) { name = town.name + s; break; }
            if (used.has(name)) name = town.name + ' ' + id;
        }
        const st = new Station(id, t, 0, name, town ? town.id : -1);
        st.built = world.date;
        world.stations.push(st);
        return st;
    },

    addParts(world, st, tiles, kind, bitsFn) {
        const map = world.map;
        for (const t of tiles) {
            Commands.clearForBuild(world, t, true);
            map.type[t] = GameMap.T_STATION;
            map.sub[t] = kind;
            map.obj[t] = st.id;
            map.owner[t] = 0;
            const b = bitsFn ? bitsFn(t) : null;
            if (b && b.rail != null) { map.rail[t] = b.rail; map.railType[t] = b.railType || 0; }
            if (b && b.road != null) { map.road[t] = b.road; map.roadOwner[t] = 0; }
            map.markDirty(t);
            st.parts.push({ t, kind, water: b && b.water != null ? b.water : -1 });
        }
        st.catch = null;
        st.updateFacilities();
        world.acceptanceDirty = true;
        if (kind === GameMap.ST_RAIL) world.railVersion++;
    },

    /** Rail station: `tracks` platforms of `length` along axis from top-left tile t. */
    buildRailStation(world, t, axis, tracks, length, railType, exec) {
        const map = world.map, x0 = map.tx(t), y0 = map.ty(t);
        const w = axis === 0 ? length : tracks, h = axis === 0 ? tracks : length;
        const tiles = [];
        let z = -1, cost = 0;
        for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
            if (!map.valid(x0 + dx, y0 + dy)) return Commands.fail('Off edge of map');
            const p = map.idx(x0 + dx, y0 + dy);
            if (!map.isClearable(p)) {
                // Existing plain straight track of the right axis may become a platform.
                if (!(map.type[p] === GameMap.T_RAIL && map.sub[p] === 0 && map.rail[p] === (1 << Track.axisTrack(axis)))) return Commands.fail(Commands.occupiedMsg(world, p));
            }
            if (map.slope(p) & GameMap.SLOPE_STEEP) return Commands.fail('Land sloped in wrong direction');
            if (map.over[p] >= 0) return Commands.fail('Bridge in the way');
            const bz = map.buildZ(p);
            if (z >= 0 && bz !== z) return Commands.fail('Flat land required');
            z = bz;
            if (!map.isFlat(p)) cost += world.price('terraform');
            cost += Commands.clearCost(world, p);
            tiles.push(p);
        }
        const why = Commands.stationAllowed(world, t);
        if (why) return Commands.fail(why);
        cost += (tracks * world.price('stationTrack') + world.price('stationLength')) * length;
        if (exec) {
            const st = Commands.joinable(world, tiles) || Commands.newStation(world, t);
            for (const p of tiles) if (map.type[p] === GameMap.T_RAIL) map.setClear(p, GameMap.G_GRASS);
            Commands.addParts(world, st, tiles, GameMap.ST_RAIL, () => ({ rail: 1 << Track.axisTrack(axis), railType }));
            return Object.assign(Commands.ok(cost), { station: st.id });
        }
        return Commands.ok(cost);
    },

    /** Drive-through road stop along `axis` (bus or truck). */
    buildRoadStop(world, t, axis, truck, exec) {
        const map = world.map;
        if (!map.valid(map.tx(t), map.ty(t))) return Commands.fail('Off edge of map');
        const bits = axis === 0 ? 5 : 10;
        const onRoad = map.type[t] === GameMap.T_ROAD && map.sub[t] === 0 && (map.road[t] === bits || map.road[t] === (bits & 3) || map.road[t] === (bits & 12));
        if (!onRoad && !map.isClearable(t)) return Commands.fail(Commands.occupiedMsg(world, t));
        if (onRoad && map.roadOwner[t] === GameMap.OWNER_TOWN && !Commands.townAllows(world, world.towns[map.town[t]], 0)) return Commands.fail('Local authority refuses to allow this');
        if (!map.isFlat(t) && map.inclineAxis(t) !== axis) return Commands.fail('Flat land required');
        const why = Commands.stationAllowed(world, t);
        if (why) return Commands.fail(why);
        const cost = world.price(truck ? 'buildTruckStation' : 'buildBusStation') + (onRoad ? 0 : Commands.clearCost(world, t));
        if (exec) {
            const st = Commands.joinable(world, [t]) || Commands.newStation(world, t);
            const townRoad = onRoad && map.roadOwner[t] === GameMap.OWNER_TOWN;
            const town = map.town[t];
            if (onRoad) { map.type[t] = GameMap.T_CLEAR; }
            Commands.addParts(world, st, [t], truck ? GameMap.ST_TRUCK : GameMap.ST_BUS, () => ({ road: bits }));
            if (townRoad) map.town[t] = town;
            return Object.assign(Commands.ok(cost), { station: st.id });
        }
        return Commands.ok(cost);
    },

    buildAirport(world, t, type, exec) {
        const map = world.map, spec = TTDData.AIRPORTS[type];
        const y = world.year;
        if (y < spec.from || y > spec.to) return Commands.fail(spec.name + ' is not available in ' + y);
        const x0 = map.tx(t), y0 = map.ty(t), tiles = [];
        let z = -1, cost = 0;
        for (let dy = 0; dy < spec.h; dy++) for (let dx = 0; dx < spec.w; dx++) {
            if (!map.valid(x0 + dx, y0 + dy)) return Commands.fail('Off edge of map');
            const p = map.idx(x0 + dx, y0 + dy);
            if (!map.isClearable(p)) return Commands.fail(Commands.occupiedMsg(world, p));
            if (map.slope(p) & GameMap.SLOPE_STEEP || map.over[p] >= 0) return Commands.fail('Flat land required');
            const bz = map.buildZ(p);
            if (z >= 0 && bz !== z) return Commands.fail('Flat land required');
            z = bz;
            if (!map.isFlat(p)) cost += world.price('terraform');
            cost += Commands.clearCost(world, p) + world.price('buildAirport');
            tiles.push(p);
        }
        const why = Commands.stationAllowed(world, t);
        if (why) return Commands.fail(why);
        if (exec) {
            let st = Commands.joinable(world, tiles);
            if (st && st.airport) st = null;
            st = st || Commands.newStation(world, t, ' Airport');
            st.airport = { type, t, terms: null };
            Commands.addParts(world, st, tiles, GameMap.ST_AIRPORT, null);
            return Object.assign(Commands.ok(cost), { station: st.id });
        }
        return Commands.ok(cost);
    },

    /** Dock on an incline whose lower edge faces the sea. */
    buildDock(world, t, exec) {
        const map = world.map;
        if (!map.valid(map.tx(t), map.ty(t))) return Commands.fail('Off edge of map');
        if (!map.isClearable(t)) return Commands.fail(Commands.occupiedMsg(world, t));
        const ax = map.inclineAxis(t);
        if (ax < 0) return Commands.fail('Site unsuitable');
        // The low side of the incline.
        let low = -1;
        for (let d = 0; d < 4; d++) {
            if (Dir.axis(d) !== ax) continue;
            const e = map.edgeCorners(t, d);
            if (e[0] === 0 && e[1] === 0) low = d;
        }
        if (low < 0) return Commands.fail('Site unsuitable');
        const water = map.neighbour(t, low);
        if (water < 0 || !map.isWater(water) || map.sub[water]) return Commands.fail('Site unsuitable');
        const why = Commands.stationAllowed(world, t);
        if (why) return Commands.fail(why);
        const cost = world.price('buildDock') + Commands.clearCost(world, t);
        if (exec) {
            const st = Commands.joinable(world, [t]) || Commands.newStation(world, t, ' Docks');
            Commands.addParts(world, st, [t], GameMap.ST_DOCK, () => ({ water }));
            map.density[t] = low;
            return Object.assign(Commands.ok(cost), { station: st.id });
        }
        return Commands.ok(cost);
    },

    removeStationPart(world, t, exec) {
        const map = world.map;
        const st = world.stationAt(t);
        if (!st) return Commands.fail('No station here');
        if (st.owner !== 0) return Commands.fail('Owned by another company');
        const kind = map.sub[t];
        // Airports go as a whole.
        const tiles = kind === GameMap.ST_AIRPORT ? st.parts.filter(p => p.kind === GameMap.ST_AIRPORT).map(p => p.t) : [t];
        for (const p of tiles) if (Commands.vehicleOn(world, p)) return Commands.fail('Vehicle in the way');
        if (kind === GameMap.ST_AIRPORT && world.vehicles.some(v => v && v.type === 'air' && (v.hangar === st.id && v.state === 'depot' || v.at === st.id))) return Commands.fail('Aircraft in the way');
        const price = { 0: 'removeRailStation', 1: 'removeBusStation', 2: 'removeTruckStation', 3: 'removeAirport', 4: 'removeDock' }[kind] || 'removeRailStation';
        const cost = world.price(price) * tiles.length;
        if (exec) {
            for (const p of tiles) {
                const road = map.road[p];
                map.setClear(p, GameMap.G_GRASS);
                // A road stop leaves its road behind.
                if (kind === GameMap.ST_BUS || kind === GameMap.ST_TRUCK) { map.type[p] = GameMap.T_ROAD; map.road[p] = road; map.roadOwner[p] = 0; map.owner[p] = 0; }
            }
            st.parts = st.parts.filter(p => !tiles.includes(p.t));
            if (kind === GameMap.ST_AIRPORT) st.airport = null;
            st.catch = null;
            st.updateFacilities();
            if (kind === GameMap.ST_RAIL) world.railVersion++;
            if (!st.parts.length) Commands.deleteStation(world, st);
            else if (!st.parts.some(p => p.t === st.xy)) st.xy = st.parts[0].t;
            world.acceptanceDirty = true;
        }
        return Commands.ok(cost);
    },

    deleteStation(world, st) {
        world.stations[st.id] = null;
        for (const v of world.vehicles) {
            if (!v) continue;
            const n = v.orders.length;
            v.orders = v.orders.filter(o => !(o.kind === 'station' && o.dest === st.id));
            if (v.orders.length !== n) { v.cur = 0; v.onOrderChanged(); }
        }
    },

    // --- Bridges and tunnels ----------------------------------------------------------------------

    /** Bridge from head a to head b (same row or column), `type` = TTDData.BRIDGES index. */
    buildBridge(world, a, b, type, transport, railType, exec) {
        const map = world.map;
        const ax = map.tx(a), ay = map.ty(a), bx = map.tx(b), by = map.ty(b);
        if (ax !== bx && ay !== by) return Commands.fail('Start and end must be in line');
        const dir = ax === bx ? (by > ay ? Dir.SE : Dir.NW) : (bx > ax ? Dir.SW : Dir.NE);
        const L = IMath.manhattan(ax, ay, bx, by) + 1;
        const spec = TTDData.BRIDGES[type];
        if (!spec) return Commands.fail('Unknown bridge');
        if (L - 2 < 1) return Commands.fail('Bridge too short');
        if (spec.year > world.year) return Commands.fail(spec.name + ' is not available yet');
        if (L - 2 > spec.maxLen || L - 2 < spec.minLen) return Commands.fail('Bridge too long or too short for this type');
        const axis = Dir.axis(dir);
        // Heads: flat or rising toward the bridge; the deck is one level above a flat head.
        // A head may replace a straight piece of the player's road or track along the bridge.
        const headFree = (t) => map.isClearable(t) ||
            (map.type[t] === GameMap.T_ROAD && map.sub[t] === 0 && map.roadOwner[t] !== GameMap.OWNER_TOWN && (map.road[t] & ~(axis === 0 ? 5 : 10)) === 0 && transport === 'road') ||
            (map.type[t] === GameMap.T_RAIL && map.sub[t] === 0 && map.owner[t] === 0 && map.rail[t] === (1 << Track.axisTrack(axis)) && !map.signals[t] && transport === 'rail');
        const deck = (t, inner) => {
            if (!headFree(t)) return -1;
            if (map.isFlat(t)) return map.tileMinZ(t) + 1;
            if (map.slope(t) & GameMap.SLOPE_STEEP) return -1;
            if (map.inclineAxis(t) === axis) {
                const ei = map.edgeCorners(t, inner), eo = map.edgeCorners(t, Dir.reverse(inner));
                if (ei[0] > eo[0]) return ei[0];
            }
            return map.tileMaxZ(t) + 1;   // on a foundation, like a flat head at the top of the slope
        };
        const za = deck(a, dir), zb = deck(b, Dir.reverse(dir));
        if (za < 0 || zb < 0) return Commands.fail('Unsuitable site for the bridge head');
        if (za !== za || za !== zb) return Commands.fail('Bridge heads must be at the same height');
        let cost = Commands.clearCost(world, a) + Commands.clearCost(world, b);
        for (let i = 1; i < L - 1; i++) {
            const t = map.idx(ax + Dir.DX[dir] * i, ay + Dir.DY[dir] * i);
            if (map.over[t] >= 0) return Commands.fail('Bridge in the way');
            if (map.tileMaxZ(t) >= za) return Commands.fail('Bridge too low for the terrain');
            const k = map.type[t];
            if (k === GameMap.T_HOUSE || k === GameMap.T_INDUSTRY || k === GameMap.T_STATION || k === GameMap.T_TUNBRIDGE || k === GameMap.T_OBJECT) {
                if (map.tileMaxZ(t) + 2 > za) return Commands.fail('Building in the way');
            }
        }
        cost += TTDData.bridgeLenFactor(L) * world.price('buildBridge') * spec.price / 256;
        if (!exec) return Commands.ok(cost);
        const id = world.wormholes.length;
        world.wormholes.push({ id, a, b, dir, kind: 'bridge', type, z: za, rail: transport === 'rail', owner: 0 });
        for (const [t, inner] of [[a, dir], [b, Dir.reverse(dir)]]) {
            if (map.type[t] === GameMap.T_ROAD || map.type[t] === GameMap.T_RAIL) map.setClear(t, GameMap.G_GRASS);
            Commands.clearForBuild(world, t, true);
            map.type[t] = GameMap.T_TUNBRIDGE;
            map.sub[t] = 1;
            map.obj[t] = id;
            map.density[t] = inner;
            map.wz[t] = za;
            map.owner[t] = 0;
            if (transport === 'rail') { map.rail[t] = 1 << Track.axisTrack(axis); map.railType[t] = railType || 0; }
            else { map.road[t] = axis === 0 ? 5 : 10; map.roadOwner[t] = 0; }
            map.markDirty(t);
        }
        for (let i = 1; i < L - 1; i++) {
            const t = map.idx(ax + Dir.DX[dir] * i, ay + Dir.DY[dir] * i);
            map.over[t] = id;
            map.markDirty(t);
        }
        if (transport === 'rail') world.railVersion++;
        return Commands.ok(cost);
    },

    /** Tunnel from an incline into the hill, to the matching incline on the other side. */
    buildTunnel(world, t, transport, railType, exec) {
        const map = world.map;
        if (!map.isClearable(t)) return Commands.fail(Commands.occupiedMsg(world, t));
        const axis = map.inclineAxis(t);
        if (axis < 0) return Commands.fail('Site unsuitable for tunnel entrance');
        let dir = -1, z = 0;
        for (let d = 0; d < 4; d++) {
            if (Dir.axis(d) !== axis) continue;
            const e = map.edgeCorners(t, d), o = map.edgeCorners(t, Dir.reverse(d));
            if (e[0] > o[0]) { dir = d; z = o[0]; }
        }
        if (dir < 0) return Commands.fail('Site unsuitable for tunnel entrance');
        const x = map.tx(t), y = map.ty(t);
        let end = -1, len = 0;
        for (let i = 1; i < 64; i++) {
            const nx = x + Dir.DX[dir] * i, ny = y + Dir.DY[dir] * i;
            if (!map.valid(nx, ny)) return Commands.fail('Tunnel would end off the map');
            const n = map.idx(nx, ny);
            const e = map.edgeCorners(n, Dir.reverse(dir)), o = map.edgeCorners(n, dir);
            if (map.inclineAxis(n) === axis && o[0] === z && e[0] === z + 1) { end = n; len = i - 1; break; }
            if (map.tileMinZ(n) <= z) return Commands.fail('Excavation would damage another tunnel or the landscape');
        }
        if (end < 0) return Commands.fail('Tunnel too long');
        if (!map.isClearable(end)) return Commands.fail(Commands.occupiedMsg(world, end));
        if (len < 1) return Commands.fail('Tunnel too short');
        let cost = world.price('buildTunnel');
        for (let i = 0; i < len; i++) cost = cost * 1.125 + world.price('buildTunnel');
        cost += Commands.clearCost(world, t) + Commands.clearCost(world, end);
        if (!exec) return Commands.ok(cost);
        const id = world.wormholes.length;
        world.wormholes.push({ id, a: t, b: end, dir, kind: 'tunnel', type: 0, z, rail: transport === 'rail', owner: 0 });
        for (const [p, inner] of [[t, dir], [end, Dir.reverse(dir)]]) {
            Commands.clearForBuild(world, p, true);
            map.type[p] = GameMap.T_TUNBRIDGE;
            map.sub[p] = 2;
            map.obj[p] = id;
            map.density[p] = inner;
            map.wz[p] = z;
            map.owner[p] = 0;
            if (transport === 'rail') { map.rail[p] = 1 << Track.axisTrack(axis); map.railType[p] = railType || 0; }
            else { map.road[p] = axis === 0 ? 5 : 10; map.roadOwner[p] = 0; }
            map.markDirty(p);
        }
        if (transport === 'rail') world.railVersion++;
        return Commands.ok(cost);
    },

    removeWormhole(world, id, exec) {
        const map = world.map, wh = world.wormholes[id];
        if (!wh) return Commands.fail('Nothing here');
        if (wh.owner !== 0) return Commands.fail('Owned by another company');
        for (const v of world.vehicles) {
            if (!v) continue;
            if (v.type === 'train' && v.steps.some(s => s.w === id || s.t === wh.a || s.t === wh.b)) return Commands.fail('Vehicle in the way');
            if (v.type === 'road' && (v.w === id || v.tile === wh.a || v.tile === wh.b) && v.state !== 'depot') return Commands.fail('Vehicle in the way');
        }
        const L = IMath.manhattan(map.tx(wh.a), map.ty(wh.a), map.tx(wh.b), map.ty(wh.b)) + 1;
        const cost = wh.kind === 'bridge' ? world.price('clearBridge') * L : world.price('clearTunnel') * L;
        if (exec) {
            for (const t of [wh.a, wh.b]) map.setClear(t, GameMap.G_GRASS);
            if (wh.kind === 'bridge') {
                const ax = map.tx(wh.a), ay = map.ty(wh.a);
                for (let i = 1; i < L - 1; i++) {
                    const t = map.idx(ax + Dir.DX[wh.dir] * i, ay + Dir.DY[wh.dir] * i);
                    map.over[t] = -1;
                    map.markDirty(t);
                }
            }
            world.wormholes[id] = null;
            if (wh.rail) world.railVersion++;
        }
        return Commands.ok(cost);
    },

    // --- Landscaping ---------------------------------------------------------------------------

    /** Raise (+1) or lower (−1) the corner (cx, cy). */
    terraform(world, cx, cy, dir, exec) {
        const map = world.map;
        const plan = map.planTerraform(cx, cy, dir, (t) => {
            const k = map.type[t];
            if (map.over[t] >= 0) return false;
            if (k === GameMap.T_WATER) return dir > 0 && !map.sub[t];
            return k === GameMap.T_CLEAR || k === GameMap.T_TREES;
        });
        if (!plan) return Commands.fail(dir > 0 ? 'Can\'t raise land here' : 'Can\'t lower land here');
        for (const t of plan.tiles) if (Commands.vehicleOn(world, t)) return Commands.fail('Vehicle in the way');
        const cost = world.price('terraform') * plan.corners.length;
        if (exec) {
            map.applyTerraform(plan);
            // Land that ends at sea level floods (TTD's sea spreads onto level-0 land by the sea).
            for (const t of plan.tiles) {
                if (map.type[t] !== GameMap.T_WATER && map.tileMaxZ(t) === 0) {
                    let wet = false;
                    for (let d = 0; d < 4; d++) { const n = map.neighbour(t, d); if (n >= 0 && map.isWater(n)) wet = true; }
                    if (wet || !map.valid(map.tx(t), map.ty(t))) { map.setClear(t, GameMap.G_GRASS); map.type[t] = GameMap.T_WATER; map.owner[t] = GameMap.OWNER_WATER; map.markDirty(t); }
                }
            }
        }
        return Commands.ok(cost);
    },

    plantTree(world, t, exec) {
        const map = world.map;
        if (map.type[t] === GameMap.T_TREES) {
            if (map.treeCount[t] >= 4) return Commands.fail('Tree already here');
            if (exec) { map.treeCount[t]++; map.markDirty(t); }
            return Commands.ok(world.price('buildTrees'));
        }
        if (map.type[t] !== GameMap.T_CLEAR || map.ground[t] === GameMap.G_FIELDS) return Commands.fail('Can\'t plant tree here');
        if (exec) {
            map.plantTree(t, world.rng, world.climate === 1);
            map.treeCount[t] = 1;
            const town = world.nearestTown(t, 20);
            if (town) town.changeRating(0, 7, null, 220);
        }
        return Commands.ok(world.price('buildTrees'));
    },

    // --- Company ---------------------------------------------------------------------------------

    borrow(world, all) {
        const c = world.player, max = world.maxLoan;
        if (c.loan >= max) return Commands.fail('Can\'t borrow any more money: maximum loan ' + Money.format(max));
        const add = all ? max - c.loan : Math.min(Company.LOAN_STEP, max - c.loan);
        c.loan += add; c.money += add;
        return Commands.ok(0);
    },

    repay(world, all) {
        const c = world.player;
        if (c.loan <= 0) return Commands.fail('No loan to repay');
        let pay = all ? c.loan : Math.min(Company.LOAN_STEP, c.loan);
        if (all) pay = Math.min(c.loan, Math.floor(Math.max(0, c.money) / Company.LOAN_STEP) * Company.LOAN_STEP);
        if (pay <= 0 || c.money < pay) return Commands.fail('Not enough cash to repay the loan');
        c.loan -= pay; c.money -= pay;
        return Commands.ok(0);
    },

    /** Local authority action index (Towns.ACTIONS). */
    townAction(world, town, action, exec) {
        const a = Towns.ACTIONS[action];
        if (!a) return Commands.fail('Unknown action');
        const cost = world.price('buildIndustry') / 256 * a.factor;
        if (town.unwanted[0] > 0) return Commands.fail('The local authority refuses to deal with you');
        if (action === 4 && town.statues[0]) return Commands.fail('Statue already built');
        if (world.player.money < cost) return Commands.fail('Not enough cash - requires ' + Money.format(cost));
        if (!exec) return Commands.ok(cost);
        const map = world.map;
        const around = (radius, amount) => {
            for (const st of world.stations) {
                if (!st || st.owner !== 0) continue;
                if (IMath.manhattan(map.tx(st.xy), map.ty(st.xy), map.tx(town.xy), map.ty(town.xy)) > radius) continue;
                for (const g of st.goods) if (g.active) g.rating = Math.min(255, g.rating + amount);
            }
        };
        switch (action) {
            case 0: around(10, 64); break;
            case 1: around(15, 112); break;
            case 2: around(20, 160); break;
            case 3: town.roadWorks = 6; break;
            case 4: {
                town.statues[0] = true;
                town.changeRating(0, 200, null, 1000);
                // A statue on a free tile near the centre.
                for (let r = 1; r < 6; r++) {
                    let placed = false;
                    for (let dy = -r; dy <= r && !placed; dy++) for (let dx = -r; dx <= r && !placed; dx++) {
                        const x = map.tx(town.xy) + dx, y = map.ty(town.xy) + dy;
                        if (!map.valid(x, y)) continue;
                        const t = map.idx(x, y);
                        if (map.isClearable(t) && map.isFlat(t)) {
                            map.setClear(t, GameMap.G_GRASS);
                            map.type[t] = GameMap.T_OBJECT; map.sub[t] = 1; map.owner[t] = 0; map.town[t] = town.id; map.markDirty(t);
                            placed = true;
                        }
                    }
                    if (placed) break;
                }
                break;
            }
            case 5: town.fundMonths = 3; break;
            case 6:
                town.exclusive = 0; town.exclusiveMonths = 12;
                town.changeRating(0, 130, null, 1000);
                break;
            case 7:
                if (world.rng.chance(1, 15)) {
                    town.unwanted[0] = 6;
                    town.ratings[0] = -50;
                    for (const st of world.stations) if (st && st.owner === 0 && st.town === town.id) for (const g of st.goods) g.rating = 0;
                    world.addNews('Bribery attempt uncovered! ' + town.name + ' local authority takes company to court: no more deals for 6 months.', { kind: 'company', big: true });
                } else {
                    town.changeRating(0, 200, null, 800);
                }
                break;
        }
        world.player.spend(cost, Company.C_OTHER);
        return Commands.ok(cost);
    },
};
