// TTDRender3D.js — draws the TTD world in 3D and answers "what is under the pointer". It reads
// World (never changes it): terrain chunks (TTDTerrain3D), one merged mesh per chunk for
// everything built on the tiles (houses, industries, track, roads, stations, depots, bridges),
// trees and vehicles as thin instances (World3D.addInstances — one draw call per model), signal
// lights that follow the block state, and overlay marks (tile cursor, drag area, catchment).
//
// Chunks rebuild when the map marks them dirty (GameMap.markDirty); vehicles are re-placed
// every frame from Vehicle.parts (tile units -> world px).

class TTDRender3D {
    /** @param {View3D} view @param {World} world */
    constructor(view, world) {
        this.view = view;
        this.scene = view.scene;
        this.world = world;
        this.map = world.map;
        Models.init();
        this.T = Models.T;
        this.L = Models.L;
        this.terrain = new TTDTerrain3D(view, this.map);
        this.terrain.groundCell = (t) => this.groundCell(t);
        this.terrain.foundationOf = (t) => this.foundationOf(t);
        const mat = new BABYLON.StandardMaterial('ttdContent', this.scene);
        mat.metadata = { toonGroup: 'prop' };
        mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
        World3D.applyMaterialConstants(mat);
        this.material = mat;
        const vmat = new BABYLON.StandardMaterial('ttdVehicles', this.scene);
        vmat.metadata = { toonGroup: 'actor' };
        vmat.diffuseColor = new BABYLON.Color3(1, 1, 1);
        World3D.applyMaterialConstants(vmat);
        this.vehicleMaterial = vmat;
        const n = this.map.chunksX * this.map.chunksY;
        /** @type {(BABYLON.Mesh | null)[]} */
        this.content = new Array(n).fill(null);
        this.chunkTrees = new Array(n).fill(null);
        this.chunkSignals = new Array(n).fill(null);
        this.treeGroups = new Map();
        this.treesDirty = true;
        this.vehicleGroups = new Map();
        this.signalGroups = null;
        this._sigTimer = 0;
        /** Called when a steam engine puffs: (vehicle, kind, x, y) in world px — the game chuffs. */
        /** @type {((v: any, kind: string, x: number, y: number) => void) | null} */
        this.onPuff = null;
        /** Wagon load bars (loadBars()): two instance groups and this frame's copies. */
        /** @type {{ bg: any, fill: any, bgItems: any[], fillItems: any[] } | null} */
        this.bars = null;
        this.overlays = [];
        this._buildOverlayMaterials();
        this.cursor = this._makeCursor();
        this.selectMark = this._makeRing();
        this.areaMesh = null;
    }

    // --- Coordinates ----------------------------------------------------------------------

    /** Tile-space point (x, y, z levels) -> world px position. */
    toWorld(x, y, z) { return new BABYLON.Vector3(x * this.T, z * this.L, y * this.T); }

    /** Ground point under the pointer in tile units, or null. */
    pick(px, py) {
        const hit = this.view.pointerToGround(px, py, 0, this.terrain);
        if (!hit) return null;
        const fx = hit.x / this.T, fy = hit.y / this.T;
        if (fx < 0 || fy < 0 || fx >= this.map.W || fy >= this.map.H) return null;
        return { fx, fy, tx: Math.floor(fx), ty: Math.floor(fy), t: Math.floor(fy) * this.map.W + Math.floor(fx) };
    }

    /** The vehicle nearest to the pointer on screen (within 28 px), or null. */
    pickVehicle(px, py) {
        let best = null, bd = 28 * 28;
        this.view.refreshMatrices();
        for (const v of this.world.vehicles) {
            if (!v || !v.parts) continue;
            for (const p of v.parts) {
                if (p.hidden) continue;
                const s = this.view.projectToScreen(p.x * this.T, p.y * this.T, p.z * this.L + this.T * 0.12);
                if (!s.visible) continue;
                const d = (s.x - px) ** 2 + (s.y - py) ** 2;
                if (d < bd) { bd = d; best = v; }
            }
        }
        return best;
    }

    // --- Ground under built things --------------------------------------------------------

    groundCell(t) {
        const m = this.map, A = TTDTerrain3D.A, k = m.type[t];
        const desert = m.ground[t] === GameMap.G_DESERT || m.zone[t] === GameMap.Z_DESERT;
        switch (k) {
            case GameMap.T_RAIL: case GameMap.T_ROAD: case GameMap.T_TUNBRIDGE:
                if (m.sub[t] === GameMap.RAIL_SUB_DEPOT && k === GameMap.T_RAIL) return A.PAVED;
                if (k === GameMap.T_ROAD && m.sub[t] === GameMap.ROAD_SUB_DEPOT) return A.PAVED;
                if (k === GameMap.T_ROAD && !desert) {
                    const rs = m.roadside(t);
                    if (rs === GameMap.RS_BARREN) return A.DIRT;
                    if (rs === GameMap.RS_PAVED || rs === GameMap.RS_LIGHTS) return A.PAVED;
                }
                return desert ? A.DESERT : m.zone[t] === GameMap.Z_RAINFOREST ? A.RAINFOREST : A.GRASS;
            case GameMap.T_STATION:
                return m.sub[t] === GameMap.ST_AIRPORT ? A.GRASS : m.sub[t] === GameMap.ST_DOCK ? A.PAVED : A.CONCRETE;
            case GameMap.T_HOUSE: {
                const h = TTDData.HOUSES[m.sub[t]];
                return h.pop > 60 ? A.PAVED : desert ? A.DESERT_DARK : A.GRASS_DARK;
            }
            case GameMap.T_INDUSTRY: {
                const ind = this.world.industries[m.obj[t]];
                if (!ind) return A.DIRT;
                const id = ind.type;
                if (id === 3 || id === 19 || id === 20) return m.zone[t] === GameMap.Z_RAINFOREST ? A.RAINFOREST : A.GRASS_DARK;
                if (id === 9 || id === 24) return A.FIELDS;
                return [0, 10, 15, 17, 18].includes(id) ? A.DIRT : A.CONCRETE;
            }
            case GameMap.T_OBJECT: return A.PAVED;
        }
        return -1;
    }

    /**
     * Foundation under built things on slopes: the heights (levels) of its top's corners
     * [N, W, S, E] — all equal for a levelled one, an incline for a road on an inclined
     * foundation — or null: nothing, or the thing lies on the natural ground.
     */
    foundationOf(t) {
        const m = this.map;
        if (m.type[t] === GameMap.T_ROAD && m.sub[t] === 0) return m.roadTop(t);
        if (m.type[t] === GameMap.T_RAIL && m.sub[t] === 0) return m.railTop(t);
        const z = this.levelFoundation(t);
        return z < 0 ? null : [z, z, z, z];
    }

    /** Levelled foundation top (levels) under built things other than plain road, -1 — none. */
    levelFoundation(t) {
        const m = this.map, k = m.type[t];
        if (k === GameMap.T_CLEAR || k === GameMap.T_TREES || k === GameMap.T_WATER || k === GameMap.T_TUNBRIDGE) return -1;
        if (k === GameMap.T_INDUSTRY) {
            const ind = this.world.industries[m.obj[t]];
            const z = ind ? Industries.baseZ(this.world, ind) : m.buildZ(t);
            return (m.isFlat(t) && m.tileMinZ(t) === z) ? -1 : z;
        }
        if (m.isFlat(t)) return -1;
        const incl = m.inclineAxis(t);
        if (k === GameMap.T_STATION && (m.sub[t] === GameMap.ST_BUS || m.sub[t] === GameMap.ST_TRUCK) && incl >= 0) return -1;
        if (k === GameMap.T_STATION && m.sub[t] === GameMap.ST_DOCK) return -1;
        return m.buildZ(t);
    }

    /** Height (levels) of the built surface at tile-local (u, v). */
    surfaceZ(t, u, v) {
        const m = this.map;
        if (m.type[t] === GameMap.T_TUNBRIDGE) {
            const inner = m.density[t], axis = Dir.axis(inner);
            const outer = Dir.reverse(inner);
            const zo = m.pieceEdgeZ(t, outer, axis), zi = m.wz[t];
            const mi = Track.MID[inner], mo = Track.MID[outer];
            const f = axis === 0 ? (u - mo[0]) / (mi[0] - mo[0]) : (v - mo[1]) / (mi[1] - mo[1]);
            return zo + (zi - zo) * IMath.clamp(f, 0, 1);
        }
        const f = this.foundationOf(t);
        if (f) return f[0] * (1 - u) * (1 - v) + f[1] * u * (1 - v) + f[2] * u * v + f[3] * (1 - u) * v;
        if (m.isFlat(t)) return m.tileMinZ(t);
        return m.groundZ(m.tx(t) + u, m.ty(t) + v);
    }

    // --- Frame -----------------------------------------------------------------------------------

    /** Rebuild what changed; place vehicles. budget — chunks per frame (0 — all). */
    update(dt, budget, alpha) {
        const m = this.map;
        if (m.dirty.size) {
            let n = 0;
            for (const k of [...m.dirty]) {
                this.terrain.buildChunk(k);
                this.buildContent(k);
                m.dirty.delete(k);
                if (budget && ++n >= budget) break;
            }
        }
        if (this.treesDirty) this.rebuildTrees();
        this.updateVehicles(alpha == null ? 1 : alpha);
        this.updateEffects(dt);
        this._sigTimer -= dt;
        if (this._sigTimer <= 0) { this._sigTimer = 0.2; this.updateSignals(); }
    }

    buildContent(k) {
        const m = this.map, N = m.chunk;
        const cx = k % m.chunksX, cy = (k / m.chunksX) | 0;
        const x0 = cx * N, y0 = cy * N, x1 = Math.min(m.W, x0 + N), y1 = Math.min(m.H, y0 + N);
        const b = new MeshData();
        const trees = [], signals = [];
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this._tileContent(b, y * m.W + x, trees, signals);
        const old = this.content[k];
        if (old) World3D.removeObject(this.view, old);
        this.content[k] = null;
        if (!b.empty) {
            const mesh = b.toMesh('ttdContent' + k, this.scene);
            mesh.material = this.material;
            mesh.isPickable = false;
            World3D.addObject(this.view, mesh, 'prop', { ink: false });
            mesh.freezeWorldMatrix();
            this.content[k] = mesh;
        }
        this.chunkTrees[k] = trees;
        this.chunkSignals[k] = signals;
        this.treesDirty = true;
        this._sigTimer = 0;
    }

    _tileContent(b, t, trees, signals) {
        const m = this.map, w = this.world, T = this.T, L = this.L;
        const x = m.tx(t), y = m.ty(t), ox = x * T, oy = y * T;
        const k = m.type[t];
        const zAt = (u, v) => this.surfaceZ(t, u, v) * L;
        switch (k) {
            case GameMap.T_TREES: {
                const n = m.treeCount[t];
                for (let i = 0; i < n; i++) {
                    const hx = Models.hash(t, i), hy = Models.hash(i + 7, t);
                    const fx = x + 0.2 + 0.6 * hx, fy = y + 0.2 + 0.6 * hy;
                    trees.push({ kind: m.treeType[t], x: fx * T, y: fy * T, h: m.groundZ(fx, fy) * L, heading: hx * 6.28, scale: 0.8 + 0.4 * hy });
                }
                return;
            }
            case GameMap.T_RAIL: {
                if (m.sub[t] === GameMap.RAIL_SUB_DEPOT) {
                    const d = w.depots[m.obj[t]];
                    const z = this.surfaceZ(t, 0.5, 0.5) * L;
                    if (d) {
                        Models.railPiece(b, Track.axisTrack(Dir.axis(d.dir)), ox, oy, zAt, m.railType[t]);
                        Models.depot(b, d.dir, ox, oy, z, 'rail');
                    }
                    return;
                }
                for (let tr = 0; tr < 6; tr++) {
                    if (!(m.rail[t] & (1 << tr))) continue;
                    const E = Track.EDGES[tr];
                    Models.railPiece(b, tr, ox, oy, zAt, m.railType[t], undefined, tr >= 2 ? Track.curve(m, t, E[0], E[1], 'rail') : null);
                }
                this._signalsOf(b, t, zAt, signals);
                return;
            }
            case GameMap.T_ROAD: {
                if (m.sub[t] === GameMap.ROAD_SUB_DEPOT) {
                    const d = w.depots[m.obj[t]];
                    if (d) {
                        Models.roadTile(b, m.road[t], ox, oy, zAt, GameMap.RS_GRASS, false);
                        Models.depot(b, d.dir, ox, oy, this.surfaceZ(t, 0.5, 0.5) * L, 'road');
                    }
                    return;
                }
                const rs = m.roadside(t), bits = m.road[t];
                let curve = null;
                if (m.sub[t] === 0 && (bits === 3 || bits === 6 || bits === 12 || bits === 9)) {
                    // A turn: the two edges it joins (NE|SE, SE|SW, SW|NW, NW|NE).
                    const e1 = bits === 9 ? 3 : Math.log2(bits & -bits), e2 = bits === 9 ? 0 : e1 + 1;
                    curve = Track.curve(m, t, e1, e2, 'road');
                }
                Models.roadTile(b, bits, ox, oy, zAt, rs, m.roadWorks(t) > 0, curve);
                if (rs === GameMap.RS_TREES && m.sub[t] === 0) {
                    // Roadside trees: small ones in the verges beside the road.
                    const bits = m.road[t];
                    const spots = bits === GameMap.ROAD_X ? [[0.3, 0.1], [0.75, 0.9]] : bits === GameMap.ROAD_Y ? [[0.1, 0.3], [0.9, 0.75]] : [[0.1, 0.1], [0.9, 0.9]];
                    for (const [u, v] of spots) trees.push({ kind: GameMap.TREE_DECIDUOUS, x: (x + u) * T, y: (y + v) * T, h: this.surfaceZ(t, u, v) * L, heading: u * 5, scale: 0.45 });
                }
                if (m.sub[t] === GameMap.ROAD_SUB_CROSSING) {
                    for (let tr = 0; tr < 2; tr++) if (m.rail[t] & (1 << tr)) Models.railPiece(b, tr, ox, oy, (u, v) => zAt(u, v) + 0.6, m.railType[t]);
                }
                return;
            }
            case GameMap.T_HOUSE: {
                const z = this.surfaceZ(t, 0.5, 0.5) * L;
                Models.house(b, m.sub[t], ox, oy, z, x * 31 + y, m.density[t]);
                return;
            }
            case GameMap.T_INDUSTRY: {
                const ind = w.industries[m.obj[t]];
                if (!ind || ind.tiles[0] !== t) return;
                const z = Industries.baseZ(w, ind) * L;
                Models.industry(b, ind.type, ind.w, ind.h, m.tx(ind.xy) * T, m.ty(ind.xy) * T, z, ind.id);
                return;
            }
            case GameMap.T_STATION: {
                const st = w.stations[m.obj[t]];
                const kind = m.sub[t];
                const z = this.surfaceZ(t, 0.5, 0.5) * L;
                if (kind === GameMap.ST_RAIL) {
                    const tr = m.rail[t] & 1 ? 0 : 1;
                    Models.railPiece(b, tr, ox, oy, zAt, m.railType[t], 'station');
                    Models.platform(b, tr, ox, oy, z, (x + y) % 2 === 0);
                } else if (kind === GameMap.ST_BUS || kind === GameMap.ST_TRUCK) {
                    Models.roadTile(b, m.road[t], ox, oy, zAt, GameMap.RS_GRASS, false);
                    Models.roadStop(b, m.road[t] === 5 ? 0 : 1, kind === GameMap.ST_TRUCK, ox, oy, z);
                } else if (kind === GameMap.ST_AIRPORT) {
                    if (st && st.airport && st.airport.t === t) Models.airport(b, st.airport.type, ox, oy, z);
                } else if (kind === GameMap.ST_DOCK) {
                    Models.dock(b, m.density[t], ox, oy, m.tileMinZ(t) * L);
                }
                return;
            }
            case GameMap.T_TUNBRIDGE: {
                const wh = w.wormholes[m.obj[t]];
                if (!wh) return;
                if (m.rail[t]) Models.railPiece(b, m.rail[t] & 1 ? 0 : 1, ox, oy, zAt, m.railType[t]);
                else Models.roadTile(b, m.road[t], ox, oy, zAt, GameMap.RS_GRASS, false);
                if (wh.kind === 'bridge' && wh.a === t) {
                    Models.bridge(b, wh, m, wh.type);
                    // Track or road on the deck.
                    const n = IMath.manhattan(m.tx(wh.a), m.ty(wh.a), m.tx(wh.b), m.ty(wh.b));
                    for (let i = 1; i < n; i++) {
                        const bx = (m.tx(wh.a) + Dir.DX[wh.dir] * i) * T, by = (m.ty(wh.a) + Dir.DY[wh.dir] * i) * T;
                        const dz = () => wh.z * L + 1;
                        if (wh.rail) Models.railPiece(b, Track.axisTrack(Dir.axis(wh.dir)), bx, by, dz, m.railType[t]);
                        else Models.roadTile(b, Dir.axis(wh.dir) === 0 ? 5 : 10, bx, by, dz, GameMap.RS_GRASS, false);
                    }
                }
                if (wh.kind === 'tunnel') Models.tunnelPortal(b, m.density[t], ox, oy, m.pieceEdgeZ(t, Dir.reverse(m.density[t]), Dir.axis(m.density[t])) * L);
                return;
            }
            case GameMap.T_OBJECT:
                Models.companyStatue(b, ox, oy, this.surfaceZ(t, 0.5, 0.5) * L);
                return;
            case GameMap.T_WATER:
                if (m.sub[t] === GameMap.WATER_SUB_DEPOT) {
                    const d = w.depots[m.obj[t]];
                    if (d) Models.depot(b, d.dir, ox, oy, TTDTerrain3D.cfg().water * L, 'ship');
                }
                return;
        }
    }

    _signalsOf(b, t, zAt, signals) {
        const m = this.map, sig = m.signals[t], T = this.T;
        if (!sig) return;
        for (let tr = 0; tr < 6; tr++) {
            for (let rev = 0; rev < 2; rev++) {
                if (!((sig >> (tr * 2 + rev)) & 1)) continue;
                const e = Track.EDGES[tr];
                const from = Track.MID[rev ? e[1] : e[0]], to = Track.MID[rev ? e[0] : e[1]];
                const dx = to[0] - from[0], dy = to[1] - from[1], l = Math.hypot(dx, dy);
                const ux = dx / l, uy = dy / l;
                const px = from[0] + ux * 0.15 - uy * 0.3, py = from[1] + uy * 0.15 + ux * 0.3;
                const z = zAt(px, py);
                const wx = m.tx(t) * T + px * T, wy = m.ty(t) * T + py * T;
                b.box(-1, 0, -1, 1, T * 0.3, 1, Models.C('#404040'), { ox: wx, oz: wy, oy: z });
                signals.push({ t, td: tr * 2 + rev, x: wx, y: wy, h: z + T * 0.3 });
            }
        }
    }

    // --- Trees -------------------------------------------------------------------------------------

    rebuildTrees() {
        this.treesDirty = false;
        const by = new Map();
        for (const list of this.chunkTrees) if (list) for (const it of list) {
            if (!by.has(it.kind)) by.set(it.kind, []);
            by.get(it.kind).push(it);
        }
        for (const kind of [0, 1, 2, 3, 4]) {
            const items = by.get(kind) || [];
            let g = this.treeGroups.get(kind);
            if (!g && items.length) {
                const mesh = Models.tree(kind).toMesh('ttdTree' + kind, this.scene);
                mesh.material = this.material;
                mesh.isPickable = false;
                g = World3D.addInstances(this.view, mesh, 'prop', items, { ink: false });
                this.treeGroups.set(kind, g);
                continue;
            }
            if (g) g.setAll(items);
        }
    }

    // --- Signals -------------------------------------------------------------------------------------

    updateSignals() {
        if (!this.signalGroups) {
            const make = (name, col) => {
                const b = new MeshData();
                b.box(-2.4, -2.4, -2.4, 2.4, 2.4, 2.4, Models.C(col));
                const mesh = b.toMesh(name, this.scene);
                const mat = new BABYLON.StandardMaterial(name + 'Mat', this.scene);
                mat.disableLighting = true;
                mat.emissiveColor = BABYLON.Color3.FromHexString(col);
                mesh.material = mat;
                mesh.isPickable = false;
                return World3D.addInstances(this.view, mesh, 'prop', [], { ink: false, outline: false, castShadow: false });
            };
            this.signalGroups = { red: make('ttdSigRed', '#ff3020'), green: make('ttdSigGreen', '#30ff50') };
        }
        const red = [], green = [];
        for (const list of this.chunkSignals) if (list) for (const s of list) {
            const isRed = Trains.blockOccupied(this.world, s.t, s.td, null);
            (isRed ? red : green).push({ x: s.x, y: s.y, h: s.h });
        }
        this.signalGroups.red.setAll(red);
        this.signalGroups.green.setAll(green);
    }

    // --- Vehicles --------------------------------------------------------------------------------------

    vehicleGroup(world, car) {
        const e = World.ENGINE[car.engine];
        const key = car.engine + '|' + car.slot;
        let g = this.vehicleGroups.get(key);
        if (g) return g;
        const kind = Models.vehicleKind(world, e, car);
        const cargo = car.slot >= 0 && world.cargo(car.slot) ? Models.C(world.cargo(car.slot).color) : null;
        const mesh = Models.vehicle(kind, cargo, Models.C(world.player ? world.player.color : '#1d4f9a')).toMesh('ttdVeh' + key, this.scene);
        mesh.material = this.vehicleMaterial;
        mesh.isPickable = false;
        g = { inst: World3D.addInstances(this.view, mesh, 'actor', [], { dynamic: true }), items: [] };
        this.vehicleGroups.set(key, g);
        return g;
    }

    /** Place every visible car; alpha 0..1 — between the previous tick's and the current position. */
    updateVehicles(alpha) {
        const w = this.world, T = this.T, L = this.L;
        for (const g of this.vehicleGroups.values()) g.items.length = 0;
        const bars = (typeof TTD_LOAD_BARS !== 'undefined' ? TTD_LOAD_BARS : 1) ? this.loadBars() : null;
        if (bars) { bars.bgItems.length = 0; bars.fillItems.length = 0; }
        const tmp = { x: 0, y: 0, z: 0, heading: 0, grade: 0 };
        for (const v of w.vehicles) {
            if (!v || v.state === 'depot' || !v.parts) continue;
            for (let i = 0; i < v.cars.length && i < v.parts.length; i++) {
                let p = v.parts[i];
                if (p.hidden) continue;
                const q = v._prev && v._prev[i];
                if (q && !q.hidden && alpha < 1 && Math.abs(q.x - p.x) + Math.abs(q.y - p.y) < 1.5) {
                    let dh = p.heading - q.heading;
                    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
                    tmp.x = q.x + (p.x - q.x) * alpha; tmp.y = q.y + (p.y - q.y) * alpha; tmp.z = q.z + (p.z - q.z) * alpha;
                    tmp.heading = q.heading + dh * alpha; tmp.grade = p.grade;
                    p = tmp;
                }
                const car = v.cars[i];
                if (v.type === 'air' && i > 0) continue;   // the mail compartment is the same aircraft
                const g = this.vehicleGroup(w, car);
                const lift = v.type === 'ship' ? 0 : 0.5;
                g.items.push({
                    x: p.x * T, y: p.y * T, h: p.z * L + lift, heading: p.heading,
                    pitch: Math.atan2((p.grade || 0) * L, T) * (v.type === 'air' ? 1 : 1),
                    scale: v.state === 'crashed' ? [1, 0.6, 1] : 1,
                });
                if (bars && v.type === 'train' && car.cap > 0 && v.state !== 'crashed') {
                    // Load bar over the wagon: a dark track, filled from the back as it loads.
                    const f = Math.max(0, Math.min(1, v.cargoCount(car) / car.cap));
                    const len = T * 0.38, top = p.z * L + lift + T * 0.36, cx = Math.cos(p.heading), cy = Math.sin(p.heading);
                    bars.bgItems.push({ x: p.x * T, y: p.y * T, h: top, heading: p.heading, scale: [len + 1.5, 3.5, 7] });
                    if (f > 0) {
                        const off = -(1 - f) * len / 2;
                        bars.fillItems.push({ x: p.x * T + cx * off, y: p.y * T + cy * off, h: top + 0.4, heading: p.heading, scale: [len * f, 3.5, 7.6] });
                    }
                }
            }
        }
        for (const g of this.vehicleGroups.values()) g.inst.setAll(g.items);
        if (this.bars) {
            this.bars.bg.setAll(bars ? this.bars.bgItems : []);
            this.bars.fill.setAll(bars ? this.bars.fillItems : []);
        }
    }

    /**
     * The two instance groups of the wagon load bars (a unit box scaled per copy), made once.
     * They draw over everything (no depth test) so platform roofs never hide them; the fill is in
     * a later layer than its track so it always lands on top.
     */
    loadBars() {
        if (!this.bars) {
            const make = (name, col, layer) => {
                const b = new MeshData();
                b.box(-0.5, 0, -0.5, 0.5, 1, 0.5, Models.C(col));
                const mesh = b.toMesh(name, this.scene);
                const mat = new BABYLON.StandardMaterial(name + 'Mat', this.scene);
                mat.disableLighting = true;
                mat.emissiveColor = BABYLON.Color3.FromHexString(col);
                mesh.material = mat;
                mesh.isPickable = false;
                const inst = World3D.addInstances(this.view, mesh, 'prop', [], { ink: false, outline: false, castShadow: false, dynamic: true });
                mat.depthFunction = BABYLON.Constants.ALWAYS;
                mat.disableDepthWrite = true;
                for (const part of inst.parts) { part.renderingGroupId = layer; part.receiveShadows = false; }
                return inst;
            };
            this.bars = { bg: make('ttdLoadBg', '#3a3e46', World3D.LAYER.OVERLAY), fill: make('ttdLoadFill', '#58e060', World3D.LAYER.ACTOR), bgItems: [], fillItems: [] };
        }
        return this.bars;
    }

    // --- Steam, smoke and sparks (TTD's effect vehicles) --------------------------------------------------

    /**
     * Puffs rise from vehicles: white steam from steam engines (one per TTD_STEAM_PUFF_TILES
     * travelled, a wisp now and then while standing), dark smoke from diesels pulling away and from
     * broken-down or crashed vehicles, sparks at electric pantographs. Presentation only — kept
     * here, never in the world. onPuff(v, kind, x, y) lets the game chuff along.
     */
    updateEffects(dt) {
        const U = 'undefined';
        const on = typeof TTD_EFFECTS !== U ? TTD_EFFECTS : 1;
        const per = typeof TTD_STEAM_PUFF_TILES !== U ? TTD_STEAM_PUFF_TILES : 0.35;
        const life = typeof TTD_PUFF_LIFE !== U ? TTD_PUFF_LIFE : 1.8;
        const T = this.T, L = this.L, w = this.world;
        if (!this.fx) {
            const make = (name, col, emissive) => {
                const b = new MeshData();
                Models.puff(b, Models.C(col));
                const mesh = b.toMesh(name, this.scene);
                const mat = new BABYLON.StandardMaterial(name + 'Mat', this.scene);
                mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
                if (emissive) { mat.disableLighting = true; mat.emissiveColor = BABYLON.Color3.FromHexString(col); }
                else mat.emissiveColor = new BABYLON.Color3(0.35, 0.35, 0.35);
                mesh.material = mat;
                mesh.isPickable = false;
                return World3D.addInstances(this.view, mesh, 'prop', [], { ink: false, outline: false, castShadow: false, dynamic: true });
            };
            this.fx = { steam: make('ttdSteam', '#f4f4f0', false), smoke: make('ttdSmoke', '#4a4a4c', false), spark: make('ttdSpark', '#fff4a0', true) };
            this.puffs = [];
            this.fxState = new Map();
        }
        dt = Math.min(dt, 0.1);
        const spawn = (kind, x, y, h, size, up) => {
            if (this.puffs.length > 600) return;
            this.puffs.push({ kind, x, y, h, vx: (Math.random() - 0.5) * 6 + 5, vy: (Math.random() - 0.5) * 6 - 3, vh: up, age: 0, life: kind === 'spark' ? 0.12 : life * (0.8 + Math.random() * 0.4), size });
        };
        if (on) {
            for (const v of w.vehicles) {
                if (!v || v.state === 'depot' || !v.parts || !v.parts.length) continue;
                const p0 = v.parts[0];
                if (!p0 || p0.hidden) continue;
                let st = this.fxState.get(v.id);
                if (!st) { st = { x: p0.x, y: p0.y, acc: 0, idle: Math.random() * 2, sp: 0 }; this.fxState.set(v.id, st); }
                const moved = Math.min(2, Math.hypot(p0.x - st.x, p0.y - st.y));
                st.x = p0.x; st.y = p0.y;
                if (v.state === 'crashed' || v.broken > 0) {
                    st.acc += dt * (v.state === 'crashed' ? 6 : 3);
                    for (let n = 0; st.acc >= 1 && n < 3; n++) { st.acc -= 1; spawn('smoke', p0.x * T, p0.y * T, p0.z * L + T * 0.25, T * 0.07, T * 0.5); }
                    continue;
                }
                if (v.type !== 'train') continue;
                // The engine: the first car with an engine (after a reversal it may be the last).
                let ei = -1;
                for (let i = 0; i < v.cars.length; i++) if (!World.ENGINE[v.cars[i].engine].wagon) { ei = i; break; }
                const p = v.parts[ei];
                if (ei < 0 || !p || p.hidden) continue;
                const kind = Models.vehicleKind(w, World.ENGINE[v.cars[ei].engine], v.cars[ei]);
                const fx = p.x * T + Math.cos(p.heading) * T * 0.16, fy = p.y * T + Math.sin(p.heading) * T * 0.16;
                const top = p.z * L + 0.5 + T * 0.3;
                if (kind === 'steam') {
                    st.acc += moved / per + (moved < 1e-4 ? dt * 0.35 : 0);
                    for (let n = 0; st.acc >= 1 && n < 3; n++) {
                        st.acc -= 1;
                        spawn('steam', fx, fy, top, T * 0.085, T * (0.45 + Math.min(1, v.speed / 80) * 0.4));
                        if (this.onPuff && moved > 1e-4) this.onPuff(v, 'steam', fx, fy);
                    }
                } else if (kind === 'diesel' || kind === 'dmu') {
                    // Smoke while pulling away (speed rising and still low).
                    if (v.speed > st.sp && v.speed < 60) {
                        st.acc += dt * 5;
                        for (let n = 0; st.acc >= 1 && n < 2; n++) { st.acc -= 1; spawn('smoke', p.x * T, p.y * T, p.z * L + T * 0.26, T * 0.04, T * 0.35); }
                    }
                } else if (kind === 'electric' && moved > 1e-3 && Math.random() < dt * 1.5) {
                    spawn('spark', p.x * T, p.y * T, p.z * L + T * 0.36, T * 0.05, 0);
                }
                st.sp = v.speed;
            }
            if (this.fxState.size > w.vehicles.length * 2 + 50) {
                for (const id of [...this.fxState.keys()]) if (!w.vehicles[id]) this.fxState.delete(id);
            }
        }
        const items = { steam: [], smoke: [], spark: [] };
        const keep = [];
        for (const q of this.puffs) {
            q.age += dt;
            if (q.age >= q.life) continue;
            q.x += q.vx * dt; q.y += q.vy * dt; q.h += q.vh * dt;
            q.vh *= 1 - dt * 0.6;
            const f = q.age / q.life;
            // Grows as it rises, shrinks away at the end.
            const s = q.kind === 'spark' ? q.size : q.size * (1 + f * 2.6) * (f > 0.75 ? (1 - f) / 0.25 : 1);
            items[q.kind].push({ x: q.x, y: q.y, h: q.h, heading: q.age * 0.7, scale: s });
            keep.push(q);
        }
        this.puffs = keep;
        this.fx.steam.setAll(items.steam);
        this.fx.smoke.setAll(items.smoke);
        this.fx.spark.setAll(items.spark);
    }

    // --- Overlays ---------------------------------------------------------------------------------------

    _buildOverlayMaterials() {
        const mk = (name, hex, alpha) => {
            const m = new BABYLON.StandardMaterial(name, this.scene);
            m.disableLighting = true;
            m.emissiveColor = BABYLON.Color3.FromHexString(hex);
            m.diffuseColor = new BABYLON.Color3(0, 0, 0);
            m.alpha = alpha;
            m.depthFunction = BABYLON.Constants.ALWAYS;
            m.disableDepthWrite = true;
            m.backFaceCulling = false;
            return m;
        };
        this.overlayMats = {
            ok: mk('ttdCursorOk', '#ffffff', 0.9),
            bad: mk('ttdCursorBad', '#ff4030', 0.9),
            area: mk('ttdArea', '#60c0ff', 0.28),
            sel: mk('ttdSel', '#ffe040', 0.95),
        };
    }

    /** A square outline (four thin quads) — resized by setCursor. */
    _makeCursor() {
        const mesh = new BABYLON.Mesh('ttdCursor', this.scene);
        mesh.renderingGroupId = World3D.LAYER.OVERLAY;
        mesh.isPickable = false;
        mesh.material = this.overlayMats.ok;
        mesh.setEnabled(false);
        return mesh;
    }

    _makeRing() {
        const b = new MeshData();
        const n = 20, r0 = this.T * 0.36, r1 = this.T * 0.42;
        for (let i = 0; i < n; i++) {
            const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
            b.quad([[Math.cos(a0) * r0, 0, Math.sin(a0) * r0], [Math.cos(a1) * r0, 0, Math.sin(a1) * r0],
                [Math.cos(a1) * r1, 0, Math.sin(a1) * r1], [Math.cos(a0) * r1, 0, Math.sin(a0) * r1]], null, [1, 1, 1], [0, 1, 0]);
        }
        const mesh = b.toMesh('ttdSelRing', this.scene);
        mesh.renderingGroupId = World3D.LAYER.OVERLAY;
        mesh.material = this.overlayMats.sel;
        mesh.isPickable = false;
        mesh.setEnabled(false);
        return mesh;
    }

    /** Outline the tile rectangle [x0, y0] .. [x1, y1] (inclusive); ok — white, else red. null hides. */
    setCursor(rect, ok) {
        if (!rect) { this.cursor.setEnabled(false); return; }
        const [x0, y0, x1, y1] = rect, T = this.T, L = this.L, m = this.map;
        const b = new MeshData();
        const lw = 2.2;
        const edge = (ax, ay, bx, by) => {
            const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) * 2));
            for (let i = 0; i < steps; i++) {
                const f0 = i / steps, f1 = (i + 1) / steps;
                const px0 = ax + (bx - ax) * f0, py0 = ay + (by - ay) * f0, px1 = ax + (bx - ax) * f1, py1 = ay + (by - ay) * f1;
                const z0 = m.groundZ(Math.min(px0, m.W - 0.001), Math.min(py0, m.H - 0.001)) * L + 2, z1 = m.groundZ(Math.min(px1, m.W - 0.001), Math.min(py1, m.H - 0.001)) * L + 2;
                const nx = -(py1 - py0), ny = px1 - px0, nl = Math.hypot(nx, ny) || 1;
                const ox = nx / nl * lw, oy = ny / nl * lw;
                b.quad([[px0 * T - ox, z0, py0 * T - oy], [px1 * T - ox, z1, py1 * T - oy], [px1 * T + ox, z1, py1 * T + oy], [px0 * T + ox, z0, py0 * T + oy]], null, [1, 1, 1], [0, 1, 0]);
            }
        };
        edge(x0, y0, x1 + 1, y0); edge(x1 + 1, y0, x1 + 1, y1 + 1); edge(x1 + 1, y1 + 1, x0, y1 + 1); edge(x0, y1 + 1, x0, y0);
        const old = this.cursor;
        const mesh = b.toMesh('ttdCursor', this.scene);
        mesh.renderingGroupId = World3D.LAYER.OVERLAY;
        mesh.isPickable = false;
        mesh.material = ok === false ? this.overlayMats.bad : this.overlayMats.ok;
        this.cursor = mesh;
        old.dispose(false, false);
    }

    /** Tint a set of tiles (catchment area); null clears. */
    setArea(tiles) {
        if (this.areaMesh) { this.areaMesh.dispose(false, false); this.areaMesh = null; }
        if (!tiles || !tiles.length) return;
        const b = new MeshData(), T = this.T, L = this.L, m = this.map;
        for (const t of tiles) {
            const x = m.tx(t), y = m.ty(t), c = m.corners(t);
            b.quad([[x * T, c[0] * L + 1.5, y * T], [(x + 1) * T, c[1] * L + 1.5, y * T], [(x + 1) * T, c[2] * L + 1.5, (y + 1) * T], [x * T, c[3] * L + 1.5, (y + 1) * T]], null, [1, 1, 1], [0, 1, 0]);
        }
        const mesh = b.toMesh('ttdArea', this.scene);
        mesh.renderingGroupId = World3D.LAYER.OVERLAY;
        mesh.material = this.overlayMats.area;
        mesh.isPickable = false;
        this.areaMesh = mesh;
    }

    /** Ring under a selected vehicle (or null). */
    setSelected(v) {
        if (!v || v.state === 'depot' || !v.parts || !v.parts[0] || v.parts[0].hidden) { this.selectMark.setEnabled(false); return; }
        const p = v.parts[0];
        this.selectMark.setEnabled(true);
        this.selectMark.position.set(p.x * this.T, p.z * this.L + 1.5, p.y * this.T);
    }

    dispose() {
        this.terrain.dispose();
        for (const c of this.content) if (c) World3D.removeObject(this.view, c);
    }
}
