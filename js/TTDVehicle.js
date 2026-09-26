// TTDVehicle.js — what every vehicle of the TTD remake shares: orders (go to station with full
// load / unload / transfer / non-stop flags, go to depot), TTD's gradual loading (5 units per
// part per step; unload first, pay on delivery with the transit-time formula, then load),
// reliability decay and breakdowns (TTD's _breakdown_chance table), servicing at depots, ageing,
// value depreciation, yearly profit, autorenew. Movement lives in TTDTrain.js, TTDRoadVehicle.js,
// TTDShip.js and TTDAircraft.js.
//
// Positions are in tile units (x toward SW, y toward SE) and height levels; `parts` holds one
// { x, y, z, heading, pitch, hidden } per car for the 3D view.

class Vehicle {
    constructor(id, type, owner, engineId) {
        this.id = id;
        this.type = type;            // 'train' | 'road' | 'ship' | 'air'
        this.owner = owner;
        this.engine = engineId;
        this.unit = 0;
        this.name = '';
        /** Cars (a train's consist; one for the others; aircraft: passengers + mail). */
        this.cars = [];
        /** Orders: { kind: 'station' | 'depot', dest, full, unload, transfer, nonstop, stop }. */
        this.orders = [];
        this.cur = 0;
        this.state = 'depot';        // 'depot' | 'run' | 'load' | 'crashed'
        this.stopped = true;
        this.depot = -1;
        this.speed = 0;
        this.age = 0;                // days
        this.maxAge = 365 * 15;
        this.reliability = 0xffff;
        this.relDec = 80;
        this.breakdownChance = 0;
        this.broken = 0;             // ticks left standing broken down
        this.breakdowns = 0;
        this.lastService = 0;
        this.serviceInterval = 150;
        this.serviceDepot = -1;      // a depot the vehicle heads to for servicing
        this.profitThis = 0;
        this.profitLast = 0;
        this.value = 0;
        this.built = 0;
        this.load = null;            // { station, phase, timer, anything }
        this.crashed = 0;
        this.lastStation = -1;
        this.hangar = -1;            // aircraft: the airport whose hangar holds it
        this.lost = false;
        this.x = 0; this.y = 0; this.z = 0; this.heading = 0;
        this.parts = [];
        /** Positions before the last tick (Game.snapshot) — the renderer interpolates from them. */
        this._prev = null;
    }

    get spec() { return World.ENGINE[this.engine]; }

    displayName() {
        if (this.name) return this.name;
        const kind = { train: 'Train', road: 'Road Vehicle', ship: 'Ship', air: 'Aircraft' }[this.type];
        return kind + ' ' + this.unit;
    }

    /** Max speed km/h. */
    maxSpeed() { return Vehicles.speedKmh(this.spec); }

    capacityOf(slot) {
        let c = 0;
        for (const car of this.cars) if (car.slot === slot) c += car.cap;
        return c;
    }

    cargoCount(car) {
        let n = 0;
        for (const p of car.cargo) n += p.n;
        return n;
    }

    totalCargo() {
        const out = {};
        for (const car of this.cars) if (car.cap) out[car.slot] = (out[car.slot] || 0) + this.cargoCount(car);
        return out;
    }

    order() { return this.orders.length ? this.orders[this.cur % this.orders.length] : null; }

    /** The station the vehicle is heading for (-1 — none). */
    destStation() {
        if (this.serviceDepot >= 0) return -1;
        const o = this.order();
        return o && o.kind === 'station' ? o.dest : -1;
    }

    destDepot() {
        if (this.serviceDepot >= 0) return this.serviceDepot;
        const o = this.order();
        return o && o.kind === 'depot' ? o.dest : -1;
    }

    nextOrder() {
        if (this.orders.length) this.cur = (this.cur + 1) % this.orders.length;
        this.onOrderChanged();
    }

    onOrderChanged() { this.path = null; }

    // --- Daily / yearly -------------------------------------------------------------

    onNewDay(world) {
        if (this.state === 'crashed') return;
        this.age++;
        const company = world.companies[this.owner];
        // Running costs: yearly cost / 364 per day (TTD).
        const run = Vehicles.runningCost(world, this) / 364;
        if (run > 0 && company) {
            company.spend(run, Company.C_RUN[this.type]);
            this.profitThis -= run;
        }
        if (this.age % 8 === 0) this.value -= this.value / 256;
        if (this.state === 'depot') return;
        // Reliability and breakdowns (TTD's CheckVehicleBreakdown).
        const settings = world.settings;
        let dec = this.relDec;
        if (this.age > this.maxAge) dec *= Math.pow(2, Math.min(5, Math.floor((this.age - this.maxAge) / 365) + 1));
        this.reliability = Math.max(0, this.reliability - dec);
        if (this.broken || this.stopped || settings.breakdowns < 1 || this.speed < 5) return;
        const r = world.rng.next();
        let chance = this.breakdownChance + 1;
        if (((r & 0xffff) * 25 >>> 16) === 0) chance += 25;
        this.breakdownChance = Math.min(255, chance);
        let rel = this.reliability;
        if (this.type === 'ship') rel += 0x6666;
        if (settings.breakdowns === 1) rel += 0x6666;
        if (TTDData.BREAKDOWN_CHANCE[Math.min(rel, 0xffff) >> 10] <= this.breakdownChance) {
            this.broken = ((r >>> 24) & 0x7f) + 0x80;
            this.breakdownChance = 0;
            this.breakdowns++;
            this.onBreakdown(world);
        }
        // Service due: look for a depot.
        const interval = this.serviceInterval;
        if (settings.breakdowns > 0 && interval > 0 && world.date - this.lastService > interval && this.serviceDepot < 0 && this.load == null) {
            this.requestService(world);
        }
        // News: vehicle getting old (a year before the end of its life), and old.
        if (this.owner === 0) {
            if (this.age === this.maxAge - 365) world.addNews(this.displayName() + ' is getting old.', { kind: 'vehicle' });
            else if (this.age === this.maxAge) world.addNews(this.displayName() + ' is getting very old and urgently needs replacing.', { kind: 'vehicle' });
        }
    }

    onBreakdown(world) { if (this.owner === 0) world.emit('breakdown', this); }

    requestService(world) { }

    /** One game tick (each vehicle class moves itself). */
    tick(world) { }

    /** Put the vehicle inside its depot / hangar. */
    placeInDepot(world) { }

    /** Leave the world: free what the vehicle holds (track blocks, terminals). */
    release(world) { }

    onNewYear(world) {
        this.profitLast = this.profitThis;
        this.profitThis = 0;
        if (this.owner === 0 && this.profitLast < 0 && this.age > 730 && this.state !== 'depot') {
            world.addNews(this.displayName() + ' made a loss last year: ' + Money.format(this.profitLast) + '.', { kind: 'vehicle' });
        }
    }

    /** At a depot: service, maybe autorenew. */
    serviceAt(world) {
        this.lastService = world.date;
        this.breakdownChance = 0;
        const st = world.engines[this.engine];
        if (st) this.reliability = st.reliability;
        this.serviceDepot = -1;
        const s = world.settings, c = world.companies[this.owner];
        if (s.autorenew && c && this.age >= this.maxAge - s.autorenewMonths * 30) {
            const cost = Vehicles.purchasePrice(world, this) - this.value;
            if (st && st.available && c.money - cost >= s.autorenewMoney) {
                c.spend(cost, Company.C_NEW_VEHICLES);
                this.age = 0;
                this.value = Vehicles.purchasePrice(world, this);
                this.reliability = st.reliability;
                if (this.owner === 0) world.addNews('Autorenew: ' + this.displayName() + ' replaced with a new ' + this.spec.name + ' (' + Money.format(cost) + ').', { kind: 'vehicle' });
            }
        }
    }

    // --- Loading (gradual) ---------------------------------------------------------------

    startLoading(world, station) {
        const o = this.order();
        this.load = { station: station.id, phase: 'unload', timer: 0, order: o && o.kind === 'station' && o.dest === station.id ? this.cur : -1, gotAny: false };
        this.speed = 0;
        this.state = 'load';
        station.lastServed = world.ticks;
        station.lastVehicleType = this.type;
        this.lastStation = station.id;
        // First arrival at a station is news in TTD.
        if (!station.firstArrival) {
            station.firstArrival = true;
            if (this.owner === 0) {
                const kind = { train: 'train', road: this.cars[0] && this.cars[0].slot === world.cargoSlot('passengers') ? 'bus' : 'truck', ship: 'ship', air: 'aircraft' }[this.type];
                world.addNews('Citizens celebrate . . . First ' + kind + ' arrives at ' + station.name + '!', { tile: station.xy, kind: 'arrival', big: true });
            }
        }
    }

    /** One loading tick; returns true when the vehicle may leave. */
    loadingTick(world) {
        const L = this.load, st = world.stations[L.station];
        if (!st) { this.load = null; return true; }
        if (L.timer > 0) { L.timer--; return false; }
        const step = world.settings.gradualLoading ? Vehicles.LOAD_AMOUNT[this.type] : 1e9;
        const o = L.order >= 0 ? this.orders[L.order] : null;
        const company = world.companies[this.owner];
        let moved = 0;
        if (L.phase === 'unload') {
            for (const car of this.cars) {
                if (!car.cap || !car.cargo.length) continue;
                const accepted = st.accepts[car.slot];
                const transfer = o && o.transfer;
                const force = o && o.unload;
                if (!transfer && !accepted && !force) continue;
                let left = step;
                while (left > 0 && car.cargo.length) {
                    const p = car.cargo[0];
                    if (p.src === st.id && !transfer && !force) { car.cargo.shift(); st.addWaiting(car.slot, p.n, p.src, p.srcXY, p.from); continue; }
                    const k = Math.min(left, p.n);
                    p.n -= k; left -= k; moved += k;
                    if (p.n <= 0) car.cargo.shift();
                    if (accepted && !transfer) {
                        const pay = Vehicles.deliver(world, this, st, car.slot, k, p);
                        this.profitThis += pay;
                        if (company) company.earn(pay, Company.C_INCOME[this.type]);
                        L.income = (L.income || 0) + pay;
                    } else {
                        const back = { n: k, src: p.src, srcXY: p.srcXY, days: p.days, from: p.from };
                        const g = st.goods[car.slot];
                        g.active = true;
                        g.waiting.push(back);
                    }
                }
            }
            if (moved === 0) {
                L.phase = 'load';
                if (L.income > 0 && this.owner === 0) world.emit('income', { v: this, amount: L.income, tile: st.xy });
            }
        } else {
            const unloadOnly = o && (o.unload || o.transfer);
            let full = true, anyCap = false;
            for (const car of this.cars) {
                if (!car.cap) continue;
                anyCap = true;
                const have = this.cargoCount(car);
                const free = car.cap - have;
                const g = st.goods[car.slot];
                if (!unloadOnly && free > 0) {
                    // Every attempt to pick up counts for the station rating.
                    g.daysSincePickup = 0;
                    g.lastSpeed = Math.min(255, Vehicles.ratingSpeed(this));
                    g.lastAge = Math.min(255, Math.floor(this.age / 365));
                    g.active = true;
                    g.pickedUp = true;
                    const got = st.take(car.slot, Math.min(step, free));
                    for (const p of got) { car.cargo.push(p); moved += p.n; }
                }
                if (this.cargoCount(car) < car.cap) full = false;
            }
            if (moved > 0) L.gotAny = true;
            // TTD's full load: wait until EVERY car is full (not just one of them).
            const wantFull = o && o.full && !unloadOnly && anyCap;
            const satisfied = !wantFull || full;
            if (moved === 0 && satisfied) {
                this.load = null;
                return true;
            }
        }
        st.lastServed = world.ticks;
        L.timer = Vehicles.LOAD_TICKS[this.type];
        return false;
    }

    /** Leaving a station: the order moves on if it was the ordered one. */
    finishLoading(world) {
        this.state = 'run';
        const L = this.load;
        this.load = null;
        if (L && L.order === this.cur) this.nextOrder();
        else if (this.order() && this.order().kind === 'station' && this.order().dest === this.lastStation) this.nextOrder();
    }

    // --- Serialisation --------------------------------------------------------------------

    toJSON() {
        const o = Object.assign({}, this);
        delete o.path; delete o.parts; delete o._prev;
        return o;
    }

    relink(world) { this.parts = []; }
}

/** @satisfies {Record<string, any>} */
const Vehicles = {
    /** Tiles per tick per km/h (TTD: a tile is 16 steps of 192 progress units). */
    K: 1 / 3072,
    LOAD_AMOUNT: { train: 5, road: 5, ship: 10, air: 20 },
    LOAD_TICKS: { train: 40, road: 20, ship: 10, air: 20 },
    CAR_LEN: 0.5,

    railCompatible(engineRail, trackRail) {
        if (engineRail === 0) return trackRail === 0 || trackRail === 1;
        return engineRail === trackRail;
    },

    wagonOn(wagonRail, trackRail) { return Vehicles.railCompatible(wagonRail, trackRail); },

    speedKmh(e) {
        if (!e) return 0;
        if (e.type === 'rail') return e.speed;
        if (e.type === 'road' || e.type === 'ship') return e.speed / 2;
        return Math.round(e.speed * 8 * 1.609);
    },

    /** Station-rating speed: TTD records trains in km/h, road vehicles in internal units / 2… */
    ratingSpeed(v) {
        if (v.type === 'train') return v.maxSpeed();
        if (v.type === 'road') return v.spec.speed / 2;
        return v.spec.speed;
    },

    /** Purchase price of an engine (TTD's cost factors). */
    price(world, e) {
        if (e.type === 'rail') {
            if (e.wagon) return world.price('buildRailWagon') * e.cost / 256;
            return (world.price('buildRailVehicle') / 8) * e.cost / 32 * (e.multihead ? 2 : 1);
        }
        if (e.type === 'road') return (world.price('roadVehBase') / 8) * e.cost / 32;
        if (e.type === 'ship') return (world.price('shipBase') / 8) * e.cost / 32;
        return (world.price('aircraftBase') / 8) * e.cost / 32;
    },

    /** Yearly running cost of an engine. */
    engineRunning(world, e) {
        if (e.type === 'rail') {
            if (e.wagon) return 0;
            return e.runBase * world.price('runningRail' + e.runClass) / 256 * (e.multihead ? 2 : 1);
        }
        if (e.type === 'road') return e.runBase * world.price('roadVehRunning') / 256;
        if (e.type === 'ship') return e.runBase * world.price('shipRunning') / 256;
        return e.runBase * world.price('aircraftRunning') / 256;
    },

    runningCost(world, v) {
        let c = 0;
        const seen = new Set();
        for (const car of v.cars) {
            if (car.rearHead) continue;
            const e = World.ENGINE[car.engine];
            if (!e) continue;
            c += Vehicles.engineRunning(world, e);
            seen.add(car.engine);
        }
        return c;
    },

    purchasePrice(world, v) {
        let p = 0;
        for (const car of v.cars) if (!car.rearHead) p += Vehicles.price(world, World.ENGINE[car.engine]);
        return p;
    },

    /** Cars of a new vehicle of engine e. */
    carsFor(world, e) {
        if (e.type === 'rail') {
            const cars = [Vehicles.car(e.id, e.capacity ? e.cargo : -1, e.capacity || 0, !!e.wagon, false)];
            if (e.multihead) cars.push(Vehicles.car(e.id, e.capacity ? e.cargo : -1, e.capacity || 0, false, true));
            return cars;
        }
        if (e.type === 'air') {
            return [Vehicles.car(e.id, world.cargoSlot('passengers'), e.capacity, false, false),
                Vehicles.car(e.id, world.cargoSlot('mail'), e.mail, false, false)];
        }
        return [Vehicles.car(e.id, e.cargo, e.capacity, false, false)];
    },

    /** A car record: engine id, cargo slot (-1 none), capacity, cargo packets. */
    car(engine, slot, cap, wagon, rearHead) {
        return { engine, slot, cap, cargo: /** @type {any[]} */ ([]), wagon, rearHead, flip: false };
    },

    /** Pay for delivering n units of packet p at station st (TTD's DeliverGoods). */
    deliver(world, v, st, slot, n, p) {
        const map = world.map;
        const from = world.stations[p.src];
        const srcXY = from ? from.xy : p.srcXY;
        const dist = IMath.manhattan(map.tx(srcXY), map.ty(srcXY), map.tx(st.xy), map.ty(st.xy));
        let pay = world.income(slot, n, dist, p.days);
        if (from && Subsidies.check(world, slot, from, st, v.owner)) {
            pay *= [1.5, 2, 3, 4][world.settings.subsidyMult];
        }
        const company = world.companies[v.owner];
        if (company) {
            company.cur.delivered += n;
            company.cur.cargoTypes |= 1 << slot;
        }
        const town = world.towns[st.town];
        const c = world.cargo(slot);
        if (town && c) {
            if (c.key === 'food') town.food += n;
            if (c.key === 'water') town.water += n;
            if (c.key === 'goods') town.goods += n;
        }
        Industries.deliver(world, slot, n, st.xy);
        return pay;
    },

    /** Every 185 ticks: cargo in vehicles gets one "day" older (TTD's 2.5-day transit units). */
    ageCargo(world) {
        for (const v of world.vehicles) {
            if (!v || v.state === 'depot') continue;
            for (const car of v.cars) for (const p of car.cargo) if (p.days < 255) p.days++;
        }
    },

    /** New vehicle bought in depot (or airport hangar) `depotId`; returns the vehicle or an error string. */
    build(world, engineId, where) {
        const e = World.ENGINE[engineId], c = world.player;
        const st = world.engines[engineId];
        if (!e || !st || !st.available) return 'This vehicle is not available';
        const price = Vehicles.price(world, e);
        if (!c.canAfford(price)) return 'Not enough cash - requires ' + Money.format(price);
        const id = world.vehicles.length;
        let v;
        if (e.type === 'rail') v = new Train(id, 0, engineId);
        else if (e.type === 'road') v = new RoadVehicle(id, 0, engineId);
        else if (e.type === 'ship') v = new Ship(id, 0, engineId);
        else v = new Aircraft(id, 0, engineId);
        v.cars = Vehicles.carsFor(world, e);
        v.unit = c.nextUnit(world, v.type);
        v.maxAge = e.life * 365;
        v.reliability = st.reliability;
        v.relDec = 80;
        v.lastService = world.date;
        v.built = world.date;
        v.value = price;
        v.serviceInterval = { train: world.settings.serviceTrain, road: world.settings.serviceRoad, ship: world.settings.serviceShip, air: world.settings.serviceAir }[v.type];
        v.depot = where;
        v.state = 'depot';
        v.stopped = true;
        c.spend(price, Company.C_NEW_VEHICLES);
        world.vehicles.push(v);
        v.placeInDepot(world);
        return v;
    },

    /** Add a wagon (or another engine) to a train standing in its depot. */
    addWagon(world, train, engineId) {
        const e = World.ENGINE[engineId], c = world.player;
        if (train.state !== 'depot') return 'Train must be stopped inside a depot';
        if (train.cars.length >= 30) return 'Train too long';
        const price = Vehicles.price(world, e);
        if (!c.canAfford(price)) return 'Not enough cash - requires ' + Money.format(price);
        c.spend(price, Company.C_NEW_VEHICLES);
        // New wagons go behind the last wagon (before a rear engine head); a train reversed in an
        // older save is put back in running order first.
        Trains.arrange(train);
        const at = train.cars.findIndex(c => c.rearHead);
        train.cars.splice(at < 0 ? train.cars.length : at, 0, ...Vehicles.carsFor(world, e));
        train.value += price;
        return null;
    },

    sell(world, v) {
        if (v.state !== 'depot' && v.state !== 'crashed') return 'Vehicle must be stopped in a depot';
        const c = world.companies[v.owner];
        if (c && v.state !== 'crashed') c.earn(v.value, Company.C_NEW_VEHICLES);
        Vehicles.remove(world, v);
        return null;
    },

    remove(world, v) {
        if (v.release) v.release(world);
        world.vehicles[v.id] = null;
        world.emit('vehicleRemoved', v);
    },

    fromJSON(o) {
        const Cls = { train: Train, road: RoadVehicle, ship: Ship, air: Aircraft }[o.type];
        const v = new Cls(o.id, o.owner, o.engine);
        Object.assign(v, o);
        return v;
    },

    rebuildOccupancy(world) {
        world.railOcc = new Map();
        for (const v of world.vehicles) if (v && v.type === 'train' && v.steps) for (const s of v.steps) Trains.occupy(world, v, s, 1);
    },

    /** After all vehicles moved: train collisions. */
    afterTick(world) {
        Trains.collisions(world);
    },

    /** Point along a step of a rail or road path, including bridge/tunnel gaps. */
    wormholePoint(world, wh, fromA, s) {
        const map = world.map;
        const a = fromA ? wh.a : wh.b, b = fromA ? wh.b : wh.a;
        const dir = fromA ? wh.dir : Dir.reverse(wh.dir);
        const ma = Track.MID[dir], mb = Track.MID[Dir.reverse(dir)];
        const ax = map.tx(a) + ma[0], ay = map.ty(a) + ma[1];
        const bx = map.tx(b) + mb[0], by = map.ty(b) + mb[1];
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const f = Math.max(0, Math.min(1, s / len));
        return { x: ax + (bx - ax) * f, y: ay + (by - ay) * f, z: wh.z, heading: Math.atan2(by - ay, bx - ax), grade: 0, tunnel: wh.kind === 'tunnel' };
    },

    wormholeLen(world, wh) {
        const map = world.map;
        return IMath.manhattan(map.tx(wh.a), map.ty(wh.a), map.tx(wh.b), map.ty(wh.b)) - 1;
    },
};
