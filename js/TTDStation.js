// TTDStation.js — stations of the TTD remake: parts (platforms, road stops, airport, dock),
// catchment (per part radius, 0.5's modified catchment), cargo acceptance (the 1/8 sums of
// houses and industries in the catchment, accepted at 8), waiting cargo as packets (source
// station and days in transit, used by the payment formula), and TTD's station rating: speed
// and age of the last vehicle, days since the last pickup, amount waiting, a statue in town —
// recomputed every 185 ticks and moving at most 2 points per update, with cargo lost at low ratings.

class Station {
    constructor(id, xy, owner, name, town) {
        this.id = id;
        this.xy = xy;
        this.owner = owner;
        this.name = name;
        this.town = town;
        /** Parts: { t, kind: GameMap.ST_* }. */
        this.parts = [];
        this.facilities = 0;
        /** Per cargo slot: see Station.goods(). */
        this.goods = [];
        for (let s = 0; s < 12; s++) this.goods.push(Station.emptyGoods());
        this.built = 0;
        this.lastServed = -1e9;     // world tick of the last load/unload
        this.lastVehicleType = '';
        this.airport = null;        // { type, t } — the airport's top-left tile and TTDData.AIRPORTS index
        this.catch = null;          // cached catchment tile list
        this.accepts = new Array(12).fill(false);
        this.acceptSums = new Array(12).fill(0);
    }

    static emptyGoods() {
        return { waiting: [], rating: 175, daysSincePickup: 0, lastSpeed: 0, lastAge: 255, active: false, pickedUp: false };
    }

    waiting(slot) {
        let n = 0;
        for (const p of this.goods[slot].waiting) n += p.n;
        return n;
    }

    recentlyServed(world) {
        return (world || Station.world).ticks - this.lastServed <= 20 * 185;
    }

    has(kind) { return this.parts.some(p => p.kind === kind); }

    /** Facility bits: 1 rail, 2 truck, 4 bus, 8 airport, 16 dock. */
    updateFacilities() {
        let f = 0;
        for (const p of this.parts) f |= [1, 4, 2, 8, 16, 16][p.kind];
        this.facilities = f;
    }

    /** Can the station receive this cargo from producers? (bus stops only passengers, truck stops no passengers). */
    takes(slot, paxSlot) {
        const f = this.facilities;
        if (f & (1 | 8 | 16)) return true;
        if (slot === paxSlot) return !!(f & 4);
        return !!(f & 2);
    }

    /** Catchment tiles (unique), cached until invalidated. */
    catchment(map) {
        if (this.catch) return this.catch;
        const seen = new Set();
        for (const p of this.parts) {
            const r = TTDData.CATCHMENT[p.kind], x = map.tx(p.t), y = map.ty(p.t);
            for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                const xx = x + dx, yy = y + dy;
                if (map.inside(xx, yy)) seen.add(yy * map.W + xx);
            }
        }
        this.catch = [...seen];
        this.rect = this._rect(map);
        return this.catch;
    }

    _rect(map) {
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (const p of this.parts) {
            const r = TTDData.CATCHMENT[p.kind], x = map.tx(p.t), y = map.ty(p.t);
            x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r);
        }
        return [x0, y0, x1, y1];
    }

    /** Does the catchment touch the tile rectangle [x, y, w, h]? */
    covers(map, x, y, w, h) {
        this.catchment(map);
        for (const p of this.parts) {
            const r = TTDData.CATCHMENT[p.kind], px = map.tx(p.t), py = map.ty(p.t);
            if (x <= px + r && x + w - 1 >= px - r && y <= py + r && y + h - 1 >= py - r) return true;
        }
        return false;
    }

    /** Recompute acceptance from houses and industries in the catchment. */
    updateAcceptance(world) {
        const map = world.map, sums = new Array(12).fill(0);
        const pax = world.cargoSlot('passengers'), mail = world.cargoSlot('mail');
        const goods = world.cargoSlot('goods'), food = world.cargoSlot('food');
        for (const t of this.catchment(map)) {
            const k = map.type[t];
            if (k === GameMap.T_HOUSE) {
                if (map.density[t] < 3) continue;
                const h = TTDData.HOUSES[map.sub[t]];
                sums[pax] += h.accPax;
                sums[mail] += h.accMail;
                sums[goods] += h.accGoods;
                if (food >= 0) sums[food] += h.accFood;
            } else if (k === GameMap.T_INDUSTRY) {
                const ind = world.industries[map.obj[t]];
                if (ind) for (const s of ind.accepts) sums[s] += 8;
            }
        }
        const old = this.accepts.slice();
        this.acceptSums = sums;
        this.accepts = sums.map(v => v >= 8);
        return old.some((v, i) => v !== this.accepts[i]) ? old : null;
    }

    /** Add cargo from a producer; returns nothing. Keeps the total under 4095 like TTD's 12 bits. */
    addWaiting(slot, n, src, srcXY, from) {
        if (n <= 0) return;
        const g = this.goods[slot];
        g.active = true;
        const last = g.waiting[g.waiting.length - 1];
        if (last && last.src === src && last.days === 0 && !last.fromTransfer) last.n += n;
        else g.waiting.push({ n, src, srcXY, days: 0, from: from || null });
        let total = this.waiting(slot);
        while (total > 4095 && g.waiting.length) {
            const p = g.waiting[0], cut = Math.min(p.n, total - 4095);
            p.n -= cut; total -= cut;
            if (p.n <= 0) g.waiting.shift();
        }
    }

    /** Take up to n units (oldest first): returns packets. */
    take(slot, n) {
        const g = this.goods[slot], out = [];
        while (n > 0 && g.waiting.length) {
            const p = g.waiting[0];
            const k = Math.min(n, p.n);
            out.push({ n: k, src: p.src, srcXY: p.srcXY, days: p.days, from: p.from });
            p.n -= k; n -= k;
            if (p.n <= 0) g.waiting.shift();
        }
        return out;
    }

    /** Remove n units from the waiting list (rating losses). */
    lose(slot, n) {
        this.take(slot, n);
    }

    /** TTD's UpdateStationRating (every 185 ticks). */
    updateRatings(world) {
        const rng = world.rng;
        const town = world.towns[this.town];
        const statue = town && town.statues[this.owner];
        for (let s = 0; s < 12; s++) {
            const g = this.goods[s];
            if (!g.active) continue;
            if (g.daysSincePickup < 255) g.daysSincePickup++;
            let rating = 0;
            const b = g.lastSpeed - 85;
            if (b >= 0) rating += b >> 2;
            const age = g.lastAge;
            if (age < 3) rating += 10;
            if (age < 2) rating += 10;
            if (age < 1) rating += 13;
            if (statue) rating += 26;
            let days = g.daysSincePickup;
            if (this.lastVehicleType === 'ship') days >>= 2;
            if (days <= 21) rating += 25;
            if (days <= 12) rating += 25;
            if (days <= 6) rating += 45;
            if (days <= 3) rating += 35;
            let waiting = this.waiting(s);
            if (waiting <= 1500) rating += 55;
            if (waiting <= 1000) rating += 35;
            if (waiting <= 600) rating += 10;
            if (waiting <= 300) rating += 20;
            if (waiting <= 100) rating += 10;
            rating -= 90;
            const old = g.rating;
            g.rating = rating = old + IMath.clamp(IMath.clamp(rating, 0, 255) - old, -2, 2);
            if (rating <= 64 && waiting >= 200) {
                let dec = rng.next() & 0x1f;
                if (waiting < 400) dec &= 7;
                this.lose(s, dec + 1);
                waiting -= dec + 1;
            }
            if (rating <= 127 && waiting > 0) {
                const r = rng.next();
                if (rating <= (r & 0x7f)) this.lose(s, ((r >>> 8) & 3) + 1);
            }
        }
    }

    toJSON() {
        const o = Object.assign({}, this);
        delete o.catch; delete o.rect;
        return o;
    }

    static fromJSON(o) {
        const s = new Station(o.id, o.xy, o.owner, o.name, o.town);
        Object.assign(s, o);
        s.catch = null;
        return s;
    }
}

/** Set by World so recentlyServed() can be called without the world. */
Station.world = null;

/** TTD's station name suffixes, tried in order for a new station in a town. */
Station.SUFFIXES = ['', ' Central', ' North', ' South', ' East', ' West', ' Heights', ' Valley', ' Woods',
    ' Lakeside', ' Exchange', ' Halt', ' Cross', ' Bridge', ' Annexe', ' Point', ' Park', ' Market',
    ' Junction', ' Square', ' Place', ' Gardens', ' Fields', ' Hill', ' Crossing', ' Mines', ' Oilfield',
    ' Airport', ' Docks', ' Transfer'];
