// TTDShip.js — ships of the TTD remake: they sail over sea tiles (A* with diagonal moves where
// both side tiles are water) from dock to dock, stopping on the water tile in front of a dock to
// load, and are bought in and serviced at ship depots. TTD ships are slow and reliable (their
// breakdown check gets a bonus, see Vehicle.onNewDay); a station's rating counts a ship's days
// since pickup at a quarter.

class Ship extends Vehicle {
    constructor(id, owner, engineId) {
        super(id, 'ship', owner, engineId);
        this.route = null;     // tile path
        this.ri = 0;
    }

    placeInDepot(world) {
        const d = world.depots[this.depot];
        this.state = 'depot';
        this.speed = 0;
        if (d) { this.x = world.map.tx(d.t) + 0.5; this.y = world.map.ty(d.t) + 0.5; }
        this.z = Ships.waterZ();
        this.parts = [{ x: this.x, y: this.y, z: this.z, heading: this.heading, grade: 0, hidden: true }];
    }

    tick(world) {
        if (this.state === 'crashed') { if (--this.crashed <= 0) Vehicles.remove(world, this); return; }
        if (this.state === 'depot') {
            if (!this.stopped && this.orders.length) { this.state = 'run'; this.depot = -1; this.route = null; }
            return;
        }
        if (this.stopped) { this.speed = 0; return; }
        if (this.broken > 0) { this.broken--; this.speed = Math.max(0, this.speed - 1); return; }
        if (this.state === 'load') {
            if (this.loadingTick(world)) { this.finishLoading(world); this.route = null; }
            return;
        }
        if (!this.route) {
            this.route = Ships.findRoute(world, this);
            this.ri = 0;
            if (!this.route) { this.speed = 0; return; }
        }
        const vmax = this.maxSpeed();
        this.speed = Math.min(vmax, this.speed + 0.5);
        let step = this.speed * Vehicles.K;
        while (step > 0 && this.route) {
            if (this.ri >= this.route.length) { this.arrive(world); return; }
            const t = this.route[this.ri];
            const tx = world.map.tx(t) + 0.5, ty = world.map.ty(t) + 0.5;
            const dx = tx - this.x, dy = ty - this.y, d = Math.hypot(dx, dy);
            if (d > 1e-6) this.heading = Math.atan2(dy, dx);
            if (d <= step) { this.x = tx; this.y = ty; step -= d; this.ri++; }
            else { this.x += dx / d * step; this.y += dy / d * step; step = 0; }
        }
        this.parts = [{ x: this.x, y: this.y, z: this.z, heading: this.heading, grade: 0, hidden: false }];
    }

    arrive(world) {
        this.route = null;
        this.speed = 0;
        const dep = this.destDepot();
        if (dep >= 0) {
            this.depot = dep;
            this.placeInDepot(world);
            this.serviceAt(world);
            this.arrivedAtDepot(world, dep, world.depots[dep] ? world.depots[dep].t : -1);
            return;
        }
        const st = world.stations[this.destStation()];
        if (st) this.startLoading(world, st);
        else this.nextOrder();
    }

    requestService(world) {
        const map = world.map;
        let best = -1, bd = 40;
        for (const d of world.depots) {
            if (!d || d.kind !== 'ship' || d.owner !== this.owner) continue;
            const dist = IMath.manhattan(map.tx(d.t), map.ty(d.t), Math.floor(this.x), Math.floor(this.y));
            if (dist < bd) { bd = dist; best = d.id; }
        }
        if (best >= 0) { this.serviceDepot = best; this.route = null; }
    }

    onOrderChanged() { this.route = null; }

    toJSON() { const o = super.toJSON(); delete o.route; return o; }

    relink(world) {
        this.route = null;
        this.z = Ships.waterZ();
        if (this.state === 'depot') this.placeInDepot(world);
        else this.parts = [{ x: this.x, y: this.y, z: this.z, heading: this.heading, grade: 0, hidden: false }];
    }
}

/** @satisfies {Record<string, any>} */
const Ships = {
    waterZ() { return typeof TTD_WATER_LEVEL !== 'undefined' ? TTD_WATER_LEVEL : 0.35; },

    /** Water tiles a ship may use (sea, ship depots, the water in front of docks). */
    sailable(map, t) { return map.type[t] === GameMap.T_WATER; },

    goals(world, v) {
        const dep = v.destDepot();
        if (dep >= 0 && world.depots[dep]) return [world.depots[dep].t];
        const st = world.stations[v.destStation()];
        if (!st) return null;
        const out = st.parts.filter(p => p.kind === GameMap.ST_DOCK && p.water >= 0).map(p => p.water);
        return out.length ? out : null;
    },

    findRoute(world, v) {
        const goals = Ships.goals(world, v);
        const map = world.map;
        if (!goals) return null;
        const gs = new Set(goals);
        const start = map.idx(IMath.clamp(Math.floor(v.x), 0, map.W - 1), IMath.clamp(Math.floor(v.y), 0, map.H - 1));
        if (gs.has(start)) return [start];
        const gx = map.tx(goals[0]), gy = map.ty(goals[0]);
        const h = (t) => IMath.distMax(map.tx(t), map.ty(t), gx, gy);
        const next = (n) => {
            const out = [], x = map.tx(n.tile), y = map.ty(n.tile);
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const nx = x + dx, ny = y + dy;
                if (!map.inside(nx, ny)) continue;
                const t = map.idx(nx, ny);
                if (!Ships.sailable(map, t)) continue;
                if (dx && dy && (!Ships.sailable(map, map.idx(x + dx, y)) || !Ships.sailable(map, map.idx(x, y + dy)))) continue;
                // Depots are entered only when they are the goal.
                if (map.sub[t] === GameMap.WATER_SUB_DEPOT && !gs.has(t)) continue;
                out.push({ tile: t, td: 0, cost: dx && dy ? 1.414 : 1 });
            }
            return out;
        };
        const path = PathFinder.search({ tile: start, td: 0 }, n => gs.has(n.tile), next, h, 30000);
        if (!path) {
            if (v.owner === 0 && !v.lost) world.addNews(v.displayName() + ' is lost.', { kind: 'vehicle' });
            v.lost = true;
            return null;
        }
        v.lost = false;
        return path.map(n => n.tile);
    },
};
