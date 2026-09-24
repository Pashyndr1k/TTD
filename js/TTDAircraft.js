// TTDAircraft.js — aircraft of the TTD remake. Planes take off along the runway, fly straight at
// cruising height to the next airport, approach, land, roll out, taxi to a free terminal to load
// and taxi back to the runway; helicopters take off and land vertically on any airport or
// heliport. Aircraft are bought in an airport's hangar and serviced there. Flying speed is TTD's
// quarter speed (OpenTTD's plane_speed 1/4); fast jets landing on a small airport risk a crash.

class Aircraft extends Vehicle {
    constructor(id, owner, engineId) {
        super(id, 'air', owner, engineId);
        this.phase = 'hangar';     // hangar | taxi | load | runway | takeoff | fly | approach | land | hold

        this.at = -1;              // airport station the aircraft is at (ground phases)
        this.terminal = -1;
        this.wp = null;            // current waypoints [{x, y, z}]
        this.circle = 0;
    }

    get heli() { return !!this.spec.heli; }

    placeInDepot(world) {
        const st = world.stations[this.hangar >= 0 ? this.hangar : this.depot];
        this.hangar = st ? st.id : -1;
        this.depot = -1;
        this.state = 'depot';
        this.phase = 'hangar';
        this.at = this.hangar;
        this.speed = 0;
        if (st && st.airport) {
            const p = Airports.point(world, st, 'hangar');
            this.x = p.x; this.y = p.y; this.z = p.z;
        }
        this.parts = [{ x: this.x, y: this.y, z: this.z, heading: this.heading, grade: 0, hidden: true }];
    }

    tick(world) {
        if (this.state === 'crashed') { if (--this.crashed <= 0) Vehicles.remove(world, this); return; }
        if (this.state === 'depot') {
            if (!this.stopped && this.orders.length) this.leaveHangar(world);
            return;
        }
        if (this.stopped && this.phase !== 'fly' && this.phase !== 'hold') { this.speed = 0; return; }
        if (this.state === 'load') {
            if (this.loadingTick(world)) {
                this.finishLoading(world);
                this.releaseTerminal(world);
                this.goRunway(world);
            }
            return;
        }
        this.fly(world);
        this.parts = [{ x: this.x, y: this.y, z: this.z, heading: this.heading, grade: this.pitchGrade || 0, hidden: false }];
    }

    leaveHangar(world) {
        const st = world.stations[this.hangar];
        if (!st || !st.airport) return;
        this.state = 'run';
        this.at = st.id;
        this.goRunway(world);
    }

    /** Ground: taxi to the runway start (helicopters lift off where they are). */
    goRunway(world) {
        const st = world.stations[this.at];
        if (!st || !st.airport || this.heli) {
            this.phase = 'takeoff';
            this.wp = [{ x: this.x, y: this.y, z: this.cruiseZ(world) }];
            return;
        }
        const a = Airports.point(world, st, 'runwayStart');
        this.phase = 'taxi';
        this.wp = [Airports.point(world, st, 'taxi'), a];
        this.next = 'takeoff';
    }

    cruiseZ(world) { return world.map.maxHeight * 0.55 + 4; }

    speedNow() {
        const v = this.maxSpeed() / Aircraft.SPEED_DIV;
        if (this.phase === 'taxi') return Math.min(v, 40);
        if (this.phase === 'land') return Math.max(40, v * 0.5);
        if (this.broken > 0) return v * 0.5;
        return v;
    }

    fly(world) {
        if (this.broken > 0) this.broken--;
        const target = this.speedNow();
        this.speed += IMath.clamp(target - this.speed, -6, 3);
        let step = Math.max(0.01, this.speed) * Vehicles.K;
        if (this.phase === 'fly' || this.phase === 'hold') step = this.speed * Vehicles.K;
        if (this.phase === 'fly') { this.flyTo(world, step); return; }
        if (this.phase === 'hold') { this.holdTick(world, step); return; }
        if (!this.wp || !this.wp.length) { this.phaseDone(world); return; }
        const p = this.wp[0];
        const dx = p.x - this.x, dy = p.y - this.y, dz = p.z - this.z, d = Math.hypot(dx, dy);
        if (d > 1e-4) this.heading = Math.atan2(dy, dx);
        if (this.heli && (this.phase === 'takeoff' || this.phase === 'land')) {
            // Vertical.
            const vz = 0.05;
            if (Math.abs(dz) <= vz && d <= step) { this.x = p.x; this.y = p.y; this.z = p.z; this.wp.shift(); }
            else if (Math.abs(dz) > vz && (this.phase === 'takeoff' || d < 0.05)) this.z += Math.sign(dz) * vz;
            else { this.x += dx / d * Math.min(step, d); this.y += dy / d * Math.min(step, d); }
            if (!this.wp.length) this.phaseDone(world);
            return;
        }
        if (d <= step) {
            this.x = p.x; this.y = p.y; this.z = p.z;
            this.wp.shift();
            if (!this.wp.length) this.phaseDone(world);
            return;
        }
        this.x += dx / d * step; this.y += dy / d * step;
        this.z += dz * Math.min(1, step / d);
        this.pitchGrade = d > 0 ? dz / d : 0;
    }

    phaseDone(world) {
        const st = world.stations[this.at];
        switch (this.phase) {
            case 'taxi':
                if (this.next === 'takeoff') {
                    const b = Airports.point(world, st, 'runwayEnd');
                    this.phase = 'takeoff';
                    this.wp = [{ x: b.x, y: b.y, z: b.z + 0.1 }, { x: b.x + (b.x - this.x) * 0.6, y: b.y + (b.y - this.y) * 0.6, z: this.cruiseZ(world) }];
                } else if (this.next === 'terminal') {
                    this.startLoading(world, st);
                } else if (this.next === 'hangar') {
                    this.hangar = st.id;
                    this.placeInDepot(world);
                    this.serviceAt(world);
                    const o = this.order();
                    if (o && o.kind === 'depot' && o.dest === st.id) { if (o.stop) this.stopped = true; this.nextOrder(); }
                }
                break;
            case 'takeoff':
                this.at = -1;
                this.phase = 'fly';
                this.pitchGrade = 0;
                break;
            case 'land': {
                this.at = this.target;
                const dest = world.stations[this.at];
                if (!dest || !dest.airport) { this.phase = 'fly'; break; }
                // Fast jets on a small airport: TTD's crash risk.
                if (this.spec.fast && TTDData.AIRPORTS[dest.airport.type].big === false && !this.heli && world.rng.chance(1, 1500)) {
                    Trains.crash(world, this);
                    world.addNews('Plane crashes at ' + dest.name + '!', { kind: 'accident', big: true, tile: dest.xy });
                    return;
                }
                const needService = world.date - this.lastService > this.serviceInterval && world.settings.breakdowns > 0;
                const goDepot = this.destDepot() === dest.id;
                if (needService || goDepot) {
                    this.phase = 'taxi'; this.next = 'hangar';
                    this.wp = [Airports.point(world, dest, 'taxi'), Airports.point(world, dest, 'hangar')];
                    if (needService && !goDepot) { this.lastService = world.date; this.serviceAt(world); this.next = 'terminal'; this.toTerminal(world, dest); }
                    break;
                }
                this.toTerminal(world, dest);
                break;
            }
        }
    }

    toTerminal(world, st) {
        if (this.destStation() !== st.id) { this.goRunway(world); this.target = -1; return; }
        const term = Airports.claimTerminal(world, st, this);
        if (term < 0) { this.goRunway(world); return; }
        this.terminal = term;
        this.phase = 'taxi';
        this.next = 'terminal';
        this.wp = this.heli ? [Airports.point(world, st, 'terminal', term)] : [Airports.point(world, st, 'taxi'), Airports.point(world, st, 'terminal', term)];
    }

    releaseTerminal(world) {
        const st = world.stations[this.at];
        if (st && st.airport && st.airport.terms) {
            const i = st.airport.terms.indexOf(this.id);
            if (i >= 0) st.airport.terms[i] = -1;
        }
        this.terminal = -1;
    }

    /** Cruise toward the destination airport's approach point. */
    flyTo(world, step) {
        const destId = this.destStation() >= 0 ? this.destStation() : this.destDepot();
        const st = world.stations[destId];
        if (!st || !st.airport) {
            // No valid airport: circle where we are.
            this.heading += 0.02;
            this.x += Math.cos(this.heading) * step; this.y += Math.sin(this.heading) * step;
            this.x = IMath.clamp(this.x, 1, world.map.W - 1); this.y = IMath.clamp(this.y, 1, world.map.H - 1);
            return;
        }
        const ap = this.heli ? Airports.point(world, st, 'terminal', 0) : Airports.point(world, st, 'approach');
        const cz = this.cruiseZ(world);
        const dx = ap.x - this.x, dy = ap.y - this.y, d = Math.hypot(dx, dy);
        this.heading = Math.atan2(dy, dx);
        this.z += IMath.clamp(cz - this.z, -0.05, 0.05);
        if (d <= step + 0.05) {
            this.x = ap.x; this.y = ap.y;
            this.target = st.id;
            if (!Airports.canLand(world, st, this)) { this.phase = 'hold'; this.circle = 0; return; }
            this.beginLanding(world, st);
            return;
        }
        this.x += dx / d * step; this.y += dy / d * step;
    }

    beginLanding(world, st) {
        this.phase = 'land';
        this.at = st.id;
        if (this.heli) {
            const pad = Airports.point(world, st, 'terminal', 0);
            this.wp = [{ x: pad.x, y: pad.y, z: pad.z }];
        } else {
            const a = Airports.point(world, st, 'runwayStart'), b = Airports.point(world, st, 'runwayEnd');
            this.wp = [{ x: a.x, y: a.y, z: a.z + 0.05 }, b];
        }
    }

    holdTick(world, step) {
        const st = world.stations[this.target];
        this.circle += step * 0.8;
        this.heading += step * 0.8;
        this.x += Math.cos(this.heading) * step; this.y += Math.sin(this.heading) * step;
        if (st && Airports.canLand(world, st, this) && this.circle > 3) this.beginLanding(world, st);
        else if (!st) this.phase = 'fly';
    }

    requestService() { }

    onOrderChanged() { if (this.phase === 'fly' || this.phase === 'hold') this.phase = 'fly'; }

    relink(world) {
        if (this.state === 'depot') this.placeInDepot(world);
        this.parts = [{ x: this.x, y: this.y, z: this.z, heading: this.heading, grade: 0, hidden: this.state === 'depot' }];
    }

    release(world) { this.releaseTerminal(world); }
}

Aircraft.SPEED_DIV = 4;

/**
 * Airport layouts (tile-local points) and terminal bookkeeping. TTDData.AIRPORTS: 0 small (4×3),
 * 1 city (6×6), 2 heliport (1×1).
 */
/** @satisfies {Record<string, any>} */
const Airports = {
    LAYOUT: [
        {   // small: runway along x on the far row, hangar and two terminals on the near rows
            hangar: [0.5, 0.5], taxi: [3.5, 1.5], runwayStart: [0.2, 2.5], runwayEnd: [3.8, 2.5],
            approach: [-6, 2.5], terminals: [[1.5, 0.55], [2.5, 0.55]],
        },
        {   // city
            hangar: [0.6, 0.6], taxi: [5.4, 3.6], runwayStart: [0.2, 5.4], runwayEnd: [5.8, 5.4],
            approach: [-8, 5.4], terminals: [[1.6, 1.6], [2.6, 1.6], [3.6, 1.6], [2.6, 3.0], [3.6, 3.0]],
        },
        {   // heliport
            hangar: [0.5, 0.5], taxi: [0.5, 0.5], runwayStart: [0.5, 0.5], runwayEnd: [0.5, 0.5],
            approach: [0.5, 0.5], terminals: [[0.5, 0.5]],
        },
    ],

    /** A layout point of the station's airport in tile units and levels. */
    point(world, st, name, idx) {
        const ap = st.airport, map = world.map;
        const L = Airports.LAYOUT[ap.type];
        const p = name === 'terminal' ? L.terminals[Math.min(idx || 0, L.terminals.length - 1)] : L[name];
        const x0 = map.tx(ap.t), y0 = map.ty(ap.t);
        return { x: x0 + p[0], y: y0 + p[1], z: map.buildZ(ap.t) + 0.05 };
    },

    claimTerminal(world, st, v) {
        const ap = st.airport;
        const n = Airports.LAYOUT[ap.type].terminals.length;
        if (!ap.terms || ap.terms.length !== n) ap.terms = new Array(n).fill(-1);
        let i = ap.terms.indexOf(v.id);
        if (i >= 0) return i;
        i = ap.terms.findIndex(x => x < 0 || !world.vehicles[x] || world.vehicles[x].at !== st.id);
        if (i < 0) return -1;
        ap.terms[i] = v.id;
        return i;
    },

    /** A plane may land when a terminal is free and nobody else is on the runway. */
    canLand(world, st, v) {
        const ap = st.airport;
        const n = Airports.LAYOUT[ap.type].terminals.length;
        if (!ap.terms || ap.terms.length !== n) ap.terms = new Array(n).fill(-1);
        const free = ap.terms.some(x => x < 0 || !world.vehicles[x] || world.vehicles[x].at !== st.id);
        if (!free && v.destStation() === st.id) return false;
        for (const o of world.vehicles) {
            if (!o || o === v || o.type !== 'air' || o.at !== st.id) continue;
            if (o.phase === 'land' || (o.phase === 'takeoff' && !o.heli)) return false;
        }
        return true;
    },
};
