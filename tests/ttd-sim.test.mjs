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
const Town = page.get('Town'), Dir = page.get('Dir');

function flatWorld(opts) {
    const w = new World(Object.assign({ seed: 99, mapLog2: 6, climate: 0, startYear: 1950, towns: 0, industries: 0, inflation: 0, breakdowns: 0 }, opts || {}));
    return w.createEmpty(1);
}

const idx = (w, x, y) => w.map.idx(x, y);
const engineByName = (name) => page.get('TTDData').ENGINES.find(e => e.name === name);
const run = (w, days) => { for (let i = 0; i < 74 * days; i++) w.tick(); };
const must = (r) => { assert.ok(r.ok, r.err); return r; };
/** Values made in the page's realm, as plain JSON (deepEqual across realms). */
const plain = (x) => JSON.parse(JSON.stringify(x));

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
test('автобусы между двумя городами возят пассажиров и зарабатывают', () => {
    const w = flatWorld();
    // The line first: one drag of road, stops, a depot led in by a half road. Towns founded next
    // to it grow from this road, like TTD towns grow along any road near their centre.
    const line = Commands.roadDrag(w.map, { fx: 8.2, fy: 20.5 }, { fx: 48.7, fy: 20.5 }, 0);
    must(Commands.run(w, ex => Commands.buildLongRoad(w, line, ex), true));
    must(Commands.run(w, ex => Commands.buildRoadStop(w, idx(w, 13, 20), 0, false, ex), true));
    must(Commands.run(w, ex => Commands.buildRoadStop(w, idx(w, 43, 20), 0, false, ex), true));
    must(Commands.run(w, ex => Commands.buildDepot(w, idx(w, 28, 21), 'road', 3, 0, ex), true));   // entrance NW
    must(Commands.run(w, ex => Commands.buildRoad(w, idx(w, 28, 20), 2, ex), true));   // TTD: the road is led into the depot by hand
    const a = Towns.found(w, idx(w, 12, 19), 18), b = Towns.found(w, idx(w, 44, 19), 18);
    assert.ok(a && b && a.numHouses > 5 && b.numHouses > 5, 'towns founded and grown');
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

// --- Roads: TTD's construction rules ------------------------------------------------------------

/** A flat world with corners (cx, cy) raised by one level (one terraform each). */
function hillyWorld(corners) {
    const w = flatWorld();
    for (const [cx, cy] of corners) must(Commands.run(w, ex => Commands.terraform(w, cx, cy, 1, ex), true));
    return w;
}

test('дороги на склонах: полудорога достраивается, фундаменты TTD, высоты концов', () => {
    // (20,20): W raised; (30,20): an incline rising to SW; (40,20): three corners raised.
    const w = hillyWorld([[21, 20], [31, 20], [31, 21], [41, 20], [41, 21], [40, 21]]);
    const m = w.map, road = w.price('buildRoad'), found = w.price('terraform'), clear = w.price('clearGrass');
    const oneCorner = idx(w, 20, 20), incline = idx(w, 30, 20), three = idx(w, 40, 20);
    assert.equal(m.slope(oneCorner), GameMap.SLOPE_W);
    assert.equal(m.inclineAxis(incline), 0);
    // One corner raised: a half road becomes the whole straight road on an inclined foundation.
    let r = must(Commands.run(w, ex => Commands.buildRoad(w, oneCorner, 1, ex), true));
    assert.equal(m.road[oneCorner], GameMap.ROAD_X);
    assert.equal(r.cost, 2 * road + found + clear);
    assert.equal(m.roadFoundation(oneCorner, m.road[oneCorner]), 2);
    assert.deepEqual([Track.roadEdgeZ(m, oneCorner, 0), Track.roadEdgeZ(m, oneCorner, 2)], [1, 2], 'NE end low, SW end high');
    assert.equal(Commands.buildRoad(w, oneCorner, 2, false).err, 'Land sloped in wrong direction');
    // Incline: straight along it without a foundation; a crossroads is refused, a T on the high side levels it.
    r = must(Commands.run(w, ex => Commands.buildRoad(w, incline, 4, ex), true));
    assert.equal(m.road[incline], GameMap.ROAD_X);
    assert.equal(r.cost, 2 * road + clear);
    assert.ok(!Commands.buildRoad(w, incline, GameMap.ROAD_Y, false).ok, 'no crossroads on an incline');
    // Three corners raised: a levelled foundation takes any road, all ends at the top.
    must(Commands.run(w, ex => Commands.buildRoad(w, three, GameMap.ROAD_ALL, ex), true));
    for (let d = 0; d < 4; d++) assert.equal(Track.roadEdgeZ(m, three, d), 2);
    // A straight road on a slope goes as a whole.
    must(Commands.run(w, ex => Commands.removeRoad(w, incline, 1, ex), true));
    assert.equal(m.type[incline], GameMap.T_CLEAR);
});

test('протяжка дороги: полуклетки под курсором, всё или ничего', () => {
    const w = flatWorld(), m = w.map;
    const list = Commands.roadDrag(m, { fx: 5.7, fy: 10.5 }, { fx: 7.2, fy: 10.5 }, 0);
    assert.deepEqual(plain(list.map(q => [m.tx(q.t), q.bits])), [[5, 4], [6, 5], [7, 1]]);
    must(Commands.run(w, ex => Commands.buildLongRoad(w, list, ex), true));
    assert.deepEqual([5, 6, 7].map(x => m.road[idx(w, x, 10)]), [4, 5, 1]);
    // A click lays the half toward the pointer.
    assert.deepEqual(plain(Commands.roadDrag(m, { fx: 9.2, fy: 12.9 }, { fx: 9.2, fy: 12.9 }, 1).map(q => q.bits)), [2]);
    // A station in the way stops the whole drag; nothing is built.
    must(Commands.run(w, ex => Commands.buildRailStation(w, idx(w, 10, 40), 0, 1, 1, 0, ex), true));
    const r = Commands.run(w, ex => Commands.buildLongRoad(w, Commands.roadDrag(m, { fx: 5.5, fy: 40.5 }, { fx: 15.5, fy: 40.5 }, 0), ex), true);
    assert.ok(!r.ok);
    assert.equal(m.type[idx(w, 5, 40)], GameMap.T_CLEAR);
    // Pieces already there are free: dragging over the built road again costs nothing more.
    const again = Commands.buildLongRoad(w, Commands.roadDrag(m, { fx: 5.1, fy: 10.5 }, { fx: 7.9, fy: 10.5 }, 0), false);
    assert.equal(again.cost, 2 * w.price('buildRoad'));
});

test('городские дороги: середину убирает только "extra dynamite", рейтинг −50 / −18', () => {
    const w = flatWorld(), m = w.map;
    const town = new Town(0, idx(w, 30, 25), 'Testville');
    w.towns.push(town);
    for (let x = 28; x <= 32; x++) must(Commands.buildRoad(w, idx(w, x, 30), GameMap.ROAD_X, true, town));
    assert.equal(m.roadOwner[idx(w, 30, 30)], GameMap.OWNER_TOWN);
    w.settings.extraDynamite = 0;
    assert.match(Commands.removeRoad(w, idx(w, 30, 30), GameMap.ROAD_X, false).err, /owned by Testville/);
    const before = town.rating(0);
    must(Commands.run(w, ex => Commands.removeRoad(w, idx(w, 32, 30), GameMap.ROAD_X, ex), true));
    assert.equal(town.rating(0), before - 18, 'the end of a road');
    w.settings.extraDynamite = 1;
    must(Commands.run(w, ex => Commands.removeRoad(w, idx(w, 30, 30), GameMap.ROAD_X, ex), true));
    assert.equal(town.rating(0), before - 18 - 50, 'the middle of a road');
});

test('переезд: дорога через рельсы, снос оставляет рельсы; депо на склоне — въездом к подъёму', () => {
    const w = hillyWorld([[51, 20]]), m = w.map;
    const t = idx(w, 10, 50);
    must(Commands.run(w, ex => Commands.buildRail(w, t, Track.X, 0, ex), true));
    const r = must(Commands.run(w, ex => Commands.buildRoad(w, t, 2, ex), true));
    assert.equal(r.cost, 2 * w.price('buildRoad'));
    assert.equal(m.sub[t], GameMap.ROAD_SUB_CROSSING);
    assert.equal(m.road[t], GameMap.ROAD_Y, 'a crossing always takes the whole road');
    must(Commands.run(w, ex => Commands.demolish(w, t, ex), true));
    assert.equal(m.type[t], GameMap.T_RAIL);
    assert.equal(m.rail[t], 1 << Track.X);
    // (50,20) has its W corner raised: the entrance must face the SW or NW side.
    assert.ok(!Commands.buildDepot(w, idx(w, 50, 20), 'road', 0, 0, false).ok);
    assert.ok(Commands.buildDepot(w, idx(w, 50, 20), 'road', 2, 0, false).ok);
});

test('ремонт дорог: город, оплативший реконструкцию, закрывает участки на 15 циклов', () => {
    const w = flatWorld(), m = w.map;
    const town = new Town(0, idx(w, 30, 30), 'Testville');
    w.towns.push(town);
    for (let x = 27; x <= 33; x++) must(Commands.buildRoad(w, idx(w, x, 30), GameMap.ROAD_X, true, town));
    const t = idx(w, 31, 30);
    w.roadTileLoop(t);
    assert.equal(m.roadside(t), GameMap.RS_GRASS, 'bare verges grass over');
    town.roadWorks = 6;
    for (let i = 0; i < 400 && !m.roadWorks(t); i++) w.roadTileLoop(t);
    assert.ok(m.roadWorks(t) > 0, 'road works started');
    assert.equal(Track.roadConnects(m, idx(w, 30, 30), 2), -1, 'closed to traffic');
    for (let i = 0; i < 15; i++) w.roadTileLoop(t);
    assert.equal(m.roadWorks(t), 0, 'finished');
    assert.equal(Track.roadConnects(m, idx(w, 30, 30), 2), t);
});

test('города строят дороги по правилам TTD: без запрещённых склонов, с домами вдоль дорог', () => {
    const w = new World({ seed: 77, mapLog2: 7, climate: 0, terrain: 3 });
    w.generate();
    const m = w.map;
    let roads = 0;
    for (let t = 0; t < m.size; t++) {
        if (m.type[t] !== GameMap.T_ROAD || m.sub[t] !== 0) continue;
        roads++;
        assert.ok(m.roadFoundation(t, m.road[t]) >= 0, 'road bits allowed on the slope of ' + m.tx(t) + ',' + m.ty(t));
    }
    assert.ok(roads > w.towns.length * 3, 'towns have roads');
    // Every house stands next to a road or another house of its town.
    for (let t = 0; t < m.size; t++) {
        if (m.type[t] !== GameMap.T_HOUSE || m.obj[t] !== t) continue;
        let near = false;
        for (let d = 0; d < 4; d++) {
            const n = m.neighbour(t, d);
            if (n >= 0 && (m.type[n] === GameMap.T_ROAD || m.type[n] === GameMap.T_HOUSE || m.type[n] === GameMap.T_STATION)) near = true;
        }
        assert.ok(near, 'house by a road');
    }
});

test('рельсы на склонах: наклонный фундамент вместо ступенек, ровный диагональный кусок без фундамента', () => {
    // (20,20): W raised. X track there climbs on an inclined foundation; the RIGHT piece (near the
    // low E corner) lies level and needs none; LEFT joins with a levelled foundation.
    const w = hillyWorld([[21, 20], [31, 20]]), m = w.map;
    const t = idx(w, 20, 20), rail = w.price('buildRail'), found = w.price('terraform'), clear = w.price('clearGrass');
    let r = must(Commands.run(w, ex => Commands.buildRail(w, t, Track.X, 0, ex), true));
    assert.equal(r.cost, rail + found + clear);
    assert.deepEqual([Track.railEdgeZ(m, t, Track.X, 0), Track.railEdgeZ(m, t, Track.X, 2)], [1, 2], 'a ramp, not a step');
    assert.ok(!Commands.buildRail(w, t, Track.Y, 0, false).ok, 'no second piece on an inclined foundation');
    const u = idx(w, 30, 20);
    r = must(Commands.run(w, ex => Commands.buildRail(w, u, Track.RIGHT, 0, ex), true));
    assert.equal(r.cost, rail + clear, 'level along the slope: no foundation');
    assert.ok(!Commands.buildRail(w, u, Track.LEFT, 0, false).ok, 'the other diagonal would need another foundation');
});

test('кривые: угловой кусок продолжает соседние без скачка, дорога по диагонали — зигзаг поворотов', () => {
    const w = flatWorld(), m = w.map;
    // A curve: X track, then the corner piece, then Y track.
    for (let x = 10; x < 14; x++) must(Commands.run(w, ex => Commands.buildRail(w, idx(w, x, 10), Track.X, 0, ex), true));
    must(Commands.run(w, ex => Commands.buildRail(w, idx(w, 14, 10), Track.RIGHT, 0, ex), true));
    for (let y = 11; y < 14; y++) must(Commands.run(w, ex => Commands.buildRail(w, idx(w, 14, y), Track.Y, 0, ex), true));
    const c = idx(w, 14, 10), td = Track.tdFrom(Track.RIGHT, Dir.NE);
    const p0 = Track.pointOn(m, c, td, 0), p1 = Track.pointOn(m, c, td, Track.length(Track.RIGHT));
    assert.ok(Math.hypot(p0.x - 14, p0.y - 10.5) < 1e-9 && Math.hypot(p1.x - 14.5, p1.y - 11) < 1e-9, 'ends at the edge midpoints');
    assert.ok(Math.abs(p0.heading - 0) < 1e-6 && Math.abs(p1.heading - Math.PI / 2) < 1e-6, 'tangent to the straights: a curve');
    // A 45° road drag: a zig-zag of turns from end to end, joined to the road it starts at.
    must(Commands.run(w, ex => Commands.buildRoad(w, idx(w, 29, 30), 5, ex), true));
    const list = Commands.roadPath(m, { fx: 30.2, fy: 30.5 }, { fx: 34.5, fy: 34.5 });
    const turns = list.filter(q => q.bits === 3 || q.bits === 6 || q.bits === 12 || q.bits === 9).length;
    assert.ok(turns >= list.length - 2, 'turns all the way');
    assert.ok(list[0].bits & (1 << Dir.NE), 'the start joins the road beside it');
    must(Commands.run(w, ex => Commands.buildLongRoad(w, list, ex), true));
    let n = 0;
    for (let i = 0; i + 1 < list.length; i++) {
        const d = [0, 1, 2, 3].find(k => m.neighbour(list[i].t, k) === list[i + 1].t);
        if (Track.roadConnects(m, list[i].t, d) === list[i + 1].t) n++;
    }
    assert.equal(n, list.length - 1, 'a road vehicle can drive it end to end');
});

test('карта: каждая новая игра — новая карта, горы не больше 30 % суши', () => {
    const a = new World({ mapLog2: 6, climate: 0 }), b = new World({ mapLog2: 6, climate: 0 });
    assert.notEqual(a.seed, b.seed);
    for (const seed of [1, 2, 3, 4]) {
        const w = new World({ seed, mapLog2: 7, climate: 1, terrain: 3 });
        w.map.generate({ seed, climate: 1, terrain: 3, sea: 1 });
        const m = w.map;
        let land = 0, high = 0;
        for (let t = 0; t < m.size; t++) { if (m.type[t] === GameMap.T_WATER) continue; land++; if (m.tileMaxZ(t) > 2) high++; }
        assert.ok(high / land <= 0.3, 'mountains ' + (high / land * 100).toFixed(1) + '% (seed ' + seed + ')');
    }
});

test('кнопка Reverse: едущий поезд тормозит и едет обратно паровозом вперёд; наклон вагонов на уклоне', () => {
    // Track along row 20 up a ramp (tile 29 is an incline up to level 2), a station at the top.
    const w = flatWorld(), m = w.map, Trains = page.get('Trains');
    for (let x = 30; x <= 55; x++) for (let y = 18; y <= 23; y++) m.hc[y * m.CW + x] = 2;
    for (let x = 10; x <= 44; x++) must(Commands.run(w, ex => Commands.buildRail(w, idx(w, x, 20), Track.X, 0, ex), true));
    must(Commands.run(w, ex => Commands.buildRailStation(w, idx(w, 45, 20), 0, 1, 3, 0, ex), true));
    must(Commands.run(w, ex => Commands.buildRail(w, idx(w, 9, 20), Track.LOWER, 0, ex), true));
    must(Commands.run(w, ex => Commands.buildDepot(w, idx(w, 9, 21), 'rail', Dir.NW, 0, ex), true));
    const tr = Vehicles.build(w, engineByName('Kirby Paul Tank (Steam)').id, 0);
    const coach = w.buyable('rail', 0).find(e => e.wagon && w.cargo(e.cargo).key === 'passengers');
    for (let i = 0; i < 2; i++) Vehicles.addWagon(w, tr, coach.id);
    tr.orders = [{ kind: 'station', dest: 0 }];
    tr.stopped = false;
    let up = null;
    for (let i = 0; i < 74 * 40 && !up; i++) {
        w.tick();
        const p = tr.parts[0];
        if (tr.state === 'run' && p && !p.hidden && p.x > 29.3 && p.x < 29.7) up = { grade: p.grade, dir: Math.cos(p.heading) };
    }
    assert.ok(up, 'the train reached the ramp');
    assert.ok(up.grade > 0 && up.dir > 0, 'climbing: nose up');
    // Reverse while moving: it brakes, stops, then heads back (-x) with the engine at the back.
    for (let i = 0; i < 20; i++) w.tick();
    assert.ok(tr.speed > 0, 'moving');
    assert.equal(tr.requestReverse(w), '');
    let stood = false;
    for (let i = 0; i < 74 * 10 && tr.reversing; i++) { w.tick(); if (tr.speed === 0) stood = true; }
    assert.ok(!tr.reversing && stood, 'stopped, then reversed');
    assert.ok(!World.ENGINE[tr.cars[0].engine].wagon, 'the engine ran round: it leads again');
    assert.ok(tr.cars.every(c => !c.flip), 'every car faces the way it goes');
    const back = Trains.stepPoint(w, tr.steps[0], tr.pos);
    assert.ok(Math.cos(back.heading) < 0, 'going back the way it came');
    assert.ok(Math.cos(tr.parts[0].heading) < 0, 'the engine faces that way too');
    // Wagons bought later go behind the last wagon, not in front of the engine.
    tr.state = 'depot';
    const coachesBefore = tr.cars.length;
    assert.equal(Vehicles.addWagon(w, tr, coach.id), null);
    assert.equal(tr.cars.length, coachesBefore + 1);
    assert.ok(!World.ENGINE[tr.cars[0].engine].wagon && World.ENGINE[tr.cars[tr.cars.length - 1].engine].wagon, 'engine first, new wagon last');
});

test('кнопка Turn around: автобус разворачивается на следующей клетке', () => {
    const w = flatWorld(), m = w.map;
    must(Commands.run(w, ex => Commands.buildLongRoad(w, Commands.roadDrag(m, { fx: 10.1, fy: 20.5 }, { fx: 40.9, fy: 20.5 }, 0), ex), true));
    must(Commands.run(w, ex => Commands.buildDepot(w, idx(w, 12, 21), 'road', Dir.NW, 0, ex), true));
    must(Commands.run(w, ex => Commands.buildRoad(w, idx(w, 12, 20), 2, ex), true));
    must(Commands.run(w, ex => Commands.buildRoadStop(w, idx(w, 38, 20), 0, false, ex), true));
    const bus = Vehicles.build(w, engineByName('MPS Regal Bus').id, 0);
    bus.orders = [{ kind: 'station', dest: 0 }];
    bus.stopped = false;
    for (let i = 0; i < 74 * 6; i++) w.tick();
    assert.equal(bus.state, 'run');
    const x0 = bus.x;
    bus.turnAround = true;
    for (let i = 0; i < 74 * 4; i++) w.tick();
    assert.ok(!bus.turnAround, 'turned');
    assert.ok(bus.x < x0 + 2, 'heading back');
});

test('первый поезд с 1900 года: локомотив и вагоны есть сразу, стареет он по своим датам TTD', () => {
    for (const startYear of [1900, 1941]) {
        const w = new World({ seed: 3, mapLog2: 6, climate: 1, startYear, towns: 0, industries: 0 }).createEmpty(1);
        const locos = w.buyable('rail', 0).filter(e => !e.wagon);
        assert.deepEqual(plain(locos.map(e => e.name)), ['Wills 2-8-0 (Steam)'], 'sub-tropical ' + startYear);
        assert.ok(w.buyable('rail', 0).some(e => e.wagon && w.cargo(e.cargo).key === 'passengers'), 'coaches too');
    }
    // 0 — TTD's own dates: nothing before 1944.
    const w = new World({ seed: 3, mapLog2: 6, climate: 1, startYear: 1941, towns: 0, industries: 0, firstTrainYear: 0 }).createEmpty(1);
    assert.equal(w.buyable('rail', 0).filter(e => !e.wagon).length, 0);
    // A 1900 game runs through the years and the engine is still there in 1930.
    const g = new World({ seed: 3, mapLog2: 6, climate: 1, startYear: 1900, towns: 0, industries: 0 }).createEmpty(1);
    for (let d = 0; d < 365 * 30; d += 30) { g.date += 30; g.updateEngines(false); }
    assert.ok(g.buyable('rail', 0).some(e => e.name === 'Wills 2-8-0 (Steam)'), 'not retired early');
});

test('протяжка дороги: любые две точки курсора дают путь без ошибок (в том числе внутри одной клетки)', () => {
    const w = flatWorld(), m = w.map;
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
    for (let i = 0; i < 3000; i++) {
        const a = { fx: 5 + rnd() * 20, fy: 5 + rnd() * 20 };
        const b = i % 3 === 0 ? { fx: Math.floor(a.fx) + rnd(), fy: Math.floor(a.fy) + rnd() } : { fx: 5 + rnd() * 20, fy: 5 + rnd() * 20 };
        const list = Commands.roadPath(m, a, b);
        assert.ok(list.length > 0 && list.every(q => q.bits > 0 && q.bits < 16), JSON.stringify([a, b]));
        Commands.buildLongRoad(w, list, false);
    }
    // Inside one tile, a drag across it builds both halves along the way it went.
    assert.equal(Commands.roadPath(m, { fx: 10.1, fy: 10.4 }, { fx: 10.9, fy: 10.6 })[0].bits, 5);
});
