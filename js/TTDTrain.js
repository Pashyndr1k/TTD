// TTDTrain.js — trains of the TTD remake. A train is a consist of cars (engines and wagons, half
// a tile each) that follows a list of track pieces ("steps", front first). The front picks the
// next piece at every tile edge: the only one, or the one on the A* path to the order's
// station/depot; 90° turns are forbidden (openttd.cfg forbid_90_deg). Block signals: a piece
// carrying a signal facing the train is passable only while the block behind it (everything
// reachable up to the next signals) holds no other train. With no signals trains share the
// track and can collide — TTD crashes. Trains reverse only at the end of a line; at a station
// they stop with the front at the far end of the platform.

class Train extends Vehicle {
    constructor(id, owner, engineId) {
        super(id, 'train', owner, engineId);
        /** Occupied pieces, front first: { t, td, len, w (wormhole or -1), fromA }. */
        this.steps = [];
        this.pos = 0;
        this.stopTarget = null;
        this.deadEndWait = 0;
        this.lost = false;
        this._peek = null;
    }

    get length() { return this.cars.length * Vehicles.CAR_LEN; }

    maxSpeed() {
        let v = 1e9;
        for (const car of this.cars) {
            const e = World.ENGINE[car.engine];
            if (!e.wagon) v = Math.min(v, e.speed);
        }
        return v === 1e9 ? 0 : v;
    }

    power() {
        let p = 0;
        for (const car of this.cars) { const e = World.ENGINE[car.engine]; if (!e.wagon) p += e.power; }
        return p;
    }

    weight(world) {
        let w = 0;
        for (const car of this.cars) {
            const e = World.ENGINE[car.engine];
            w += e.weight;
            if (car.slot >= 0 && car.cargo.length) {
                const c = world.cargo(car.slot);
                if (c) w += this.cargoCount(car) * c.weight / 16;
            }
        }
        return Math.max(1, w);
    }

    /** Can the train run on track of this rail type? */
    railOk(r) {
        for (const car of this.cars) if (!Vehicles.railCompatible(World.ENGINE[car.engine].rail, r)) return false;
        return true;
    }

    hasEngine() { return this.cars.some(c => !World.ENGINE[c.engine].wagon); }

    // --- Depot ---------------------------------------------------------------------------

    placeInDepot(world) {
        const d = world.depots[this.depot];
        this.steps = [];
        this.state = 'depot';
        this.speed = 0;
        if (d) { this.x = world.map.tx(d.t) + 0.5; this.y = world.map.ty(d.t) + 0.5; this.z = world.map.buildZ(d.t); }
        this.parts = this.cars.map(() => ({ x: this.x, y: this.y, z: this.z, heading: 0, grade: 0, hidden: true }));
    }

    tryLeave(world) {
        if (!this.orders.length || !this.hasEngine()) return;
        const d = world.depots[this.depot];
        if (!d) return;
        const map = world.map;
        const track = Track.axisTrack(Dir.axis(d.dir));
        const td = Track.tdFrom(track, Dir.reverse(d.dir));
        const step = { t: d.t, td, len: 1, w: -1, fromA: false };
        // Do not drive out into another train.
        if (Trains.occupiedBy(world, Trains.key(world, step), this)) return;
        const out = Track.railNext(map, d.t, d.dir, Track.railEdgeZ(map, d.t, track, d.dir), r => this.railOk(r));
        if (out.tds.some(td2 => Trains.occupiedBy(world, Trains.key(world, { t: out.tile, td: td2, w: -1 }), this))) return;
        this.steps = [step];
        this.pos = 0.5;
        Trains.occupy(world, this, step, 1);
        this.state = 'run';
        this.depot = -1;
        this._peek = null;
        this.path = null;
        this.updateParts(world);
    }

    enterDepot(world, depotId) {
        this.releaseAll(world);
        this.depot = depotId;
        this.placeInDepot(world);
        this.serviceAt(world);
        const o = this.order();
        if (o && o.kind === 'depot' && o.dest === depotId) {
            if (o.stop) { this.stopped = true; if (this.owner === 0) world.addNews(this.displayName() + ' is waiting in depot.', { kind: 'vehicle', tile: world.depots[depotId].t }); }
            this.nextOrder();
        }
    }

    // --- Occupancy -------------------------------------------------------------------------

    releaseAll(world) {
        for (const s of this.steps) Trains.occupy(world, this, s, -1);
        this.steps = [];
    }

    release(world) { this.releaseAll(world); }

    // --- Tick ------------------------------------------------------------------------------

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
        if (this.broken > 0) {
            this.broken--;
            this.speed = Math.max(0, this.speed - 6);
            if (this.speed > 0) this.advance(world, this.speed * Vehicles.K);
            return;
        }
        if (this.state === 'load') {
            if (this.loadingTick(world)) this.finishLoading(world);
            return;
        }
        this.move(world);
    }

    move(world) {
        const K = Vehicles.K;
        const vmax = this.speedLimit(world);
        const decel = Math.max(5, vmax / 30);
        const lim = this.distanceToObstacle(world);
        const allowed = Math.min(vmax, Math.sqrt(Math.max(0, 2 * decel * lim / K)));
        const s0 = this.steps[0];
        const grade = s0 ? Trains.stepPoint(world, s0, this.pos).grade : 0;
        if (this.speed < allowed) {
            const pw = this.power(), wt = this.weight(world);
            let acc = IMath.clamp(pw / wt * 0.35, 0.08, 2.5);
            if (world.settings.trainAccel && grade > 0) acc -= grade * 0.9 * wt / (wt + pw * 0.12);
            this.speed = IMath.clamp(this.speed + acc, 0, allowed);
            if (acc < 0 && this.speed < 8 && allowed > 8) this.speed = Math.min(8, allowed);
        } else {
            this.speed = Math.max(allowed, this.speed - decel);
        }
        if (lim <= 1e-4 && this.speed < 1) {
            this.speed = 0;
            this.advance(world, 0);   // arrival at a platform end or a depot happens here
            if (this.state === 'run') this.atObstacle(world);
            return;
        }
        this.deadEndWait = 0;
        this.advance(world, this.speed * K);
    }

    speedLimit(world) {
        let v = this.maxSpeed();
        for (const s of this.steps) {
            if (s.w >= 0) {
                const wh = world.wormholes[s.w];
                if (wh && wh.kind === 'bridge') v = Math.min(v, TTDData.BRIDGES[wh.type].speed);
            }
        }
        if (this.broken > 0) v = Math.min(v, 20);
        return Math.max(5, v);
    }

    /** Tiles the front may still move before it must stand still. */
    distanceToObstacle(world) {
        const s0 = this.steps[0];
        if (!s0) return 0;
        const d0 = s0.len - this.pos;
        if (this.stopTarget && s0.t === this.stopTarget.t && s0.w < 0) return Math.max(0, d0);
        const dep = this.destDepot();
        if (dep >= 0 && world.depots[dep] && s0.t === world.depots[dep].t && s0.w < 0) return Math.max(0, 0.5 - this.pos);
        const nx = this.peek(world);
        if (!nx.step || nx.blocked) return Math.max(0, d0);
        let extra = nx.step.len;
        if (this.stopTarget) extra = Math.min(extra, 0.5);
        return d0 + extra;
    }

    /** Standing at a red signal or at the end of the line. */
    atObstacle(world) {
        const nx = this.peek(world);
        if (!nx.step && !nx.blocked) {
            // End of line: TTD reverses the train after a short wait.
            if (++this.deadEndWait > 20) { this.deadEndWait = 0; this.reverse(world); }
        }
    }

    advance(world, delta) {
        if (!this.steps.length) return;
        this.pos += delta;
        for (let guard = 0; guard < 8; guard++) {
            const s0 = this.steps[0];
            if (this.stopTarget && s0.t === this.stopTarget.t && s0.w < 0 && this.pos >= s0.len - 1e-6) {
                this.pos = s0.len;
                this.arrive(world);
                break;
            }
            const dep = this.destDepot();
            if (dep >= 0 && world.depots[dep] && s0.t === world.depots[dep].t && s0.w < 0 && this.pos >= 0.5) {
                this.enterDepot(world, dep);
                return;
            }
            if (this.pos < s0.len) break;
            const nx = this.peek(world);
            if (!nx.step || nx.blocked) { this.pos = s0.len; this.speed = 0; break; }
            const over = this.pos - s0.len;
            this.steps.unshift(nx.step);
            Trains.occupy(world, this, nx.step, 1);
            this._peek = null;
            this.pos = over;
            this.onEnterPiece(world, nx.step);
        }
        this.trim(world);
        this.updateParts(world);
    }

    trim(world) {
        let covered = this.pos;
        const L = this.length + 0.01;
        for (let i = 1; i < this.steps.length; i++) {
            if (covered >= L) {
                const cut = this.steps.splice(i);
                for (const s of cut) Trains.occupy(world, this, s, -1);
                break;
            }
            covered += this.steps[i].len;
        }
    }

    onEnterPiece(world, step) {
        if (step.w >= 0) return;
        const map = world.map, t = step.t;
        const dest = this.destStation();
        if (dest < 0 || this.stopTarget) return;
        if (map.type[t] !== GameMap.T_STATION || map.sub[t] !== GameMap.ST_RAIL || map.obj[t] !== dest) return;
        const track = step.td >> 1;
        if (track > 1) return;
        // Stop with the front at the far end of the platform.
        const exit = Track.tdExit(step.td);
        let end = t;
        for (let i = 0; i < 64; i++) {
            const n = map.neighbour(end, exit);
            if (n < 0 || map.type[n] !== GameMap.T_STATION || map.sub[n] !== GameMap.ST_RAIL || map.obj[n] !== dest || !(map.rail[n] & (1 << track))) break;
            end = n;
        }
        this.stopTarget = { t: end, track };
    }

    arrive(world) {
        const st = world.stations[this.destStation()];
        this.stopTarget = null;
        this.speed = 0;
        if (st) this.startLoading(world, st);
        this.updateParts(world);
    }

    finishLoading(world) {
        super.finishLoading(world);
        this._peek = null;
        this.path = null;
    }

    onOrderChanged() {
        this.path = null;
        this._peek = null;
        this.stopTarget = null;
    }

    // --- Choosing the next piece -----------------------------------------------------------

    /** Next piece and whether it may be entered now; the choice is cached per front piece. */
    peek(world) {
        const s0 = this.steps[0];
        if (!this._peek || this._peek.from !== s0) this._peek = { from: s0, step: this.chooseNext(world), blocked: false };
        const p = this._peek;
        p.blocked = !!p.step && Trains.signalRed(world, p.step, this);
        return p;
    }

    /** Candidate pieces after the front piece. */
    candidates(world, s0) {
        const map = world.map;
        if (s0.w >= 0) {
            const wh = world.wormholes[s0.w];
            const far = s0.fromA ? wh.b : wh.a;
            const inner = map.density[far];
            const td = Track.tdFrom(Track.axisTrack(Dir.axis(inner)), inner);
            return [{ t: far, td, len: 1, w: -1, fromA: false }];
        }
        const t = s0.t, exit = Track.tdExit(s0.td);
        if (map.type[t] === GameMap.T_TUNBRIDGE && map.density[t] === exit) {
            const wh = world.wormholes[map.obj[t]];
            if (wh) return [{ t, td: s0.td, len: Math.max(0.01, Vehicles.wormholeLen(world, wh)), w: wh.id, fromA: wh.a === t }];
        }
        const z = Track.railEdgeZ(map, t, s0.td >> 1, exit);
        const r = Track.railNext(map, t, exit, z, rt => this.railOk(rt));
        const out = [];
        const depDest = this.destDepot();
        for (const td of r.tds) {
            if (!Track.smooth(s0.td, td)) continue;
            const n = r.tile;
            if (map.type[n] === GameMap.T_RAIL && map.sub[n] === GameMap.RAIL_SUB_DEPOT) {
                const dep = world.depots[map.obj[n]];
                if (!dep || Dir.reverse(exit) !== dep.dir) continue;
                if (depDest !== dep.id) continue;   // only a depot the train is heading for
            }
            out.push({ t: n, td, len: Track.length(td >> 1), w: -1, fromA: false });
        }
        return out;
    }

    chooseNext(world) {
        const s0 = this.steps[0];
        const cands = this.candidates(world, s0);
        if (cands.length <= 1) return cands[0] || null;
        const choice = Trains.route(world, this, s0, cands);
        return choice || cands[0];
    }

    // --- Reversing -----------------------------------------------------------------------------

    reverse(world) {
        if (!this.steps.length) return;
        // Find where the tail is.
        let d = this.pos - this.length, j = 0;
        while (d < 0 && j + 1 < this.steps.length) { j++; d += this.steps[j].len; }
        if (d < 0) d = 0;
        const keep = this.steps.slice(0, j + 1);
        const drop = this.steps.slice(j + 1);
        for (const s of drop) Trains.occupy(world, this, s, -1);
        const rev = keep.reverse().map(s => s.w >= 0 ? { t: s.t, td: s.td ^ 1, len: s.len, w: s.w, fromA: !s.fromA } : { t: s.t, td: s.td ^ 1, len: s.len, w: -1, fromA: false });
        // The new front is the old tail: it stands (len - d) into its reversed piece.
        this.steps = rev;
        this.pos = rev[0].len - d;
        for (const car of this.cars) car.flip = !car.flip;
        this.cars.reverse();
        this._peek = null;
        this.path = null;
        this.stopTarget = null;
        this.updateParts(world);
    }

    // --- Car positions -------------------------------------------------------------------------

    updateParts(world) {
        const n = this.cars.length;
        if (this.parts.length !== n) this.parts = this.cars.map(() => ({ x: 0, y: 0, z: 0, heading: 0, grade: 0, hidden: true }));
        for (let i = 0; i < n; i++) {
            const p = this.parts[i];
            let d = this.pos - (i + 0.5) * Vehicles.CAR_LEN, k = 0;
            while (d < 0 && k + 1 < this.steps.length) { k++; d += this.steps[k].len; }
            if (d < 0 || !this.steps.length) { p.hidden = true; continue; }
            const pt = Trains.stepPoint(world, this.steps[k], d);
            p.x = pt.x; p.y = pt.y; p.z = pt.z; p.grade = pt.grade;
            p.heading = pt.heading + (this.cars[i].rearHead ? Math.PI : 0) + (this.cars[i].flip ? Math.PI : 0);
            p.hidden = !!pt.tunnel;
        }
        if (this.parts[0]) { this.x = this.parts[0].x; this.y = this.parts[0].y; this.z = this.parts[0].z; this.heading = this.parts[0].heading; }
    }

    // --- Service -------------------------------------------------------------------------------

    requestService(world) {
        const map = world.map;
        let best = -1, bd = 24;
        for (const d of world.depots) {
            if (!d || d.kind !== 'rail' || d.owner !== this.owner) continue;
            const dist = IMath.manhattan(map.tx(d.t), map.ty(d.t), Math.floor(this.x), Math.floor(this.y));
            if (dist < bd) { bd = dist; best = d.id; }
        }
        if (best >= 0) { this.serviceDepot = best; this.path = null; this._peek = null; }
    }

    onBreakdown(world) {
        if (this.owner === 0) world.emit('breakdown', this);
    }

    toJSON() {
        const o = super.toJSON();
        delete o._peek;
        return o;
    }

    relink(world) {
        this._peek = null;
        this.path = null;
        this.parts = [];
        if (this.state === 'depot') this.placeInDepot(world);
        else this.updateParts(world);
    }
}

/** @satisfies {Record<string, any>} */
const Trains = {
    key(world, s) { return s.w >= 0 ? world.map.size * 8 + s.w : s.t * 8 + (s.td >> 1); },

    occupy(world, train, step, delta) {
        const k = Trains.key(world, step);
        let m = world.railOcc.get(k);
        if (!m) { if (delta < 0) return; m = new Map(); world.railOcc.set(k, m); }
        const c = (m.get(train.id) || 0) + delta;
        if (c > 0) m.set(train.id, c); else m.delete(train.id);
        if (!m.size) world.railOcc.delete(k);
    },

    occupiedBy(world, key, self) {
        const m = world.railOcc.get(key);
        if (!m) return false;
        for (const id of m.keys()) if (!self || id !== self.id) return true;
        return false;
    },

    stepPoint(world, s, d) {
        if (s.w >= 0) {
            const wh = world.wormholes[s.w];
            if (!wh) return { x: 0, y: 0, z: 0, heading: 0, grade: 0 };
            return Vehicles.wormholePoint(world, wh, s.fromA, d);
        }
        return Track.pointOn(world.map, s.t, s.td, d);
    },

    /** Is there a signal facing the train on this piece, and is the block behind it taken? */
    signalRed(world, step, train) {
        if (step.w >= 0) return false;
        const sig = world.map.signals[step.t];
        if (!sig || !((sig >> step.td) & 1)) return false;
        return Trains.blockOccupied(world, step.t, step.td, train);
    },

    blockOccupied(world, t, td, train) {
        for (const k of Trains.blockMembers(world, t, td)) if (Trains.occupiedBy(world, k, train)) return true;
        return false;
    },

    /**
     * Pieces of the block a signal on (t, td) guards: the piece itself and everything reachable
     * beyond its exit up to (and including) the next pieces that carry signals.
     */
    blockMembers(world, t, td) {
        const ck = t * 16 + td;
        const cached = world.blockCache.get(ck);
        if (cached && cached.v === world.railVersion) return cached.m;
        const map = world.map, seen = new Set(), out = [];
        const add = (k) => { if (seen.has(k)) return false; seen.add(k); out.push(k); return true; };
        add(t * 8 + (td >> 1));
        const queue = [];
        // From the exit edge of the signal piece.
        Trains.expand(world, t, td >> 1, Track.tdExit(td), queue);
        while (queue.length) {
            const [pt, ptr, isW] = queue.pop();
            if (isW) {
                const k = map.size * 8 + pt;
                if (!add(k)) continue;
                const wh = world.wormholes[pt];
                if (!wh) continue;
                for (const head of [wh.a, wh.b]) {
                    const tr = Track.axisTrack(Dir.axis(wh.dir));
                    const hk = head * 8 + tr;
                    if (seen.has(hk)) continue;
                    add(hk);
                    if (!map.signals[head]) for (const e of Track.EDGES[tr]) Trains.expand(world, head, tr, e, queue);
                }
                continue;
            }
            const k = pt * 8 + ptr;
            if (!add(k)) continue;
            if (map.signals[pt] & (3 << (ptr * 2))) continue;   // a signal ends the block
            for (const e of Track.EDGES[ptr]) Trains.expand(world, pt, ptr, e, queue);
        }
        world.blockCache.set(ck, { v: world.railVersion, m: out });
        return out;
    },

    /** Neighbouring pieces across edge e of piece (t, track). */
    expand(world, t, track, e, queue) {
        const map = world.map;
        if (map.type[t] === GameMap.T_TUNBRIDGE && map.density[t] === e) { queue.push([map.obj[t], 0, true]); return; }
        const z = Track.railEdgeZ(map, t, track, e);
        const r = Track.railNext(map, t, e, z, null);
        for (const td of r.tds) queue.push([r.tile, td >> 1, false]);
    },

    /** Goal tiles of a train's current destination. */
    goals(world, train) {
        const dep = train.destDepot();
        if (dep >= 0 && world.depots[dep]) return { tiles: new Set([world.depots[dep].t]), center: world.depots[dep].t, depot: true };
        const st = world.stations[train.destStation()];
        if (!st) return null;
        const tiles = new Set(st.parts.filter(p => p.kind === GameMap.ST_RAIL).map(p => p.t));
        if (!tiles.size) return null;
        return { tiles, center: st.parts.find(p => p.kind === GameMap.ST_RAIL).t, depot: false };
    },

    /** A* from the train's front piece; returns the candidate on the best path. */
    route(world, train, s0, cands) {
        const goals = Trains.goals(world, train);
        if (!goals) return null;
        const map = world.map;
        const key = (goals.depot ? 'd' : 's') + goals.center;
        // Follow a cached path while it still matches.
        const P = train.path;
        if (P && P.key === key && P.v === world.railVersion) {
            const i = P.nodes.findIndex((n, j) => j >= P.i && n.tile === (s0.w >= 0 ? -1 : s0.t) && n.td === s0.td);
            if (i >= 0 && i + 1 < P.nodes.length) {
                const nx = P.nodes[i + 1];
                const c = cands.find(c => c.t === nx.tile && c.td === nx.td);
                if (c) { P.i = i + 1; return c; }
            }
        }
        const gx = map.tx(goals.center), gy = map.ty(goals.center);
        const h = (t) => IMath.manhattan(map.tx(t), map.ty(t), gx, gy) * 0.9;
        const goal = (n) => goals.tiles.has(n.tile) && (goals.depot || (n.td >> 1) <= 1);
        const next = (n) => Trains.successors(world, train, n, goals);
        let best = null;
        for (const c of cands) {
            const path = PathFinder.search({ tile: c.t, td: c.td }, goal, next, h, 15000);
            if (!path) continue;
            let cost = 0;
            for (let i = 1; i < path.length; i++) cost += path[i].tile === path[i - 1].tile && (path[i].td ^ 1) === path[i - 1].td ? 8 : 1;
            if (!best || cost < best.cost) best = { c, cost, path };
        }
        if (!best) {
            if (!train.lost && train.owner === 0) world.addNews(train.displayName() + ' is lost.', { kind: 'vehicle', tile: s0.t });
            train.lost = true;
            return null;
        }
        train.lost = false;
        train.path = { key, v: world.railVersion, nodes: best.path, i: 0 };
        return best.c;
    },

    successors(world, train, n, goals) {
        const map = world.map, t = n.tile, td = n.td, exit = Track.tdExit(td);
        const out = [];
        if (map.type[t] === GameMap.T_TUNBRIDGE && map.density[t] === exit) {
            const wh = world.wormholes[map.obj[t]];
            if (wh) {
                const far = wh.a === t ? wh.b : wh.a;
                const inner = map.density[far];
                out.push({ tile: far, td: Track.tdFrom(Track.axisTrack(Dir.axis(inner)), inner), cost: Vehicles.wormholeLen(world, wh) + 1 });
                return out;
            }
        }
        const z = Track.railEdgeZ(map, t, td >> 1, exit);
        const r = Track.railNext(map, t, exit, z, rt => train.railOk(rt));
        for (const td2 of r.tds) {
            if (!Track.smooth(td, td2)) continue;
            const nt = r.tile;
            if (map.type[nt] === GameMap.T_RAIL && map.sub[nt] === GameMap.RAIL_SUB_DEPOT) {
                const dep = world.depots[map.obj[nt]];
                if (!dep || Dir.reverse(exit) !== dep.dir || !goals.depot || !goals.tiles.has(nt)) continue;
            }
            let cost = Track.length(td2 >> 1);
            if ((td2 >> 1) !== (td >> 1)) cost += 0.2;
            if (map.signals[nt] && !((map.signals[nt] >> td2) & 1) && ((map.signals[nt] >> (td2 ^ 1)) & 1)) cost += 3;   // against a one-way signal
            out.push({ tile: nt, td: td2, cost });
        }
        if (!out.length) out.push({ tile: t, td: td ^ 1, cost: 10 });   // reverse at the end of the line
        return out;
    },

    /** Crashes: a train's front meets another train's car; trains on crossings hit road vehicles. */
    collisions(world) {
        for (const v of world.vehicles) {
            if (!v || v.type !== 'train' || v.state !== 'run' || !v.steps.length || !v.parts.length) continue;
            const f = v.parts[0];
            if (f.hidden) continue;
            const m = world.railOcc.get(Trains.key(world, v.steps[0]));
            if (m && m.size > 1) {
                for (const id of m.keys()) {
                    if (id === v.id) continue;
                    const o = world.vehicles[id];
                    if (!o || o.state === 'depot') continue;
                    for (const p of o.parts) {
                        if (p.hidden) continue;
                        if (Math.hypot(p.x - f.x, p.y - f.y) < 0.4 && Math.abs(p.z - f.z) < 0.6) {
                            Trains.crash(world, v);
                            Trains.crash(world, o);
                            break;
                        }
                    }
                }
            }
            // Level crossings: a road vehicle on the tile is destroyed.
            const t = world.map.idx(Math.floor(f.x), Math.floor(f.y));
            if (world.map.inside(Math.floor(f.x), Math.floor(f.y)) && world.map.type[t] === GameMap.T_ROAD && world.map.sub[t] === GameMap.ROAD_SUB_CROSSING) {
                for (const rv of world.vehicles) {
                    if (!rv || rv.type !== 'road' || rv.state !== 'run' || rv.tile !== t) continue;
                    if (Math.hypot(rv.x - f.x, rv.y - f.y) < 0.45) Trains.crash(world, rv);
                }
            }
        }
    },

    crash(world, v) {
        if (v.state === 'crashed') return;
        let victims = 0;
        const pax = world.cargoSlot('passengers');
        for (const car of v.cars) if (car.slot === pax) victims += v.cargoCount(car);
        victims += v.type === 'train' ? 2 : 1;
        v.state = 'crashed';
        v.crashed = 74 * 4;
        v.speed = 0;
        v.load = null;
        for (const car of v.cars) car.cargo = [];
        const what = v.type === 'train' ? 'Train Crash!' : 'Road Vehicle Crash!';
        world.addNews(what + ' ' + victims + ' die in fireball after collision (' + v.displayName() + ')', { kind: 'accident', tile: world.map.idx(Math.floor(v.x), Math.floor(v.y)), big: true });
        world.emit('crash', v);
    },
};
