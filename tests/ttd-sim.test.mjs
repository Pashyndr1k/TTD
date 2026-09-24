// TTD remake simulation (no 3D): TTD's formulas, map invariants, and whole transport services
// run tick by tick on a flat test map — a bus line between two towns and a passenger railway.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadScripts } from './browser-scripts.mjs';

import { SIM_FILES } from './ttd-files.mjs';

const b64 = { btoa: s => Buffer.from(s, 'binary').toString('base64'), atob: s => Buffer.from(s, 'base64').toString('binary') };
const page = loadScripts(SIM_FILES, { performance, ...b64 });
const World = page.get('World'), GameMap = page.get('GameMap'), Commands = page.get('Commands'), Vehicles = page.get('Vehicles');
const Towns = page.get('Towns'), Track = page.get('Track'), Company = page.get('Company'), Calendar = page.get('Calendar');

function flatWorld(opts) {
    const w = new World(Object.assign({ seed: 99, mapLog2: 6, climate: 0, startYear: 1950, towns: 0, industries: 0, inflation: 0, breakdowns: 0 }, opts || {}));
    return w.createEmpty(1);
}

const idx = (w, x, y) => w.map.idx(x, y);
const engineByName = (name) => page.get('TTDData').ENGINES.find(e => e.name === name);
const run = (w, days) => { for (let i = 0; i < 74 * days; i++) w.tick(); };
const must = (r) => { assert.ok(r.ok, r.err); return r; };

test('оплата груза: формула TTD (уголь 100 т, 50 клеток, 8 периодов = £3582)', () => {
    const w = flatWorld();
    const coal = w.cargoSlot('coal');
    assert.equal(Math.floor(w.income(coal, 100, 50, 8)), 3582);
    // Passengers are paid less the slower they travel (days1 = 0, days2 = 24).
    const pax = w.cargoSlot('passengers');
    assert.ok(w.income(pax, 30, 40, 0) > w.income(pax, 30, 40, 30));
    assert.ok(w.income(pax, 30, 40, 400) > 0, 'time factor floor 31');
});

test('генерация карты: соседние углы отличаются не больше чем на уровень, край — море', () => {
    const w = new World({ seed: 1234, mapLog2: 6, climate: 1 });
    w.generate();
    const m = w.map;
    for (let y = 0; y <= m.H; y++) for (let x = 0; x < m.W; x++) assert.ok(Math.abs(m.cornerH(x, y) - m.cornerH(x + 1, y)) <= 1);
    for (let x = 0; x < m.W; x++) assert.equal(m.type[m.idx(x, 0)], GameMap.T_WATER);
    assert.ok(w.towns.length >= 2, 'towns');
    assert.ok(w.towns.every(t => t.population > 0), 'every town has people');
});

test('терраформирование: подъём угла тянет соседей, наклоны остаются допустимыми', () => {
    const w = flatWorld();
    const before = w.player.money;
    for (let i = 0; i < 4; i++) must(Commands.run(w, ex => Commands.terraform(w, 20, 20, 1, ex), true));
    const m = w.map;
    assert.equal(m.cornerH(20, 20), 5);
    for (let y = 1; y < m.H; y++) for (let x = 1; x < m.W - 1; x++) assert.ok(Math.abs(m.cornerH(x, y) - m.cornerH(x + 1, y)) <= 1);
    assert.ok(w.player.money < before, 'terraforming costs money');
});

test('рейтинг станции стартует с 175 и меняется не больше чем на 2 за обновление', () => {
    const w = flatWorld();
    must(Commands.run(w, ex => Commands.buildRailStation(w, idx(w, 10, 10), 0, 1, 3, 0, ex), true));
    const st = w.stations[0];
    const coal = w.cargoSlot('coal');
    st.addWaiting(coal, 50, st.id, st.xy, null);
    const g = st.goods[coal];
    assert.equal(g.rating, 175);
    let prev = g.rating;
    for (let i = 0; i < 40; i++) { st.updateRatings(w); assert.ok(Math.abs(g.rating - prev) <= 2); prev = g.rating; }
    assert.ok(g.rating < 175, 'no pickups: the rating drops');
});

/** Two towns 30 tiles apart on row 20 of a flat map. */
function twoTowns(w) {
    const a = Towns.found(w, idx(w, 12, 20), 18), b = Towns.found(w, idx(w, 44, 20), 18);
    assert.ok(a && b, 'towns founded');
    return [a, b];
}

test('автобусы между двумя городами возят пассажиров и зарабатывают', () => {
    const w = flatWorld();
    twoTowns(w);
    for (let x = 12; x <= 44; x++) {
        const t = idx(w, x, 20);
        if (w.map.type[t] === GameMap.T_ROAD && (w.map.road[t] & 5) === 5) continue;
        must(Commands.run(w, ex => Commands.buildRoad(w, t, 5, ex), true));
    }
    must(Commands.run(w, ex => Commands.buildRoadStop(w, idx(w, 13, 20), 0, false, ex), true));   // next to each town centre
    must(Commands.run(w, ex => Commands.buildRoadStop(w, idx(w, 43, 20), 0, false, ex), true));
    must(Commands.run(w, ex => Commands.buildDepot(w, idx(w, 28, 21), 'road', 3, 0, ex), true));   // entrance NW
    const busE = engineByName('MPS Regal Bus');
    const buses = [];
    for (let i = 0; i < 2; i++) {
        const v = Vehicles.build(w, busE.id, 0);
        assert.equal(typeof v, 'object', String(v));
        v.orders = [{ kind: 'station', dest: 0 }, { kind: 'station', dest: 1 }];
        v.stopped = false;
        buses.push(v);
    }
    run(w, 150);
    const income = w.player.finances[0][Company.C_INCOME.road];
    assert.ok(income > 0, 'bus income ' + income);
    assert.ok(buses.every(v => v.state !== 'crashed'));
    assert.ok(w.player.cur.delivered + w.player.quarters.reduce((s, q) => s + q.delivered, 0) > 0, 'passengers delivered');
    assert.ok(w.stations[0].goods[w.cargoSlot('passengers')].pickedUp, 'pickups recorded for the rating');
});

test('поезд между двумя станциями: разворот в тупике, доход, без аварий', () => {
    const w = flatWorld();
    // Station A (3 tiles along X), track, station B; a depot joined by a diagonal piece.
    must(Commands.run(w, ex => Commands.buildRailStation(w, idx(w, 8, 30), 0, 1, 3, 0, ex), true));
    for (let x = 11; x <= 44; x++) must(Commands.run(w, ex => Commands.buildRail(w, idx(w, x, 30), Track.X, 0, ex), true));
    must(Commands.run(w, ex => Commands.buildRailStation(w, idx(w, 45, 30), 0, 1, 3, 0, ex), true));
    must(Commands.run(w, ex => Commands.buildRail(w, idx(w, 20, 30), Track.LEFT, 0, ex), true));
    must(Commands.run(w, ex => Commands.buildDepot(w, idx(w, 20, 29), 'rail', 1, 0, ex), true));   // entrance SE
    // Towns around both stations.
    Towns.found(w, idx(w, 9, 25), 14);
    Towns.found(w, idx(w, 46, 25), 14);
    const loco = engineByName('Kirby Paul Tank (Steam)');
    const coach = w.buyable('rail', 0).find(e => e.wagon && w.cargo(e.cargo).key === 'passengers');
    const tr = Vehicles.build(w, loco.id, 0);
    assert.equal(typeof tr, 'object', String(tr));
    for (let i = 0; i < 3; i++) assert.equal(Vehicles.addWagon(w, tr, coach.id), null);
    tr.orders = [{ kind: 'station', dest: 0 }, { kind: 'station', dest: 1 }];
    tr.stopped = false;
    const stops = new Set();
    for (let d = 0; d < 400; d++) {
        run(w, 1);
        if (tr.state === 'load') stops.add(tr.load.station);
        assert.notEqual(tr.state, 'crashed');
    }
    assert.deepEqual([...stops].sort(), [0, 1], 'the train served both stations');
    const income = w.player.finances[0][Company.C_INCOME.train] + w.player.finances[1][Company.C_INCOME.train];
    assert.ok(income > 0, 'train income ' + income);
});

test('сигналы: два поезда на кольце с блоками не сталкиваются', () => {
    const w = flatWorld();
    // A rectangle loop: rows 20 and 30, columns 20 and 40, corners by diagonal pieces.
    const X = Track.X, Y = Track.Y;
    const lay = (x, y, tr) => must(Commands.run(w, ex => Commands.buildRail(w, idx(w, x, y), tr, 0, ex), true));
    for (let x = 21; x <= 39; x++) { lay(x, 20, X); lay(x, 30, X); }
    for (let y = 21; y <= 29; y++) { lay(20, y, Y); lay(40, y, Y); }
    lay(20, 20, Track.LOWER); lay(40, 20, Track.RIGHT); lay(40, 30, Track.UPPER); lay(20, 30, Track.LEFT);
    // One-way signals every few tiles, both trains run the same way.
    for (const x of [24, 30, 36]) { must(Commands.run(w, ex => Commands.buildSignal(w, idx(w, x, 20), X, ex), true)); must(Commands.run(w, ex => Commands.buildSignal(w, idx(w, x, 30), X, ex), true)); }
    for (const y of [23, 27]) { must(Commands.run(w, ex => Commands.buildSignal(w, idx(w, 20, y), Y, ex), true)); must(Commands.run(w, ex => Commands.buildSignal(w, idx(w, 40, y), Y, ex), true)); }
    // Stations on opposite sides.
    must(Commands.run(w, ex => Commands.buildRailStation(w, idx(w, 29, 18), 0, 1, 2, 0, ex), true));
    // Join the station into the loop by replacing the loop track: a separate station tile set on the loop itself.
    must(Commands.run(w, ex => Commands.demolish(w, idx(w, 29, 18), ex), true));
    must(Commands.run(w, ex => Commands.demolish(w, idx(w, 30, 18), ex), true));
    must(Commands.run(w, ex => Commands.buildRailStation(w, idx(w, 27, 20), 0, 1, 2, 0, ex), true));
    must(Commands.run(w, ex => Commands.buildRailStation(w, idx(w, 32, 30), 0, 1, 2, 0, ex), true));
    lay(26, 21, Y); lay(26, 20, Track.LOWER);   // a spur for the depot, joined by a diagonal piece
    must(Commands.run(w, ex => Commands.buildDepot(w, idx(w, 26, 22), 'rail', 3, 0, ex), true));
    const loco = engineByName('Kirby Paul Tank (Steam)');
    const trains = [];
    for (let i = 0; i < 2; i++) {
        const tr = Vehicles.build(w, loco.id, 0);
        assert.equal(typeof tr, 'object', String(tr));
        tr.orders = [{ kind: 'station', dest: w.stations.findIndex(s => s && s.xy === idx(w, 27, 20)) }, { kind: 'station', dest: w.stations.findIndex(s => s && s.xy === idx(w, 32, 30)) }];
        trains.push(tr);
    }
    trains[0].stopped = false;
    run(w, 20);
    trains[1].stopped = false;
    const visits = [0, 0];
    let prev = ['', ''];
    let waited = 0;
    for (let d = 0; d < 300 * 4; d++) {
        for (let i = 0; i < 74 / 4; i++) w.tick();
        trains.forEach((tr, i) => {
            const now = tr.state === 'load' ? 'load' + tr.load.station : tr.state;
            if (now !== prev[i] && tr.state === 'load') visits[i]++;
            prev[i] = now;
            if (tr.state === 'run' && tr.speed === 0) waited++;
        });
    }
    for (const tr of trains) assert.notEqual(tr.state, 'crashed', 'no collision');
    assert.ok(visits[0] >= 4 && visits[1] >= 4, 'both trains keep circulating: ' + visits);
    assert.ok(waited > 0, 'a train waited at a red signal at least once');
});

test('TTD: без "non-stop" поезд останавливается на промежуточных станциях, с ним — проезжает', () => {
    for (const nonstop of [false, true]) {
        const w = flatWorld();
        must(Commands.run(w, ex => Commands.buildRailStation(w, idx(w, 8, 30), 0, 1, 3, 0, ex), true));
        for (let x = 11; x <= 19; x++) must(Commands.run(w, ex => Commands.buildRail(w, idx(w, x, 30), Track.X, 0, ex), true));
        must(Commands.run(w, ex => Commands.buildRailStation(w, idx(w, 20, 30), 0, 1, 3, 0, ex), true));
        for (let x = 23; x <= 31; x++) must(Commands.run(w, ex => Commands.buildRail(w, idx(w, x, 30), Track.X, 0, ex), true));
        must(Commands.run(w, ex => Commands.buildRailStation(w, idx(w, 32, 30), 0, 1, 3, 0, ex), true));
        must(Commands.run(w, ex => Commands.buildRail(w, idx(w, 14, 30), Track.LEFT, 0, ex), true));
        must(Commands.run(w, ex => Commands.buildDepot(w, idx(w, 14, 29), 'rail', 1, 0, ex), true));
        const tr = Vehicles.build(w, engineByName('Kirby Paul Tank (Steam)').id, 0);
        tr.orders = [{ kind: 'station', dest: 0, nonstop }, { kind: 'station', dest: 2, nonstop }];
        tr.stopped = false;
        const seen = new Set();
        for (let d = 0; d < 200 * 4; d++) {
            for (let i = 0; i < 74 / 4; i++) w.tick();
            if (tr.state === 'load') seen.add(tr.load.station);
        }
        assert.ok(seen.has(0) && seen.has(2), 'ordered stations served');
        assert.equal(seen.has(1), !nonstop, nonstop ? 'non-stop passes B' : 'stops at B on the way');
    }
});

test('сохранение и загрузка: мир восстанавливается и продолжает идти', () => {
    const w = new World({ seed: 5, mapLog2: 6, climate: 1 });
    w.generate();
    run(w, 30);
    const json = w.save();
    const w2 = World.load(json);
    assert.equal(w2.date, w.date);
    assert.equal(w2.towns.length, w.towns.length);
    assert.equal(w2.map.W, w.map.W);
    assert.deepEqual(Array.from(w2.map.hc.slice(0, 200)), Array.from(w.map.hc.slice(0, 200)));
    run(w2, 10);
    assert.ok(w2.date > w.date);
    assert.equal(Calendar.format(Calendar.fromYMD(1941, 0, 1), true), '1st Jan 1941');
});
