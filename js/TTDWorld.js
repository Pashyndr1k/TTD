// TTDWorld.js — the simulation of the TTD remake: the clock (74 ticks a day), the tile loop
// (every tile once per 256 ticks: houses produce passengers and mail, trees spread, fields and
// rough land change), industries every 256 ticks, station ratings every 185 ticks, towns every
// 70 ticks; daily vehicle ageing and running costs; monthly loan interest, property maintenance,
// inflation, subsidies, town growth rates and industry changes; yearly finances.
//
// Everything is plain data plus the classes of TTDTown/TTDIndustry/TTDStation/TTDCompany/
// TTDVehicle; the 3D view only reads it. Game code changes the world through Commands
// (TTDCommands.js). save() / World.load() turn it into JSON and back.

class World {
    /** @param {Record<string, any>} settings — World.defaultSettings() shape */
    constructor(settings) {
        this.settings = Object.assign(World.defaultSettings(), settings || {});
        const s = this.settings;
        this.climate = s.climate;
        const n = 1 << s.mapLog2;
        this.map = new GameMap(n, n);
        this.seed = s.seed >>> 0 || ((Math.random() * 0xffffffff) >>> 0);
        this.rng = new Rng(this.seed);
        this.ticks = 0;
        this.dayTick = 0;
        this.date = Calendar.fromYMD(s.startYear, 0, 1);
        /** @type {Town[]} */
        this.towns = [];
        /** @type {(Industry | null)[]} */
        this.industries = [];
        /** @type {(Station | null)[]} */
        this.stations = [];
        /** @type {(Vehicle | null)[]} */
        this.vehicles = [];
        /** Depots: { id, t, kind: 'rail' | 'road' | 'ship', dir, owner } */
        this.depots = [];
        /** Bridges and tunnels: { id, a, b, dir, kind: 'bridge' | 'tunnel', type, z, rail: bool, owner } */
        this.wormholes = [];
        /** @type {Company[]} */
        this.companies = [];
        this.engines = [];
        this.subsidies = [];
        this.news = [];
        this.newsSeq = 0;
        this.economy = { inflPrices: 1, inflPay: 1, interest: s.interest, recession: 0, nextRecession: 0, inflYears: 0 };
        this.railOcc = new Map();
        this.railVersion = 0;
        this.blockCache = new Map();
        this.acceptanceDirty = true;
        this.tileLoopPos = 0;
        this.listeners = [];
        this.gameOver = false;
        Station.world = this;
    }

    static defaultSettings() {
        const U = 'undefined';
        return {
            climate: typeof TTD_CLIMATE !== U ? TTD_CLIMATE : 1,
            mapLog2: typeof TTD_MAP_SIZE_LOG2 !== U ? TTD_MAP_SIZE_LOG2 : 7,
            townNames: typeof TTD_TOWN_NAMES !== U ? TTD_TOWN_NAMES : 1,
            towns: typeof TTD_TOWNS !== U ? TTD_TOWNS : 1,
            industries: typeof TTD_INDUSTRIES !== U ? TTD_INDUSTRIES : 2,
            terrain: typeof TTD_TERRAIN !== U ? TTD_TERRAIN : 3,
            sea: typeof TTD_SEA !== U ? TTD_SEA : 1,
            startYear: typeof TTD_START_YEAR !== U ? TTD_START_YEAR : 1941,
            endYear: typeof TTD_END_YEAR !== U ? TTD_END_YEAR : 2051,
            maxLoan: typeof TTD_MAX_LOAN !== U ? TTD_MAX_LOAN : 100000,
            interest: typeof TTD_INTEREST !== U ? TTD_INTEREST : 4,
            vehicleCosts: typeof TTD_VEHICLE_COSTS !== U ? TTD_VEHICLE_COSTS : 1,
            constructionCosts: typeof TTD_CONSTRUCTION_COSTS !== U ? TTD_CONSTRUCTION_COSTS : 2,
            breakdowns: typeof TTD_BREAKDOWNS !== U ? TTD_BREAKDOWNS : 2,
            subsidyMult: typeof TTD_SUBSIDY_MULT !== U ? TTD_SUBSIDY_MULT : 0,
            economy: typeof TTD_ECONOMY !== U ? TTD_ECONOMY : 1,
            disasters: typeof TTD_DISASTERS !== U ? TTD_DISASTERS : 1,
            townTolerance: typeof TTD_TOWN_TOLERANCE !== U ? TTD_TOWN_TOLERANCE : 2,
            currency: typeof TTD_CURRENCY !== U ? TTD_CURRENCY : 1,
            inflation: typeof TTD_INFLATION !== U ? TTD_INFLATION : 1,
            serviceTrain: typeof TTD_SERVICE_DAYS_TRAIN !== U ? TTD_SERVICE_DAYS_TRAIN : 150,
            serviceRoad: typeof TTD_SERVICE_DAYS_ROAD !== U ? TTD_SERVICE_DAYS_ROAD : 150,
            serviceShip: typeof TTD_SERVICE_DAYS_SHIP !== U ? TTD_SERVICE_DAYS_SHIP : 360,
            serviceAir: typeof TTD_SERVICE_DAYS_AIR !== U ? TTD_SERVICE_DAYS_AIR : 100,
            autorenew: typeof TTD_AUTORENEW !== U ? TTD_AUTORENEW : 1,
            autorenewMonths: typeof TTD_AUTORENEW_MONTHS !== U ? TTD_AUTORENEW_MONTHS : 6,
            autorenewMoney: typeof TTD_AUTORENEW_MONEY !== U ? TTD_AUTORENEW_MONEY : 100000,
            gradualLoading: typeof TTD_GRADUAL_LOADING !== U ? TTD_GRADUAL_LOADING : 1,
            trainAccel: typeof TTD_TRAIN_ACCEL !== U ? TTD_TRAIN_ACCEL : 1,
            seed: typeof TTD_SEED !== U ? TTD_SEED : 0,
            refineryLimit: 16,
            companyName: 'Ortofonte Transport',
        };
    }

    // --- Time ------------------------------------------------------------------------

    get ymd() { return Calendar.toYMD(this.date); }
    get year() { return this.ymd.y; }
    get month() { return this.ymd.m; }

    // --- Prices ----------------------------------------------------------------------

    /** Current price of a TTDData.PRICES entry: difficulty multiplier and inflation applied. */
    price(key) {
        let p = TTDData.PRICES[key];
        const running = TTDData.RUNNING_PRICES.includes(key);
        const mod = running ? this.settings.vehicleCosts : this.settings.constructionCosts;
        if (mod < 1) p = p * 3 / 4; else if (mod > 1) p = p * 9 / 8;
        return p * this.economy.inflPrices;
    }

    get player() { return this.companies[0]; }

    get maxLoan() {
        const base = this.settings.maxLoan * this.economy.inflPrices;
        return Math.max(Company.LOAN_STEP, Math.round(base / 50000) * 50000 || base);
    }

    // --- Cargo -----------------------------------------------------------------------

    cargo(slot) { return slot >= 0 ? TTDData.CARGOS[this.climate][slot] : null; }

    cargoSlot(key) {
        const list = TTDData.CARGOS[this.climate];
        for (let i = 0; i < list.length; i++) if (list[i] && list[i].key === key) return i;
        return -1;
    }

    /** TTD's GetTransportedGoodsIncome (payment rates with inflation). */
    income(slot, n, dist, days) {
        const c = this.cargo(slot);
        if (!c || n <= 0) return 0;
        if (c.key === 'valuables' && dist < 10) dist = 0;
        const d1 = c.days1, d2 = c.days2;
        const over1 = Math.max(days - d1, 0), over2 = Math.max(over1 - d2, 0);
        const f = Math.max(255 - over1 - over2, 31);
        return dist * f * n * c.payment * this.economy.inflPay / 2097152;
    }

    // --- Lookups ---------------------------------------------------------------------

    nearestTown(t, maxDist) {
        const map = this.map, x = map.tx(t), y = map.ty(t);
        let best = null, bd = maxDist != null ? maxDist + 1 : 1e9;
        for (const town of this.towns) {
            const d = IMath.manhattan(x, y, map.tx(town.xy), map.ty(town.xy));
            if (d < bd) { bd = d; best = town; }
        }
        return best;
    }

    stationAt(t) {
        const m = this.map;
        return m.type[t] === GameMap.T_STATION ? this.stations[m.obj[t]] : null;
    }

    depotAt(t) {
        const m = this.map, k = m.type[t];
        if ((k === GameMap.T_RAIL && m.sub[t] === GameMap.RAIL_SUB_DEPOT) || (k === GameMap.T_ROAD && m.sub[t] === GameMap.ROAD_SUB_DEPOT) ||
            (k === GameMap.T_WATER && m.sub[t] === GameMap.WATER_SUB_DEPOT)) return this.depots[m.obj[t]];
        return null;
    }

    engine(id) { return World.ENGINE[id]; }

    // --- News ------------------------------------------------------------------------

    addNews(text, opts) {
        const o = opts || {};
        const item = { id: ++this.newsSeq, date: this.date, text, tile: o.tile != null ? o.tile : -1, kind: o.kind || 'general', big: !!o.big };
        this.news.unshift(item);
        if (this.news.length > 60) this.news.length = 60;
        for (const fn of this.listeners) fn('news', item);
        return item;
    }

    emit(what, data) { for (const fn of this.listeners) fn(what, data); }

    // --- Cargo hand-over (TTD's MoveGoodsToStation) ----------------------------------

    /**
     * Give `amount` of cargo produced in the tile rectangle (t, w, h) to the best two stations
     * whose catchment covers it. Returns the amount moved.
     */
    moveGoodsToStation(slot, amount, t, w, h, from) {
        if (slot < 0 || amount <= 0) return 0;
        const map = this.map, x = map.tx(t), y = map.ty(t);
        const pax = this.cargoSlot('passengers');
        let s1 = null, s2 = null, r1 = -1, r2 = -1;
        const town = from && from.town != null ? this.towns[from.town] : null;
        for (const st of this.stations) {
            if (!st) continue;
            if (!st.takes(slot, pax)) continue;
            const g = st.goods[slot];
            if (g.rating === 0) continue;
            if (town && town.exclusive >= 0 && town.exclusive !== st.owner) continue;
            if (!st.covers(map, x, y, w, h)) continue;
            const r = g.rating;
            if (r > r1) { s2 = s1; r2 = r1; s1 = st; r1 = r; }
            else if (r > r2) { s2 = st; r2 = r; }
        }
        if (!s1) return 0;
        const src = (st, n) => { if (n > 0) st.addWaiting(slot, n, st.id, st.xy, from); };
        if (!s2) {
            const moved = ((amount * r1) >> 8) + 1;
            src(s1, moved);
            return moved;
        }
        r2 >>= 1;
        let moved = 0;
        const tt = Math.floor(r1 * (amount + 1) / (r1 + r2));
        if (tt) {
            const m1 = ((tt * r1) >> 8) + 1;
            moved += m1; amount -= tt;
            src(s1, m1);
        }
        if (amount) {
            const m2 = ((amount * r2) >> 8) + 1;
            moved += m2;
            src(s2, m2);
        }
        return moved;
    }

    // --- Generation ----------------------------------------------------------------------

    /** A new game: landscape, towns, industries, engines, the player's company. */
    generate(progress) {
        const s = this.settings;
        Money.currency = s.currency;
        this.map.generate({ seed: this.seed, climate: this.climate, terrain: s.terrain, sea: s.sea });
        if (progress) progress(30);
        // Towns: TTD's {11, 23, 46}[setting] + rand(0..7), scaled by the map area.
        const area = this.map.W * this.map.H / 65536;
        const base = [11, 23, 46][IMath.clamp(s.towns, 0, 2)];
        const count = Math.max(2, Math.round((base + this.rng.int(8)) * area));
        for (let i = 0, tries = 0; i < count && tries < count * 200; tries++) {
            const t = this.map.idx(this.rng.range(8, this.map.W - 9), this.rng.range(8, this.map.H - 9));
            if (Towns.found(this, t)) i++;
        }
        if (progress) progress(55);
        Industries.generate(this);
        if (progress) progress(75);
        this.startupEngines();
        const player = new Company(0, s.companyName);
        player.inaugurated = this.year;
        player.money = 100000;
        player.loan = Math.min(100000, this.maxLoan);
        this.companies.push(player);
        this.economy.nextRecession = this.rng.range(168, 423);
        this.acceptanceDirty = true;
        this.addNews('Welcome to ' + TTDData.CLIMATE_NAMES[this.climate] + ' — ' + this.towns.length + ' towns, ' +
            this.industries.filter(Boolean).length + ' industries. ' + s.companyName + ' is open for business.', { kind: 'company' });
    }

    /**
     * An empty flat world (height 1, sea around the edge) with engines and the player's company —
     * for tests and scenario building.
     */
    createEmpty(height) {
        const m = this.map, h = height == null ? 1 : height;
        for (let y = 0; y <= m.H; y++) for (let x = 0; x <= m.W; x++) m.hc[y * m.CW + x] = (x === 0 || y === 0 || x === m.W || y === m.H) ? 0 : h;
        for (let t = 0; t < m.size; t++) {
            const x = m.tx(t), y = m.ty(t);
            if (m.valid(x, y) && m.tileMaxZ(t) > 0) { m.type[t] = GameMap.T_CLEAR; m.ground[t] = GameMap.G_GRASS; }
            else { m.type[t] = GameMap.T_WATER; m.owner[t] = GameMap.OWNER_WATER; }
        }
        m.markAllDirty();
        this.startupEngines();
        const player = new Company(0, this.settings.companyName);
        player.inaugurated = this.year;
        player.money = 100000;
        player.loan = Math.min(100000, this.maxLoan);
        this.companies.push(player);
        Money.currency = this.settings.currency;
        return this;
    }

    /** TTD's StartupEngines: randomised intro dates and reliability curves. */
    startupEngines() {
        const base = Calendar.fromYMD(1920, 0, 1);
        this.engines = [];
        for (const e of TTDData.ENGINES) {
            if (!(e.climates & TTDData.CLIMATE_MASK[this.climate])) continue;
            const r1 = this.rng.next(), r2 = this.rng.next(), r3 = this.rng.next();
            let intro = base + e.intro;
            if (e.intro > 365 * 2) intro += r1 & 0x1ff;
            this.engines[e.id] = {
                id: e.id, intro,
                relStart: ((r1 >>> 16) & 0x3fff) + 0x7ae0,
                relMax: (r2 & 0x3fff) + 0xbfff,
                relFinal: ((r2 >>> 16) & 0x3fff) + 0x3fff,
                d1: (r3 & 0x1f) + 7,
                d2: ((r3 >>> 5) & 0xf) + e.baseLife * 12 - 96,
                d3: ((r3 >>> 9) & 0x7f) + 120,
                reliability: 0,
                available: false,
                retired: false,
                announced: false,
            };
        }
        this.updateEngines(false);
    }

    /** Monthly: engine reliability along its curve; announce new models; retire old ones. */
    updateEngines(news) {
        for (const st of this.engines) {
            if (!st) continue;
            const months = Math.floor((this.date - st.intro) / 30.4);
            if (months < 0) continue;
            if (!st.available && !st.retired) {
                st.available = true;
                if (news && !World.ENGINE[st.id].wagon) {
                    this.addNews('New ' + World.typeName(World.ENGINE[st.id]) + ' now available! ' + World.ENGINE[st.id].name, { kind: 'vehicle', big: true });
                }
            }
            let r;
            if (months < st.d1) r = st.relStart + (st.relMax - st.relStart) * months / st.d1;
            else if (months < st.d1 + st.d2) r = st.relMax;
            else if (months < st.d1 + st.d2 + st.d3) r = st.relMax - (st.relMax - st.relFinal) * (months - st.d1 - st.d2) / st.d3;
            else {
                r = st.relFinal;
                const e = World.ENGINE[st.id];
                if (!st.retired && !e.wagon) {
                    st.retired = true; st.available = false;
                    if (news) this.addNews(e.name + ' is no longer available.', { kind: 'vehicle' });
                }
            }
            st.reliability = Math.round(r);
        }
    }

    static typeName(e) {
        if (e.type === 'rail') return e.rail === 2 ? 'monorail engine' : e.rail === 3 ? 'maglev engine' : 'railway locomotive';
        if (e.type === 'road') return 'road vehicle';
        if (e.type === 'ship') return 'ship';
        return 'aircraft';
    }

    /** Engines the player can buy of a type ('rail' | 'road' | 'ship' | 'air'). */
    buyable(type, railType) {
        const out = [];
        for (const st of this.engines) {
            if (!st || !st.available) continue;
            const e = World.ENGINE[st.id];
            if (e.type !== type) continue;
            if (type === 'rail' && railType != null && !Vehicles.railCompatible(e.rail, railType) && !(e.wagon && Vehicles.wagonOn(e.rail, railType))) continue;
            out.push(e);
        }
        return out;
    }

    // --- The clock ---------------------------------------------------------------------

    /** Advance one game tick. */
    tick() {
        this.ticks++;
        const t = this.ticks;
        for (const v of this.vehicles) if (v) v.tick(this);
        Vehicles.afterTick(this);
        // Tile loop: every tile once per 256 ticks.
        const size = this.map.size, per = Math.max(1, size >> 8);
        for (let i = 0; i < per; i++) {
            this.tileLoop(this.tileLoopPos);
            this.tileLoopPos = (this.tileLoopPos + 1) % size;
        }
        if (t % 185 === 0) {
            for (const st of this.stations) if (st) st.updateRatings(this);
            Vehicles.ageCargo(this);
        }
        if ((t & 0xff) === 0) for (const ind of this.industries) if (ind) Industries.produce(this, ind);
        if ((t & 0x1ff) === 0) for (const ind of this.industries) if (ind && ind.type === 25) Industries.lumber(this, ind);
        if (t % Town.TICKS === 0) for (const town of this.towns) Towns.tick(this, town);
        if (t % 250 === 0 && this.acceptanceDirty) this.updateAcceptance();
        if (++this.dayTick >= 74) {
            this.dayTick = 0;
            this.newDay();
        }
    }

    tileLoop(t) {
        const map = this.map, k = map.type[t];
        if (k === GameMap.T_HOUSE) {
            Towns.tileLoop(this, t);
        } else if (k === GameMap.T_TREES) {
            if (this.rng.chance(1, 160)) this.spreadTree(t);
        } else if (k === GameMap.T_CLEAR) {
            // Rough land slowly returns to grass; neglected fields turn into grass far from farms.
            if (map.ground[t] === GameMap.G_ROUGH && this.rng.chance(1, 40)) { map.ground[t] = GameMap.G_GRASS; map.markDirty(t); }
        }
    }

    spreadTree(t) {
        const map = this.map, d = this.rng.int(4), n = map.neighbour(t, d);
        if (n < 0 || !map.valid(map.tx(n), map.ty(n))) return;
        if (map.type[n] !== GameMap.T_CLEAR || map.ground[n] === GameMap.G_FIELDS || map.ground[n] === GameMap.G_ROCKS) return;
        if (this.climate === 1 && map.zone[n] === GameMap.Z_DESERT && this.rng.chance(9, 10)) return;
        map.plantTree(n, this.rng, this.climate === 1);
        map.treeCount[n] = 1;
    }

    updateAcceptance() {
        this.acceptanceDirty = false;
        for (const st of this.stations) {
            if (!st) continue;
            const old = st.updateAcceptance(this);
            if (old && st.owner === 0) {
                const gained = [], lost = [];
                st.accepts.forEach((v, s) => { if (v && !old[s] && this.cargo(s)) gained.push(this.cargo(s).name); if (!v && old[s] && this.cargo(s)) lost.push(this.cargo(s).name); });
                if (lost.length && st.built < this.date - 2) this.addNews(st.name + ' no longer accepts ' + lost.join(', '), { tile: st.xy, kind: 'station' });
                else if (gained.length && st.built < this.date - 2) this.addNews(st.name + ' now accepts ' + gained.join(', '), { tile: st.xy, kind: 'station' });
            }
        }
    }

    newDay() {
        const before = this.ymd;
        this.date++;
        const now = this.ymd;
        for (const v of this.vehicles) if (v) v.onNewDay(this);
        if (now.m !== before.m) this.newMonth(before, now);
        if (now.y !== before.y) this.newYear(before.y, now.y);
        this.emit('day', now);
    }

    newMonth(before, now) {
        const p = this.player;
        const s = this.settings;
        // Loan interest (TTD: loan * rate * 54 / 65536 per month ≈ rate / 12).
        if (p.loan > 0) p.spend(p.loan * this.economy.interest / 100 / 12, Company.C_INTEREST);
        // Property maintenance: station facilities; "other" — the company's office.
        let facilities = 0;
        for (const st of this.stations) if (st && st.owner === 0) facilities += IMath.bits(st.facilities);
        if (facilities) p.spend(facilities * this.price('stationValue') / 2, Company.C_PROPERTY);
        p.spend(25 * this.economy.inflPrices, Company.C_OTHER);
        for (const town of this.towns) Towns.monthly(this, town);
        Industries.monthly(this);
        Subsidies.monthly(this);
        this.updateEngines(true);
        // Inflation: prices +rate%/year, payments one point less (TTD's AddInflation), 170 years at most.
        if (s.inflation && this.economy.inflYears < 170) {
            const r = this.economy.interest;
            this.economy.inflPrices *= 1 + r * 54 / 65536;
            this.economy.inflPay *= 1 + Math.max(0, r - 1) * 54 / 65536;
            if (now.m === 0) this.economy.inflYears++;
        }
        // Recessions (fluctuating economy).
        if (s.economy > 0) {
            if (this.economy.recession > 0) {
                if (--this.economy.recession === 0) this.addNews('Recession Over! Upturn in trade gives confidence to industries as economy strengthens!', { kind: 'economy', big: true });
            } else if (--this.economy.nextRecession <= 0) {
                this.economy.recession = 12;
                this.economy.nextRecession = this.rng.range(312, 567);
                this.addNews('World Recession! Financial experts fear worst as economy slumps!', { kind: 'economy', big: true });
            }
        }
        if (now.m % 3 === 0) this.newQuarter();
        this.emit('month', now);
    }

    newQuarter() {
        const p = this.player;
        const value = this.companyValue(p);
        p.score = this.performance(p);
        p.quarters.unshift({ income: p.cur.income, expenses: p.cur.expenses, delivered: p.cur.delivered, value, score: p.score });
        if (p.quarters.length > 24) p.quarters.length = 24;
        p.cur = Company.emptyQuarter();
        // Bankruptcy: TTD's quarterly check.
        if (p.money < 0) {
            p.bankruptcy++;
            if (p.bankruptcy === 2) this.addNews(p.name + ' is in trouble! Money is below zero: raise money or the company will go bankrupt.', { kind: 'company', big: true });
            if (p.bankruptcy === 3) this.addNews('Bankruptcy warning: ' + p.name + ' will be closed next quarter unless its bank balance is positive.', { kind: 'company', big: true });
            if (p.bankruptcy >= 4) {
                this.addNews(p.name + ' has gone bankrupt! Game over.', { kind: 'company', big: true });
                this.gameOver = true;
                this.emit('gameover', { bankrupt: true });
            }
        } else {
            p.bankruptcy = 0;
        }
    }

    newYear(oldYear, year) {
        const p = this.player;
        p.finances.unshift(Company.emptyYear());
        p.finances.length = 3;
        for (const v of this.vehicles) if (v) v.onNewYear(this);
        if (year >= this.settings.endYear && !this.gameOver) {
            this.addNews('The year ' + year + ' has arrived: final performance rating ' + p.score + ' / 1000 — ' + World.scoreTitle(p.score) + '. You may continue playing.', { kind: 'company', big: true });
            this.emit('gameover', { end: true, score: p.score });
        }
        this.emit('year', year);
    }

    static scoreTitle(score) {
        const T = ['Businessman', 'Entrepreneur', 'Industrialist', 'Capitalist', 'Magnate', 'Mogul', 'Tycoon of the Century'];
        return T[Math.min(6, Math.floor(score / 1000 * 7))];
    }

    companyValue(p) {
        let v = 0;
        for (const st of this.stations) if (st && st.owner === p.id) v += IMath.bits(st.facilities) * this.price('stationValue') * 25;
        for (const veh of this.vehicles) if (veh && veh.owner === p.id) v += veh.value;
        v += p.money - p.loan;
        return Math.max(1, Math.round(v));
    }

    /** TTD's performance rating (quarterly). */
    performance(p) {
        const vs = this.vehicles.filter(v => v && v.owner === p.id);
        const old = vs.filter(v => v.age > 730);
        const vals = [
            vs.filter(v => v.profitLast > 0).length,
            this.stations.filter(s => s && s.owner === p.id).reduce((a, s) => a + IMath.bits(s.facilities), 0),
            old.length ? Math.min(...old.map(v => v.profitLast)) : 0,
            p.quarters.length ? Math.min(...p.quarters.slice(0, 12).map(q => q.income)) : 0,
            p.quarters.length ? Math.max(...p.quarters.slice(0, 12).map(q => q.income), p.cur.income) : p.cur.income,
            p.quarters.slice(0, 4).reduce((a, q) => a + q.delivered, 0),
            IMath.bits(p.cur.cargoTypes),
            p.money,
            250000 - p.loan,
        ];
        let score = 0;
        Company.SCORE.forEach((s, i) => { score += Math.floor(Math.max(0, Math.min(vals[i], s.needed)) / s.needed * s.points); });
        return Math.min(1000, score);
    }

    // --- Save / load -------------------------------------------------------------------

    save() {
        return JSON.stringify({
            v: 1, settings: this.settings, seed: this.seed, rngState: this.rng.s, ticks: this.ticks, dayTick: this.dayTick, date: this.date,
            map: this.map.toJSON(), towns: this.towns, industries: this.industries, stations: this.stations,
            vehicles: this.vehicles.map(v => v ? v.toJSON() : null), depots: this.depots, wormholes: this.wormholes,
            companies: this.companies, engines: this.engines, subsidies: this.subsidies, news: this.news.slice(0, 30),
            economy: this.economy, tileLoopPos: this.tileLoopPos, newsSeq: this.newsSeq,
        });
    }

    static load(json) {
        const o = typeof json === 'string' ? JSON.parse(json) : json;
        const w = new World(o.settings);
        w.seed = o.seed;
        w.rng.s = o.rngState >>> 0;
        w.ticks = o.ticks; w.dayTick = o.dayTick; w.date = o.date;
        w.map = GameMap.fromJSON(o.map);
        w.towns = o.towns.map(Town.fromJSON);
        w.industries = o.industries.map(i => i ? Industry.fromJSON(i) : null);
        w.stations = o.stations.map(s => s ? Station.fromJSON(s) : null);
        w.vehicles = o.vehicles.map(v => v ? Vehicles.fromJSON(v) : null);
        w.depots = o.depots;
        w.wormholes = o.wormholes;
        w.companies = o.companies.map(Company.fromJSON);
        w.engines = o.engines;
        w.subsidies = o.subsidies || [];
        w.news = o.news || [];
        w.newsSeq = o.newsSeq || 0;
        w.economy = o.economy;
        w.tileLoopPos = o.tileLoopPos || 0;
        w.climate = w.settings.climate;
        Money.currency = w.settings.currency;
        w.acceptanceDirty = true;
        for (const v of w.vehicles) if (v) v.relink(w);
        Vehicles.rebuildOccupancy(w);
        return w;
    }
}

World.ENGINE = {};
for (const e of TTDData.ENGINES) World.ENGINE[e.id] = e;


/** Subsidies (TTD's SubsidyMonthlyHandler, 0.5 rules). */
/** @satisfies {Record<string, any>} */
const Subsidies = {
    monthly(world) {
        const map = world.map, rng = world.rng;
        // Age offers and awards.
        for (const s of world.subsidies) {
            s.months++;
            if (!s.awarded && s.months >= 12) {
                s.dead = true;
                world.addNews('Offer of subsidy expired: ' + Subsidies.describe(world, s) + ' will no longer attract a subsidy.', { kind: 'subsidy' });
            } else if (s.awarded && s.months >= 12) {
                s.dead = true;
                world.addNews('Subsidy withdrawn: ' + Subsidies.describe(world, s) + ' is no longer subsidised.', { kind: 'subsidy' });
            }
        }
        world.subsidies = world.subsidies.filter(s => !s.dead);
        if (world.subsidies.length >= 8 || !rng.chance(1, 4)) return;
        const pax = world.cargoSlot('passengers');
        let offer = null;
        if (rng.chance(1, 2)) {
            // Passengers between two towns of 400+ people, at most 70 tiles apart.
            const a = rng.pick(world.towns), b = rng.pick(world.towns);
            if (a && b && a !== b && a.population >= 400 && b.population >= 400 &&
                IMath.manhattan(map.tx(a.xy), map.ty(a.xy), map.tx(b.xy), map.ty(b.xy)) <= 70 &&
                (!b.lastPaxMax || b.lastPaxAct * 100 / b.lastPaxMax <= 42)) {
                offer = { slot: pax, fromTown: true, from: a.id, toTown: true, to: b.id };
            }
        } else {
            const ind = rng.pick(world.industries.filter(Boolean));
            if (ind && ind.produced.length) {
                const p = ind.produced[rng.int(ind.produced.length)];
                if (p.lastMonth > 0 && p.pctLast <= 42) {
                    const c = world.cargo(p.slot);
                    if (c.key === 'goods' || c.key === 'food') {
                        const town = rng.pick(world.towns.filter(t => t.population >= 900));
                        if (town && IMath.manhattan(map.tx(ind.xy), map.ty(ind.xy), map.tx(town.xy), map.ty(town.xy)) <= 70) {
                            offer = { slot: p.slot, fromTown: false, from: ind.id, toTown: true, to: town.id };
                        }
                    } else {
                        const dst = rng.pick(world.industries.filter(i => i && i.accepts.includes(p.slot)));
                        if (dst && dst !== ind && IMath.manhattan(map.tx(ind.xy), map.ty(ind.xy), map.tx(dst.xy), map.ty(dst.xy)) <= 70) {
                            offer = { slot: p.slot, fromTown: false, from: ind.id, toTown: false, to: dst.id };
                        }
                    }
                }
            }
        }
        if (!offer) return;
        if (world.subsidies.some(s => s.slot === offer.slot && s.from === offer.from && s.to === offer.to && s.fromTown === offer.fromTown)) return;
        Object.assign(offer, { months: 0, awarded: false, company: -1, srcStation: -1, dstStation: -1 });
        world.subsidies.push(offer);
        world.addNews('Subsidy offered: first service of ' + Subsidies.describe(world, offer) + ' will attract a year\'s subsidy from the local authority!', { kind: 'subsidy', big: true });
    },

    placeName(world, isTown, id) {
        if (isTown) return world.towns[id] ? world.towns[id].name : '?';
        const ind = world.industries[id];
        return ind ? Industries.name(world, ind) : '?';
    },

    describe(world, s) {
        return world.cargo(s.slot).name + ' from ' + Subsidies.placeName(world, s.fromTown, s.from) + ' to ' + Subsidies.placeName(world, s.toTown, s.to);
    },

    placeXY(world, isTown, id) {
        return isTown ? world.towns[id] && world.towns[id].xy : world.industries[id] && world.industries[id].xy;
    },

    /** Delivery from station a to station b: is it subsidised (awarding a free offer if it matches)? */
    check(world, slot, a, b, company) {
        const map = world.map;
        for (const s of world.subsidies) {
            if (s.slot !== slot) continue;
            if (s.awarded) {
                if (s.company === company && s.srcStation === a.id && s.dstStation === b.id) return true;
                continue;
            }
            const fx = Subsidies.placeXY(world, s.fromTown, s.from), tx = Subsidies.placeXY(world, s.toTown, s.to);
            if (fx == null || tx == null) continue;
            if (IMath.distMax(map.tx(a.xy), map.ty(a.xy), map.tx(fx), map.ty(fx)) > 9) continue;
            if (IMath.distMax(map.tx(b.xy), map.ty(b.xy), map.tx(tx), map.ty(tx)) > 9) continue;
            s.awarded = true; s.months = 0; s.company = company; s.srcStation = a.id; s.dstStation = b.id;
            const mult = ['x1.5', 'x2', 'x3', 'x4'][world.settings.subsidyMult];
            world.addNews('Service subsidy awarded to ' + world.companies[company].name + '! ' + Subsidies.describe(world, s) +
                ' will pay ' + mult + ' rates for the next year!', { kind: 'subsidy', big: true, tile: b.xy });
            return true;
        }
        return false;
    },
};
