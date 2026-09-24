// TTDRoadVehicle.js — buses and lorries of the TTD remake. A road vehicle crosses a tile from the
// edge it entered to the edge it leaves by (straight, a turn, or a U-turn at a dead end),
// keeping to its lane (Track.roadPoint). At junctions it follows an A* path to its order's road
// stop (bus stops for passengers, lorry bays for freight) or depot; it queues behind vehicles
// ahead and waits at level crossings while a train is on them. Stops are drive-through: the
// vehicle halts in its lane at the middle of the stop tile to load.

class RoadVehicle extends Vehicle {
    constructor(id, owner, engineId) {
        super(id, 'road', owner, engineId);
        this.tile = -1;
        this.a = 0;
        this.b = 0;
        this.f = 0;
        this.len = 1;
        this.w = -1;          // on a bridge/tunnel gap: the wormhole index
        this.fromA = false;
        this.stopHere = false;
        this.waitTicks = 0;
    }

    isBus(world) { return this.cars[0].slot === world.cargoSlot('passengers'); }

    placeInDepot(world) {
        const d = world.depots[this.depot];
        this.state = 'depot';
        this.speed = 0;
        this.w = -1;
        if (d) {
            this.tile = d.t;
            this.x = world.map.tx(d.t) + 0.5; this.y = world.map.ty(d.t) + 0.5; this.z = world.map.buildZ(d.t);
        }
        this.parts = [{ x: this.x, y: this.y, z: this.z, heading: 0, grade: 0, hidden: true }];
    }

    tryLeave(world) {
        if (!this.orders.length) return;
        const d = world.depots[this.depot];
        if (!d) return;
        // Do not pull out into another vehicle.
        for (const o of world.vehicles) {
            if (!o || o === this || o.type !== 'road' || o.state === 'depot') continue;
            if (Math.hypot(o.x - (world.map.tx(d.t) + 0.5), o.y - (world.map.ty(d.t) + 0.5)) < 0.6) return;
        }
        this.tile = d.t;
        this.a = Dir.reverse(d.dir);
        this.b = d.dir;
        this.len = Track.roadLength(this.a, this.b);
        this.f = this.len * 0.5;
        this.state = 'run';
        this.depot = -1;
        this.path = null;
        this.updatePos(world);
    }

    enterDepot(world, id) {
        this.depot = id;
        this.placeInDepot(world);
        this.serviceAt(world);
        const o = this.order();
        if (o && o.kind === 'depot' && o.dest === id) {
            if (o.stop) this.stopped = true;
            this.nextOrder();
        }
    }

    tick(world) {
        if (this.state === 'crashed') {
            if (--this.crashed <= 0) Vehicles.remove(world, this);
            return;
        }
        if (this.state === 'depot') {
            if (!this.stopped) this.tryLeave(world);
            return;
        }
        if (this.stopped) { this.speed = 0; return; }
        if (this.broken > 0) { this.broken--; this.speed = 0; return; }
        if (this.state === 'load') {
            if (this.loadingTick(world)) { this.finishLoading(world); this.stopHere = false; this.path = null; }
            return;
        }
        this.move(world);
    }

    maxSpeedNow(world) {
        let v = this.maxSpeed();
        if (this.w >= 0) {
            const wh = world.wormholes[this.w];
            if (wh && wh.kind === 'bridge') v = Math.min(v, TTDData.BRIDGES[wh.type].speed);
        }
        return v;
    }

    move(world) {
        const K = Vehicles.K;
        let lim = 10;
        const map = world.map;
        if (this.w < 0) {
            // Stop in the middle of an ordered road stop.
            if (this.isGoalStop(world, this.tile) && this.f < this.len * 0.5) lim = this.len * 0.5 - this.f;
            const dep = this.destDepot();
            if (dep >= 0 && world.depots[dep] && world.depots[dep].t === this.tile) lim = Math.min(lim, Math.max(0, this.len * 0.45 - this.f));
            // Level crossing ahead occupied by a train: wait at the tile edge.
            if (this.f > this.len - 0.6) {
                const n = map.neighbour(this.tile, this.b);
                if (n >= 0 && map.type[n] === GameMap.T_ROAD && map.sub[n] === GameMap.ROAD_SUB_CROSSING &&
                    Trains.occupiedBy(world, n * 8 + (map.rail[n] & 1 ? 0 : 1), null)) lim = Math.min(lim, Math.max(0, this.len - this.f - 0.05));
            }
        }
        // Queue behind the vehicle ahead in the same lane.
        const ahead = this.vehicleAhead(world);
        if (ahead >= 0) lim = Math.min(lim, ahead);
        const vmax = this.maxSpeedNow(world);
        const allowed = Math.min(vmax, Math.sqrt(Math.max(0, 2 * 4 * lim / K)));
        if (this.speed < allowed) this.speed = Math.min(allowed, this.speed + 1.2);
        else this.speed = Math.max(allowed, this.speed - 4);
        if (lim < 0.01 && this.speed < 1) {
            this.speed = 0;
            this.checkStop(world);
            return;
        }
        this.advance(world, this.speed * K);
    }

    /** Distance to the vehicle ahead in the same lane (-1 — none close). */
    vehicleAhead(world) {
        const hx = Math.cos(this.heading), hy = Math.sin(this.heading);
        let best = -1;
        for (const o of world.vehicles) {
            if (!o || o === this || o.type !== 'road' || o.state === 'depot' || o.state === 'crashed') continue;
            const dx = o.x - this.x, dy = o.y - this.y;
            if (dx * dx + dy * dy > 1) continue;
            const along = dx * hx + dy * hy, side = Math.abs(-dx * hy + dy * hx);
            if (along <= 0.05 || along > 0.7 || side > 0.16) continue;
            // Only vehicles going roughly the same way block (the other lane is free).
            if (Math.cos(o.heading - this.heading) < 0.2) continue;
            const gap = Math.max(0, along - 0.42);
            if (best < 0 || gap < best) best = gap;
        }
        return best;
    }

    isGoalStop(world, t) {
        const map = world.map;
        if (map.type[t] !== GameMap.T_STATION || map.obj[t] !== this.destStation()) return false;
        const k = map.sub[t];
        return this.isBus(world) ? k === GameMap.ST_BUS : k === GameMap.ST_TRUCK;
    }

    checkStop(world) {
        if (this.w >= 0) return;
        if (this.isGoalStop(world, this.tile) && this.f >= this.len * 0.5 - 0.02) {
            const st = world.stations[this.destStation()];
            if (st) this.startLoading(world, st);
            return;
        }
        const dep = this.destDepot();
        if (dep >= 0 && world.depots[dep] && world.depots[dep].t === this.tile && this.f >= this.len * 0.45 - 0.02) {
            this.enterDepot(world, dep);
        }
    }

    advance(world, delta) {
        const map = world.map;
        this.f += delta;
        for (let guard = 0; guard < 6; guard++) {
            if (this.w < 0) {
                if (this.isGoalStop(world, this.tile) && this.f >= this.len * 0.5 - 0.02 && this.f - delta < this.len * 0.5 + 0.02) {
                    this.f = this.len * 0.5;
                    this.updatePos(world);
                    this.checkStop(world);
                    return;
                }
                const dep = this.destDepot();
                if (dep >= 0 && world.depots[dep] && world.depots[dep].t === this.tile && this.f >= this.len * 0.45) {
                    this.enterDepot(world, dep);
                    return;
                }
            }
            if (this.f < this.len) break;
            if (!this.nextTile(world)) { this.f = this.len; this.speed = 0; break; }
        }
        this.updatePos(world);
    }

    /** Cross into the next tile; returns false if the vehicle must wait. */
    nextTile(world) {
        const map = world.map;
        const over = this.f - this.len;
        if (this.w >= 0) {
            const wh = world.wormholes[this.w];
            const far = this.fromA ? wh.b : wh.a;
            this.w = -1;
            this.tile = far;
            this.a = map.density[far];
            this.b = Dir.reverse(this.a);
            this.len = Track.roadLength(this.a, this.b);
            this.f = over;
            return true;
        }
        const t = this.tile, b = this.b;
        if (map.type[t] === GameMap.T_TUNBRIDGE && map.density[t] === b && map.road[t]) {
            const wh = world.wormholes[map.obj[t]];
            if (wh) {
                this.w = wh.id;
                this.fromA = wh.a === t;
                this.len = Math.max(0.01, Vehicles.wormholeLen(world, wh));
                this.f = over;
                return true;
            }
        }
        const n = Track.roadConnects(map, t, b);
        if (n < 0) {
            // The road ahead is gone: turn round here.
            this.a = b; this.b = b;
            this.len = Track.roadLength(this.a, this.b);
            this.f = 0;
            this.path = null;
            return true;
        }
        if (map.type[n] === GameMap.T_ROAD && map.sub[n] === GameMap.ROAD_SUB_CROSSING &&
            Trains.occupiedBy(world, n * 8 + (map.rail[n] & 1 ? 0 : 1), null)) return false;
        this.tile = n;
        this.a = Dir.reverse(b);
        this.b = this.chooseExit(world, n, this.a);
        this.len = Track.roadLength(this.a, this.b);
        this.f = over;
        return true;
    }

    /** Exit edge on tile t for a vehicle that entered through edge a. */
    chooseExit(world, t, a) {
        const map = world.map;
        const bits = Track.roadBits(map, t);
        // A road depot: in if it is the goal, otherwise turn round in front of it.
        if (map.type[t] === GameMap.T_ROAD && map.sub[t] === GameMap.ROAD_SUB_DEPOT) return a;
        const opts = [];
        for (let d = 0; d < 4; d++) {
            if (d === a || !(bits & (1 << d))) continue;
            if (map.type[t] === GameMap.T_TUNBRIDGE && map.density[t] === d) { opts.push(d); continue; }
            if (Track.roadConnects(map, t, d) >= 0) opts.push(d);
        }
        if (!opts.length) return a;   // dead end: U-turn
        if (opts.length === 1) return opts[0];
        const r = RoadVehicles.route(world, this, t, a, opts);
        return r >= 0 ? r : opts[world.rng.int(opts.length)];
    }

    updatePos(world) {
        const map = world.map;
        let p;
        if (this.w >= 0) {
            const wh = world.wormholes[this.w];
            p = Vehicles.wormholePoint(world, wh, this.fromA, this.f);
            // Keep to the lane on bridges too.
            const off = 0.17, hx = Math.cos(p.heading), hy = Math.sin(p.heading);
            p.x += -hy * off * 2 * 0.5; p.y += hx * off * 2 * 0.5;
            this.x = p.x; this.y = p.y; this.z = p.z; this.heading = p.heading;
            this.parts = [{ x: p.x, y: p.y, z: p.z, heading: p.heading, grade: 0, hidden: !!p.tunnel }];
            return;
        }
        const fr = Math.max(0, Math.min(1, this.f / this.len));
        p = Track.roadPoint(map, this.tile, this.a, this.b, fr);
        const z = Track.roadZ(map, this.tile, this.a, this.b, fr);
        const za = Track.roadEdgeZ(map, this.tile, this.a), zb = Track.roadEdgeZ(map, this.tile, this.b);
        this.x = p.x; this.y = p.y; this.z = z; this.heading = p.heading;
        this.parts = [{ x: p.x, y: p.y, z, heading: p.heading, grade: this.a === this.b ? 0 : (zb - za) / this.len, hidden: false }];
    }

    requestService(world) {
        const map = world.map;
        let best = -1, bd = 16;
        for (const d of world.depots) {
            if (!d || d.kind !== 'road' || d.owner !== this.owner) continue;
            const dist = IMath.manhattan(map.tx(d.t), map.ty(d.t), Math.floor(this.x), Math.floor(this.y));
            if (dist < bd) { bd = dist; best = d.id; }
        }
        if (best >= 0) { this.serviceDepot = best; this.path = null; }
    }

    relink(world) {
        this.path = null;
        if (this.state === 'depot') this.placeInDepot(world);
        else this.updatePos(world);
    }
}

/** @satisfies {Record<string, any>} */
const RoadVehicles = {
    goals(world, v) {
        const dep = v.destDepot();
        if (dep >= 0 && world.depots[dep]) return { tiles: new Set([world.depots[dep].t]), center: world.depots[dep].t };
        const st = world.stations[v.destStation()];
        if (!st) return null;
        const kind = v.isBus(world) ? GameMap.ST_BUS : GameMap.ST_TRUCK;
        const tiles = new Set(st.parts.filter(p => p.kind === kind).map(p => p.t));
        if (!tiles.size) return null;
        return { tiles, center: [...tiles][0] };
    },

    /** Choose among exit edges `opts` of tile t (entered through a) by A*. */
    route(world, v, t, a, opts) {
        const goals = RoadVehicles.goals(world, v);
        if (!goals) return -1;
        const map = world.map;
        const gx = map.tx(goals.center), gy = map.ty(goals.center);
        const h = (tile) => IMath.manhattan(map.tx(tile), map.ty(tile), gx, gy);
        const goal = (n) => goals.tiles.has(n.tile);
        const next = (n) => RoadVehicles.successors(world, n);
        let best = -1, bestCost = 1e9;
        for (const d of opts) {
            let start;
            if (map.type[t] === GameMap.T_TUNBRIDGE && map.density[t] === d) {
                const wh = world.wormholes[map.obj[t]];
                const far = wh.a === t ? wh.b : wh.a;
                start = { tile: far, td: map.density[far] };
            } else {
                const n = Track.roadConnects(map, t, d);
                if (n < 0) continue;
                start = { tile: n, td: Dir.reverse(d) };
            }
            const path = PathFinder.search(start, goal, next, h, 8000);
            if (path && path.length < bestCost) { bestCost = path.length; best = d; }
        }
        return best;
    },

    successors(world, n) {
        const map = world.map, t = n.tile, a = n.td, out = [];
        const bits = Track.roadBits(map, t);
        if (map.type[t] === GameMap.T_ROAD && map.sub[t] === GameMap.ROAD_SUB_DEPOT) return out;
        for (let d = 0; d < 4; d++) {
            if (d === a || !(bits & (1 << d))) continue;
            if (map.type[t] === GameMap.T_TUNBRIDGE && map.density[t] === d) {
                const wh = world.wormholes[map.obj[t]];
                if (!wh) continue;
                const far = wh.a === t ? wh.b : wh.a;
                out.push({ tile: far, td: map.density[far], cost: Vehicles.wormholeLen(world, wh) + 1 });
                continue;
            }
            const nt = Track.roadConnects(map, t, d);
            if (nt < 0) continue;
            out.push({ tile: nt, td: Dir.reverse(d), cost: (d ^ a) === 2 ? 1 : 1.3 });
        }
        if (!out.length) {
            const nt = Track.roadConnects(map, t, a);
            if (nt >= 0) out.push({ tile: nt, td: Dir.reverse(a), cost: 4 });
        }
        return out;
    },
};
