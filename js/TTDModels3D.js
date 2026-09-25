// TTDModels3D.js — procedural low-poly models of the TTD remake, built from boxes, roofs,
// cylinders and cones into MeshData (TTDTerrain3D.js) with vertex colours: trees, town buildings
// (by TTD house type), industries (by TTD industry type and footprint), track, road, stations,
// depots, bridges, tunnel portals and every vehicle class. No assets: TTD's sprites are replaced
// by geometry drawn in the kit's toon style.
//
// Units: world px. A tile is T = TTD_TILE px wide, a height level L = TTD_LEVEL px. Tile-local
// builders put the tile's north corner at (0, 0); x runs toward SW, z (map y) toward SE, y up.

/** @satisfies {Record<string, any>} */
const Models = {
    T: 64,
    L: 24,

    init() {
        const c = TTDTerrain3D.cfg();
        Models.T = c.tile;
        Models.L = c.level;
    },

    C(hex) {
        const n = typeof hex === 'string' ? parseInt(hex.slice(1), 16) : hex;
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    },

    shade(c, k) { return [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)]; },

    /** Deterministic 0..1 from integers (colour variety per tile / house). */
    hash(a, b) {
        let h = (a * 374761393 + b * 668265263) >>> 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    },

    // --- Trees -----------------------------------------------------------------------------

    /** A tree mesh standing at the origin (for instancing). kind: GameMap.TREE_*. */
    tree(kind) {
        const b = new MeshData(), T = Models.T, C = Models.C;
        const trunk = C('#6b4a2b');
        switch (kind) {
            case GameMap.TREE_CONIFER:
                b.cylinder(0, 0, T * 0.03, 0, T * 0.12, trunk, 5);
                b.cone(0, 0, T * 0.14, T * 0.1, T * 0.36, C('#2f6b35'), 6);
                b.cone(0, 0, T * 0.11, T * 0.26, T * 0.5, C('#3a7d3f'), 6);
                break;
            case GameMap.TREE_PALM:
                b.cylinder(0, 0, T * 0.025, 0, T * 0.34, C('#8a6a40'), 5, { rTop: T * 0.02 });
                for (let i = 0; i < 6; i++) {
                    const a = i / 6 * Math.PI * 2, r = T * 0.18;
                    b.tri([0, T * 0.36, 0], [Math.cos(a) * r, T * 0.27, Math.sin(a) * r], [Math.cos(a + 0.5) * r * 0.7, T * 0.3, Math.sin(a + 0.5) * r * 0.7], null, null, null, C('#4c9a3a'), [0, 1, 0]);
                }
                break;
            case GameMap.TREE_JUNGLE:
                b.cylinder(0, 0, T * 0.04, 0, T * 0.2, trunk, 5);
                b.cylinder(0, 0, T * 0.2, T * 0.16, T * 0.3, C('#2d7a2a'), 7, { rTop: T * 0.14 });
                b.cone(0, 0, T * 0.15, T * 0.3, T * 0.44, C('#379133'), 7);
                break;
            case GameMap.TREE_CACTUS:
                b.cylinder(0, 0, T * 0.035, 0, T * 0.22, C('#4f8a3c'), 6);
                b.box(T * 0.02, T * 0.1, -T * 0.015, T * 0.1, T * 0.13, T * 0.015, C('#4f8a3c'));
                b.cylinder(T * 0.09, 0, T * 0.02, T * 0.1, T * 0.18, C('#4f8a3c'), 5);
                break;
            default:   // deciduous
                b.cylinder(0, 0, T * 0.03, 0, T * 0.16, trunk, 5);
                b.cylinder(0, 0, T * 0.15, T * 0.12, T * 0.28, C('#4f9a3a'), 7, { rTop: T * 0.12 });
                b.cone(0, 0, T * 0.12, T * 0.28, T * 0.4, C('#5aa844'), 7);
        }
        return b;
    },

    // --- Buildings ----------------------------------------------------------------------------

    /**
     * A town building (TTD house part id) on a tile at local origin; parts other than the base
     * of a multi-tile building draw only pavement (the base draws the whole footprint).
     */
    house(b, id, ox, oy, oz, seed, stage) {
        const h = TTDData.HOUSES[id], T = Models.T, C = Models.C;
        const name = h.name, pop = h.pop;
        const r = Models.hash(id, seed);
        const walls = [C('#d8c7a4'), C('#c8a07a'), C('#e0d8c8'), C('#b8b0a8'), C('#d0b890'), C('#a88f78')][Math.floor(r * 6)];
        const roofs = [C('#9a3b2e'), C('#5a4a44'), C('#7a3a2a'), C('#3f4a5a')][Math.floor(r * 37) % 4];
        const size = Models.houseSize(id);
        if (size.part) return;   // drawn by the base tile
        const W = size.w * T, D = size.h * T;
        const o = { ox, oz: oy, oy: oz };
        if (stage < 3) {
            // Under construction: foundations and a scaffold.
            const k = (stage + 1) / 4;
            b.box(T * 0.15, 0, T * 0.15, W - T * 0.15, T * 0.08 + T * 0.3 * k, D - T * 0.15, C('#a07850'), o);
            b.box(T * 0.12, 0, T * 0.12, T * 0.16, T * 0.5 * k + T * 0.1, T * 0.16, C('#6a5030'), o);
            b.box(W - T * 0.16, 0, D - T * 0.16, W - T * 0.12, T * 0.5 * k + T * 0.1, D - T * 0.12, C('#6a5030'), o);
            return;
        }
        const glass = C('#5a7fa0');
        if (name === 'Church') {
            b.box(T * 0.2, 0, T * 0.25, T * 0.8, T * 0.35, T * 0.75, C('#c8c0b0'), o);
            b.roof(T * 0.2, T * 0.25, T * 0.8, T * 0.75, T * 0.35, T * 0.15, C('#6a5a50'), o);
            b.box(T * 0.08, 0, T * 0.4, T * 0.28, T * 0.6, T * 0.6, C('#c8c0b0'), o);
            b.cone(ox + T * 0.18, oy + T * 0.5, T * 0.11, oz + T * 0.6, oz + T * 0.95, C('#5a4a44'), 4);
            return;
        }
        if (name === 'Stadium') {
            const c = C('#b0b0b8');
            b.box(T * 0.1, 0, T * 0.1, W - T * 0.1, T * 0.22, D - T * 0.1, c, o);
            b.box(T * 0.3, T * 0.22, T * 0.3, W - T * 0.3, T * 0.225, D - T * 0.3, C('#4f9a3a'), o);
            for (const [x, z] of [[0.15, 0.15], [W / T - 0.15, 0.15], [0.15, D / T - 0.15], [W / T - 0.15, D / T - 0.15]]) {
                b.box(T * (x - 0.03), 0, T * (z - 0.03), T * (x + 0.03), T * 0.7, T * (z + 0.03), C('#707078'), o);
                b.box(T * (x - 0.08), T * 0.7, T * (z - 0.08), T * (x + 0.08), T * 0.78, T * (z + 0.08), C('#f0f0e0'), o);
            }
            return;
        }
        if (name === 'Statue') {
            b.box(T * 0.35, 0, T * 0.35, T * 0.65, T * 0.12, T * 0.65, C('#b0a898'), o);
            b.cylinder(ox + T * 0.5, oy + T * 0.5, T * 0.06, oz + T * 0.12, oz + T * 0.38, C('#7a8a6a'), 6);
            return;
        }
        if (name === 'Fountain') {
            b.cylinder(ox + T * 0.5, oy + T * 0.5, T * 0.28, oz, oz + T * 0.06, C('#b0a898'), 10);
            b.cylinder(ox + T * 0.5, oy + T * 0.5, T * 0.22, oz + T * 0.06, oz + T * 0.065, C('#5a9ad0'), 10);
            b.cylinder(ox + T * 0.5, oy + T * 0.5, T * 0.04, oz, oz + T * 0.22, C('#b0a898'), 6);
            return;
        }
        if (name === 'Park') {
            for (const [x, z] of [[0.3, 0.3], [0.7, 0.35], [0.45, 0.7]]) {
                b.cylinder(ox + T * x, oy + T * z, T * 0.02, oz, oz + T * 0.1, C('#6b4a2b'), 5);
                b.cone(ox + T * x, oy + T * z, T * 0.12, oz + T * 0.08, oz + T * 0.3, C('#4f9a3a'), 6);
            }
            return;
        }
        if (name === 'Tepees') {
            b.cone(ox + T * 0.35, oy + T * 0.4, T * 0.18, oz, oz + T * 0.4, C('#d8c8a0'), 6);
            b.cone(ox + T * 0.7, oy + T * 0.65, T * 0.15, oz, oz + T * 0.33, C('#c8a878'), 6);
            return;
        }
        // Heights from population: cottages 1 storey .. office towers.
        const floors = Math.max(1, Math.min(14, Math.round(pop / 22)));
        const tall = /office|Hotel|Flats|flats|Offices|mall|Shops/.test(name);
        const fh = T * 0.2;
        if (!tall || floors <= 2) {
            // Houses and cottages: 1–2 storeys with a gable roof, sometimes two on a tile.
            const two = pop < 20 && r > 0.4;
            const lots = two ? [[0.08, 0.1, 0.46, 0.55], [0.54, 0.42, 0.92, 0.9]] : [[0.18, 0.18, 0.82, 0.82]];
            for (const [x0, z0, x1, z1] of lots) {
                const hh = fh * (pop > 30 ? 2 : 1) + T * 0.05;
                const rot = r > 0.5;
                b.box(T * x0, 0, T * z0, T * x1, hh, T * z1, walls, o);
                b.roof(T * x0, T * z0, T * x1, T * z1, hh, T * 0.16, roofs, { ox, oz: oy, oy: oz, alongZ: rot });
                // Windows: a darker band.
                b.box(T * x0 - 0.5, hh * 0.45, T * (z0 + 0.1), T * x1 + 0.5, hh * 0.62, T * (z1 - 0.1), Models.shade(glass, 1), o);
            }
            return;
        }
        // Flats, offices, hotels: blocks with window bands.
        const height = floors * fh;
        const inset = T * 0.12;
        const body = /office|Offices/.test(name) ? [C('#9aa6b4'), C('#b8b8b0'), C('#8a9aa0'), C('#c0b8a8')][Math.floor(r * 4)] : walls;
        b.box(inset, 0, inset, W - inset, height, D - inset, body, o);
        for (let f = 0; f < floors; f++) {
            const y0 = f * fh + fh * 0.35, y1 = f * fh + fh * 0.7;
            b.box(inset - 0.6, y0, inset + T * 0.06, W - inset + 0.6, y1, D - inset - T * 0.06, glass, o);
            b.box(inset + T * 0.06, y0, inset - 0.6, W - inset - T * 0.06, y1, D - inset + 0.6, glass, o);
        }
        if (/Shops/.test(name)) b.box(inset - T * 0.05, fh * 0.9, inset - T * 0.05, W - inset + T * 0.05, fh * 1.0, D - inset + T * 0.05, C('#c04040'), o);
        if (h.extra & 32) b.box(W / 2 - T * 0.08, height, D / 2 - T * 0.08, W / 2 + T * 0.08, height + T * 0.12, D / 2 + T * 0.08, C('#707070'), o);
        else b.box(inset + T * 0.04, height, inset + T * 0.04, W - inset - T * 0.04, height + T * 0.03, D - inset - T * 0.04, Models.shade(body, 0.8), o);
    },

    /** Footprint of the building a house part belongs to; part — not the base tile. */
    houseSize(id) {
        const H = TTDData.HOUSES;
        const e = H[id].extra;
        if (e & 0x10) return { w: 2, h: 2, part: false };
        if (e & 0x04) return { w: 2, h: 1, part: false };
        if (e & 0x08) return { w: 1, h: 2, part: false };
        // A continuation part: its base is 1..3 ids before.
        for (let k = 1; k <= 3; k++) {
            const p = H[id - k];
            if (!p) break;
            if ((p.extra & 0x10) && k <= 3) return { w: 1, h: 1, part: true };
            if ((p.extra & 0x0c) && k === 1) return { w: 1, h: 1, part: true };
        }
        return { w: 1, h: 1, part: false };
    },

    // --- Industries ---------------------------------------------------------------------------

    /** Whole industry of type `type` over a w×h footprint, local origin = its north corner. */
    industry(b, type, w, h, ox, oy, oz, seed) {
        const T = Models.T, C = Models.C;
        const o = (dx, dz) => ({ ox: ox + (dx || 0), oz: oy + (dz || 0), oy: oz });
        const W = w * T, D = h * T;
        const shed = (x0, z0, x1, z1, hh, wall, roof) => {
            b.box(x0, 0, z0, x1, hh, z1, wall, o());
            b.roof(x0, z0, x1, z1, hh, T * 0.12, roof, o());
        };
        const chimney = (x, z, r, hh, col) => b.cylinder(ox + x, oy + z, r, oz, oz + hh, col || C('#8a6a5a'), 8);
        const tank = (x, z, r, hh, col) => { b.cylinder(ox + x, oy + z, r, oz, oz + hh, col, 10, { top: Models.shade(col, 1.1) }); };
        const heap = (x, z, r, hh, col) => b.cone(ox + x, oy + z, r, oz, oz + hh, col, 7);
        const headframe = (x, z, col) => {
            b.box(x - T * 0.12, 0, z - T * 0.04, x - T * 0.08, T * 0.8, z + T * 0.04, col, o());
            b.box(x + T * 0.08, 0, z - T * 0.04, x + T * 0.12, T * 0.8, z + T * 0.04, col, o());
            b.box(x - T * 0.16, T * 0.78, z - T * 0.06, x + T * 0.16, T * 0.84, z + T * 0.06, col, o());
            b.cylinder(ox + x, oy + z + T * 0.07, T * 0.12, oz + T * 0.72, oz + T * 0.74, C('#303030'), 10);
        };
        const pumpjack = (x, z) => {
            b.box(x - T * 0.06, 0, z - T * 0.06, x + T * 0.06, T * 0.18, z + T * 0.06, C('#404040'), o());
            b.box(x - T * 0.22, T * 0.18, z - T * 0.025, x + T * 0.22, T * 0.24, z + T * 0.025, C('#303030'), o());
            b.box(x + T * 0.18, T * 0.05, z - T * 0.04, x + T * 0.26, T * 0.26, z + T * 0.04, C('#303030'), o());
        };
        const rows = (col, crown) => {
            for (let i = 0; i < w * 2; i++) for (let j = 0; j < h * 2; j++) {
                const x = (i + 0.5) * T / 2, z = (j + 0.5) * T / 2;
                b.cylinder(ox + x, oy + z, T * 0.02, oz, oz + T * 0.12, C('#6b4a2b'), 4);
                b.cylinder(ox + x, oy + z, T * 0.1, oz + T * 0.1, oz + T * 0.22, crown, 6, { rTop: T * 0.06 });
                if (col) b.cylinder(ox + x + T * 0.04, oy + z, T * 0.025, oz + T * 0.18, oz + T * 0.22, col, 5);
            }
        };
        switch (type) {
            case 0: case 10: case 18: case 17: case 15: {   // mines: coal, copper, iron ore, diamond, gold
                const ore = { 0: C('#2a2a2a'), 10: C('#b8683a'), 18: C('#8a4a3a'), 17: C('#9aa8b0'), 15: C('#c8a040') }[type];
                shed(T * 0.1, T * 0.1, W * 0.55, D * 0.45, T * 0.3, C('#8a7a6a'), C('#5a5a5a'));
                headframe(W * 0.72, D * 0.3, C('#6a5a4a'));
                heap(W * 0.3, D * 0.75, T * 0.35, T * 0.35, ore);
                heap(W * 0.75, D * 0.78, T * 0.28, T * 0.25, ore);
                chimney(W * 0.2, D * 0.55, T * 0.05, T * 0.6);
                break;
            }
            case 1: {   // power station
                shed(T * 0.15, T * 0.15, W - T * 0.9, D - T * 0.15, T * 0.55, C('#b8a890'), C('#6a6a6a'));
                chimney(W - T * 0.55, D * 0.3, T * 0.1, T * 1.4, C('#9a8a7a'));
                chimney(W - T * 0.55, D * 0.7, T * 0.1, T * 1.4, C('#9a8a7a'));
                break;
            }
            case 2: case 25: {   // sawmill, lumber mill
                shed(T * 0.15, T * 0.15, W - T * 0.15, D * 0.55, T * 0.4, C('#a07a50'), C('#6a4a30'));
                for (let i = 0; i < 4; i++) b.box(T * 0.2, T * 0.05 * i, D * 0.65 + i * 2, W * 0.8, T * 0.05 * (i + 1), D * 0.65 + T * 0.2 + i * 2, C('#8a6038'), o());
                break;
            }
            case 3: {   // forest (trees are drawn as instances on top)
                b.box(W * 0.05, 0, D * 0.05, W * 0.25, T * 0.18, D * 0.2, C('#a07a50'), o());
                rows(null, C('#2f6b35'));
                break;
            }
            case 4: {   // oil refinery
                for (let i = 0; i < 3; i++) tank(T * (0.6 + i * 0.9), T * 0.6, T * 0.32, T * 0.35, C('#d0d0c8'));
                b.box(W * 0.55, 0, D * 0.55, W * 0.62, T * 1.1, D * 0.62, C('#8a8a8a'), o());
                chimney(W * 0.8, D * 0.7, T * 0.06, T * 1.2, C('#8a6a5a'));
                shed(T * 0.2, D * 0.6, W * 0.45, D - T * 0.2, T * 0.35, C('#b0b0a8'), C('#707070'));
                break;
            }
            case 6: case 23: case 7: case 14: {   // factories, printing works, paper mill
                const wall = type === 23 ? C('#c0a080') : C('#b04a3a');
                b.box(T * 0.15, 0, T * 0.15, W - T * 0.15, T * 0.45, D - T * 0.15, wall, o());
                const n = Math.max(2, Math.floor(W / (T * 0.5)));
                for (let i = 0; i < n; i++) {
                    const x0 = T * 0.15 + (W - T * 0.3) * i / n, x1 = T * 0.15 + (W - T * 0.3) * (i + 1) / n;
                    b.roof(x0, T * 0.15, x1, D - T * 0.15, T * 0.45, T * 0.15, C('#5a5a60'), { ox, oz: oy, oy: oz });
                }
                chimney(W * 0.85, D * 0.2, T * 0.07, T * 1.1);
                break;
            }
            case 8: {   // steel mill
                shed(T * 0.15, T * 0.15, W * 0.6, D - T * 0.15, T * 0.5, C('#6a6a70'), C('#404048'));
                b.cylinder(ox + W * 0.78, oy + D * 0.35, T * 0.22, oz, oz + T * 0.9, C('#5a4a40'), 10, { rTop: T * 0.12 });
                chimney(W * 0.8, D * 0.78, T * 0.08, T * 1.3);
                break;
            }
            case 9: case 24: {   // farm
                shed(T * 0.2, T * 0.2, T * 1.0, T * 0.8, T * 0.28, C('#e0d0b0'), C('#9a3b2e'));
                shed(W - T * 1.2, T * 0.25, W - T * 0.2, T * 0.95, T * 0.4, C('#9a3b2e'), C('#5a4a44'));
                b.cylinder(ox + W - T * 0.4, oy + D - T * 0.5, T * 0.16, oz, oz + T * 0.8, C('#c0c0b8'), 10, { rTop: T * 0.16 });
                b.cone(ox + W - T * 0.4, oy + D - T * 0.5, T * 0.17, oz + T * 0.8, oz + T * 0.95, C('#8a8a88'), 10);
                break;
            }
            case 11: {   // oil wells
                for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) if ((i + j) % 2 === 0) pumpjack(T * (i + 0.5), T * (j + 0.5));
                tank(W - T * 0.5, D - T * 0.5, T * 0.2, T * 0.3, C('#6a6a60'));
                break;
            }
            case 12: case 16: {   // bank
                b.box(T * 0.1, 0, T * 0.15, W - T * 0.1, T * 0.12, D - T * 0.15, C('#d8d0c0'), o());
                b.box(T * 0.2, T * 0.12, T * 0.25, W - T * 0.2, T * 0.62, D - T * 0.25, C('#e8e0d0'), o());
                for (let i = 0; i < 6; i++) b.cylinder(ox + T * 0.25 + (W - T * 0.5) * i / 5, oy + T * 0.2, T * 0.035, oz + T * 0.12, oz + T * 0.6, C('#f0e8d8'), 6);
                b.roof(T * 0.15, T * 0.15, W - T * 0.15, D - T * 0.2, T * 0.62, T * 0.12, C('#b8b0a0'), o());
                break;
            }
            case 13: {   // food processing plant
                shed(T * 0.15, T * 0.15, W * 0.65, D - T * 0.15, T * 0.4, C('#e0e0d8'), C('#5a7a9a'));
                for (let i = 0; i < 3; i++) b.cylinder(ox + W * 0.8, oy + T * (0.5 + i * 0.9), T * 0.2, oz, oz + T * 0.7, C('#d8d8d0'), 10);
                break;
            }
            case 19: rows(C('#f09030'), C('#3f8a2f')); b.box(W * 0.02, 0, D * 0.02, W * 0.15, T * 0.2, D * 0.18, C('#a07a50'), o()); break;   // fruit
            case 20: rows(null, C('#2f6a2a')); b.box(W * 0.02, 0, D * 0.02, W * 0.15, T * 0.2, D * 0.18, C('#a07a50'), o()); break;       // rubber
            case 21: {   // water supply
                shed(T * 0.2, T * 0.2, W * 0.5, D * 0.5, T * 0.3, C('#c8c8c0'), C('#4a6a8a'));
                tank(W * 0.72, D * 0.72, T * 0.35, T * 0.4, C('#6a9ac8'));
                break;
            }
            case 22: {   // water tower
                for (const [x, z] of [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]]) b.box(T * x - 1.5, 0, T * z - 1.5, T * x + 1.5, T * 0.6, T * z + 1.5, C('#707070'), o());
                b.cylinder(ox + T * 0.5, oy + T * 0.5, T * 0.28, oz + T * 0.6, oz + T * 0.95, C('#8ab0d0'), 10);
                b.cone(ox + T * 0.5, oy + T * 0.5, T * 0.3, oz + T * 0.95, oz + T * 1.1, C('#5a6a7a'), 10);
                break;
            }
            default:
                shed(T * 0.15, T * 0.15, W - T * 0.15, D - T * 0.15, T * 0.4, C('#a0a0a0'), C('#606060'));
        }
    },

    // --- Track and road -------------------------------------------------------------------------

    /** One rail piece on tile (x, y) — ballast, sleepers, two rails; z(u, v) gives heights (px). */
    /**
     * One piece of track. curve — for corner pieces, the centre line from Track.curve (tile-local
     * Bézier from the piece's first edge to its second); straight pieces pass nothing.
     */
    railPiece(b, track, ox, oy, zAt, railType, style, curve) {
        const T = Models.T, C = Models.C;
        const e = Track.EDGES[track];
        const A = Track.MID[e[0]], B = Track.MID[e[1]];
        // Centre line point and unit normal at f (0..1), in local px.
        const at = (f) => {
            if (curve) {
                const c = Track.bezier(curve, f), l = Math.hypot(c.dx, c.dy) || 1;
                return { x: c.x * T, y: c.y * T, nx: -c.dy / l, ny: c.dx / l };
            }
            const dx = B[0] - A[0], dy = B[1] - A[1], l = Math.hypot(dx, dy);
            return { x: (A[0] + dx * f) * T, y: (A[1] + dy * f) * T, nx: -dy / l, ny: dx / l };
        };
        const P = (f, off, up) => {
            const q = at(f), x = q.x + q.nx * off, y = q.y + q.ny * off;
            return [ox + x, zAt(x / T, y / T) + up, oy + y];
        };
        const segs = curve ? 8 : 1;
        let len = 0;
        for (let i = 0; i < 8; i++) { const p0 = at(i / 8), p1 = at((i + 1) / 8); len += Math.hypot(p1.x - p0.x, p1.y - p0.y); }
        const strip = (off0, off1, up, col, side) => {
            for (let i = 0; i < segs; i++) {
                const f0 = i / segs, f1 = (i + 1) / segs, q = at((f0 + f1) / 2);
                const n = side ? [q.nx * side, 0, q.ny * side] : [0, 1, 0];
                if (side) b.quad([P(f0, off0, up[0]), P(f1, off0, up[0]), P(f1, off0, up[1]), P(f0, off0, up[1])], null, col, n);
                else b.quad([P(f0, off0, up), P(f1, off0, up), P(f1, off1, up), P(f0, off1, up)], null, col, n);
            }
        };
        const ballast = style === 'station' ? C('#8a8a84') : C('#8c7f6a');
        strip(-T * 0.2, T * 0.2, 0.8, ballast, 0);
        // Sleepers, square to the centre line.
        const n = Math.max(2, Math.round(len / (T * 0.11)));
        const df = 0.025 * T / len;
        for (let i = 0; i < n; i++) {
            const f = (i + 0.5) / n;
            b.quad([P(f - df, -T * 0.15, 1.6), P(f + df, -T * 0.15, 1.6), P(f + df, T * 0.15, 1.6), P(f - df, T * 0.15, 1.6)], null, C('#5a4030'), [0, 1, 0]);
        }
        const rail = railType === 2 ? C('#a0a8b0') : railType === 3 ? C('#c8d0d8') : C('#9098a0');
        if (railType >= 2) {
            // Monorail / maglev: one raised beam.
            strip(-T * 0.07, T * 0.07, 4, rail, 0);
            return;
        }
        for (const off of [-T * 0.085, T * 0.085]) {
            strip(off - 1, off + 1, 3, rail, 0);
            strip(off - 1, off - 1, [1.6, 3], Models.shade(rail, 0.7), -1);
            strip(off + 1, off + 1, [1.6, 3], Models.shade(rail, 0.7), 1);
        }
        if (railType === 1) {
            // Catenary poles and wire.
            const pole = C('#6a6a6a');
            const p0 = P(0.5, T * 0.24, 0);
            b.box(-1.2, 0, -1.2, 1.2, T * 0.45, 1.2, pole, { ox: p0[0], oz: p0[2], oy: p0[1] });
            strip(-0.8, 0.8, T * 0.4, C('#303030'), 0);
        }
    },

    /** Signal post for trackdir td on tile-local geometry; green — the light colour. */
    signal(b, track, rev, ox, oy, zAt, green) {
        const T = Models.T, C = Models.C;
        const e = Track.EDGES[track];
        const from = Track.MID[rev ? e[1] : e[0]], to = Track.MID[rev ? e[0] : e[1]];
        const dx = to[0] - from[0], dy = to[1] - from[1], l = Math.hypot(dx, dy);
        const ux = dx / l, uy = dy / l;
        // To the right of the travel direction, near the entry.
        const px = (from[0] + ux * 0.15 - uy * 0.3) * T, py = (from[1] + uy * 0.15 + ux * 0.3) * T;
        const z = zAt(px / T, py / T);
        b.box(-1, 0, -1, 1, T * 0.32, 1, C('#404040'), { ox: ox + px, oz: oy + py, oy: z });
        b.box(-2.2, T * 0.26, -2.2, 2.2, T * 0.38, 2.2, green ? C('#30e040') : C('#f03020'), { ox: ox + px, oz: oy + py, oy: z });
    },

    /**
     * Road surface for the road bits of a tile. rs — roadside (GameMap.RS_*): pavements on paved
     * roadsides, and street lamps too with RS_LIGHTS; works — road works barriers; curve — for a
     * turn (two perpendicular halves), its centre line from Track.curve, drawn as a curved road.
     */
    roadTile(b, bits, ox, oy, zAt, rs, works, curve) {
        const town = rs === GameMap.RS_PAVED || rs === GameMap.RS_LIGHTS;
        const T = Models.T, C = Models.C;
        const asphalt = C('#5a5a5c'), line = C('#d8d0b0'), walk = C('#a8a49c');
        const up = 1.2;
        const Q = (u0, v0, u1, v1, col, lift) => {
            const z = (u, v) => zAt(u, v) + up + (lift || 0);
            b.quad([[ox + u0 * T, z(u0, v0), oy + v0 * T], [ox + u1 * T, z(u1, v0), oy + v0 * T],
                [ox + u1 * T, z(u1, v1), oy + v1 * T], [ox + u0 * T, z(u0, v1), oy + v1 * T]], null, col, [0, 1, 0]);
        };
        const w0 = 0.26, w1 = 0.74;
        if (curve) {
            // A band along the curve: asphalt, and pavements on both sides on paved roadsides.
            const at = (f) => { const c = Track.bezier(curve, f), l = Math.hypot(c.dx, c.dy) || 1; return [c.x, c.y, -c.dy / l, c.dx / l]; };
            const band = (o0, o1, col, lift) => {
                for (let i = 0; i < 8; i++) {
                    const p = at(i / 8), q = at((i + 1) / 8);
                    const V = (r, o) => { const u = r[0] + r[2] * o, v = r[1] + r[3] * o; return [ox + u * T, zAt(u, v) + up + lift, oy + v * T]; };
                    b.quad([V(p, o0), V(q, o0), V(q, o1), V(p, o1)], null, col, [0, 1, 0]);
                }
            };
            band(-0.24, 0.24, asphalt, 0);
            if (town) { band(-0.32, -0.24, walk, 0.6); band(0.24, 0.32, walk, 0.6); }
            return;
        }
        Q(w0, w0, w1, w1, asphalt);
        if (bits & 1) Q(0, w0, w0, w1, asphalt);          // NE (x = 0)
        if (bits & 4) Q(w1, w0, 1, w1, asphalt);          // SW
        if (bits & 8) Q(w0, 0, w1, w0, asphalt);          // NW (y = 0)
        if (bits & 2) Q(w0, w1, w1, 1, asphalt);          // SE
        // Centre lines on straights.
        if (bits === 5) Q(0, 0.49, 1, 0.51, line, 0.2);
        if (bits === 10) Q(0.49, 0, 0.51, 1, line, 0.2);
        if (town) {
            // Pavements on town roads.
            const P = (u0, v0, u1, v1) => Q(u0, v0, u1, v1, walk, 0.6);
            if (!(bits & 8)) P(w0 - 0.08, w0 - 0.08, w1 + 0.08, w0);
            if (!(bits & 2)) P(w0 - 0.08, w1, w1 + 0.08, w1 + 0.08);
            if (!(bits & 1)) P(w0 - 0.08, w0, w0, w1);
            if (!(bits & 4)) P(w1, w0, w1 + 0.08, w1);
        }
        if (rs === GameMap.RS_LIGHTS) {
            // Lamp posts on the pavement at two corners.
            for (const [u, v] of [[w0 - 0.05, w0 - 0.05], [w1 + 0.05, w1 + 0.05]]) {
                const z = zAt(u, v) + up;
                b.box(-0.8, 0, -0.8, 0.8, T * 0.34, 0.8, C('#3a3a40'), { ox: ox + u * T, oz: oy + v * T, oy: z });
                b.box(-2, T * 0.32, -2, 2, T * 0.37, 2, C('#f4e8a0'), { ox: ox + u * T, oz: oy + v * T, oy: z });
            }
        }
        if (works) {
            // Dug-up middle and red and white barriers across the road at both ends.
            Q(0.3, 0.3, 0.7, 0.7, C('#6a5038'), 0.3);
            const bar = (u0, v0, u1, v1) => {
                const zz = zAt((u0 + u1) / 2, (v0 + v1) / 2) + up;
                b.box(u0 * T, 0, v0 * T, u1 * T, T * 0.1, v1 * T, C('#d83028'), { ox, oz: oy, oy: zz, top: C('#f0f0f0') });
            };
            if (bits === 5) { bar(0.18, w0, 0.24, w1); bar(0.76, w0, 0.82, w1); }
            else { bar(w0, 0.18, w1, 0.24); bar(w0, 0.76, w1, 0.82); }
        }
    },

    // --- Stations, depots ---------------------------------------------------------------------------

    platform(b, axis, ox, oy, z, withRoof) {
        const T = Models.T, C = Models.C;
        const o = { ox, oz: oy, oy: z };
        const pl = C('#b8b4a8');
        if (axis === 0) {
            b.box(0, 0, 0, T, T * 0.09, T * 0.22, pl, o);
            b.box(0, 0, T * 0.78, T, T * 0.09, T, pl, o);
            if (withRoof) {
                for (const zz of [T * 0.11, T * 0.89]) b.box(T * 0.45, 0, zz - 1.5, T * 0.55, T * 0.45, zz + 1.5, C('#5a5a60'), o);
                b.box(0, T * 0.45, 0, T, T * 0.48, T * 0.24, C('#9a3b2e'), o);
                b.box(0, T * 0.45, T * 0.76, T, T * 0.48, T, C('#9a3b2e'), o);
            }
        } else {
            b.box(0, 0, 0, T * 0.22, T * 0.09, T, pl, o);
            b.box(T * 0.78, 0, 0, T, T * 0.09, T, pl, o);
            if (withRoof) {
                for (const xx of [T * 0.11, T * 0.89]) b.box(xx - 1.5, 0, T * 0.45, xx + 1.5, T * 0.45, T * 0.55, C('#5a5a60'), o);
                b.box(0, T * 0.45, 0, T * 0.24, T * 0.48, T, C('#9a3b2e'), o);
                b.box(T * 0.76, T * 0.45, 0, T, T * 0.48, T, C('#9a3b2e'), o);
            }
        }
    },

    roadStop(b, axis, truck, ox, oy, z) {
        const T = Models.T, C = Models.C;
        const o = { ox, oz: oy, oy: z };
        const col = truck ? C('#c89a30') : C('#3a7ac8');
        // A shelter / canopy on both sides.
        if (axis === 0) {
            b.box(T * 0.25, T * 0.35, 0, T * 0.75, T * 0.38, T * 0.2, col, o);
            b.box(T * 0.25, T * 0.35, T * 0.8, T * 0.75, T * 0.38, T, col, o);
            for (const x of [0.28, 0.72]) for (const zz of [0.05, 0.95]) b.box(T * x - 1, 0, T * zz - 1, T * x + 1, T * 0.35, T * zz + 1, C('#5a5a60'), o);
        } else {
            b.box(0, T * 0.35, T * 0.25, T * 0.2, T * 0.38, T * 0.75, col, o);
            b.box(T * 0.8, T * 0.35, T * 0.25, T, T * 0.38, T * 0.75, col, o);
            for (const zz of [0.28, 0.72]) for (const x of [0.05, 0.95]) b.box(T * x - 1, 0, T * zz - 1, T * x + 1, T * 0.35, T * zz + 1, C('#5a5a60'), o);
        }
    },

    /** A depot shed with its door toward edge dir. */
    depot(b, dir, ox, oy, z, kind) {
        const T = Models.T, C = Models.C;
        const o = { ox, oz: oy, oy: z };
        // Local frame: a runs from the back of the tile (0) to the entrance edge (1), c across.
        // rect() turns an a/c rectangle into tile px [x0, z0, x1, z1].
        const rect = (a0, a1, c0, c1) => {
            const U = (a, c) => dir === Dir.NE ? [1 - a, c] : dir === Dir.SW ? [a, c] : dir === Dir.NW ? [c, 1 - a] : [c, a];
            const p = U(a0, c0), q = U(a1, c1);
            return [Math.min(p[0], q[0]) * T, Math.min(p[1], q[1]) * T, Math.max(p[0], q[0]) * T, Math.max(p[1], q[1]) * T];
        };
        const box = (a0, a1, c0, c1, h0, h1, col) => {
            const r = rect(a0, a1, c0, c1);
            b.box(r[0], h0, r[1], r[2], h1, r[3], col, o);
        };
        const along = Dir.axis(dir) === 1;   // the building's long side follows the entrance axis
        if (kind === 'rail') {
            // TTD's engine shed: a long brick shed over the track, gable roof along the track,
            // a tall dark doorway with a white frame, a smoke vent on the ridge.
            const brick = C('#9a4632'), h = T * 0.4;
            box(0.04, 0.8, 0.16, 0.84, 0, h, brick);
            const r = rect(0.02, 0.82, 0.12, 0.88);
            b.roof(r[0], r[1], r[2], r[3], h, T * 0.2, C('#3e4046'), { ox, oz: oy, oy: z, alongZ: along });
            box(0.8, 0.81, 0.3, 0.7, 0, T * 0.36, C('#e8e4d8'));
            box(0.8, 0.815, 0.34, 0.66, 0, T * 0.32, C('#18181c'));
            box(0.36, 0.46, 0.46, 0.54, h + T * 0.12, h + T * 0.3, C('#5a5a5e'));
            return;
        }
        if (kind === 'road') {
            // A garage: flat roof, pale walls, two roller doors on the forecourt side, a red sign.
            const h = T * 0.3;
            box(0.04, 0.52, 0.08, 0.92, 0, h, C('#b8bcc4'));
            box(0.02, 0.54, 0.06, 0.94, h, h + 1.5, C('#5a5e66'));
            box(0.52, 0.53, 0.14, 0.48, 0, T * 0.24, C('#d8d8d0'));
            box(0.52, 0.53, 0.52, 0.86, 0, T * 0.24, C('#d8d8d0'));
            for (const c0 of [0.14, 0.52]) for (let i = 1; i < 5; i++) box(0.525, 0.535, c0, c0 + 0.34, i * T * 0.048, i * T * 0.048 + 0.6, C('#8a8a86'));
            box(0.3, 0.36, 0.2, 0.8, h + 1.5, h + T * 0.1, C('#c83a2e'));
            return;
        }
        // Ship depot: a boat shed on the water.
        box(0.12, 0.88, 0.12, 0.88, 0, T * 0.42, C('#c8b890'));
        b.roof(T * 0.1, T * 0.1, T * 0.9, T * 0.9, T * 0.42, T * 0.16, C('#4a4a50'), { ox, oz: oy, oy: z, alongZ: along });
        box(0.86, 0.9, 0.3, 0.7, 0, T * 0.34, C('#202024'));
    },

    /** Airport of type at local origin (whole footprint). */
    airport(b, type, ox, oy, z) {
        const T = Models.T, C = Models.C;
        const o = { ox, oz: oy, oy: z };
        const A = TTDData.AIRPORTS[type];
        const W = A.w * T, D = A.h * T;
        const L = Airports.LAYOUT[type];
        b.box(0, 0, 0, W, 0.8, D, C('#8a9a70'), o);
        if (type === 2) {
            b.box(T * 0.1, 0.8, T * 0.1, T * 0.9, 1.6, T * 0.9, C('#6a6a6a'), o);
            b.box(T * 0.35, 1.6, T * 0.45, T * 0.65, 1.9, T * 0.55, C('#f0f0f0'), o);
            b.box(T * 0.45, 1.6, T * 0.35, T * 0.55, 1.9, T * 0.65, C('#f0f0f0'), o);
            return;
        }
        // Runway with markings.
        const ry = L.runwayStart[1] * T;
        b.box(T * 0.05, 0.8, ry - T * 0.28, W - T * 0.05, 1.6, ry + T * 0.28, C('#505052'), o);
        for (let x = T * 0.3; x < W - T * 0.3; x += T * 0.5) b.box(x, 1.6, ry - 1, x + T * 0.25, 1.9, ry + 1, C('#f0f0f0'), o);
        // Apron, terminal, hangar, tower.
        b.box(T * 0.1, 0.8, T * 0.1, W - T * 0.1, 1.4, ry - T * 0.4, C('#7a7a7a'), o);
        const tz = type === 0 ? T * 0.1 : T * 0.1;
        b.box(T * 1.1, 0, tz, W - T * 0.9, T * 0.28, tz + T * 0.25, C('#d8d8d0'), o);
        b.box(T * 1.1, T * 0.1, tz + T * 0.25 - 0.5, W - T * 0.9, T * 0.22, tz + T * 0.25 + 0.5, C('#5a7fa0'), o);
        const h = L.hangar;
        b.box(h[0] * T - T * 0.4, 0, h[1] * T - T * 0.35, h[0] * T + T * 0.4, T * 0.35, h[1] * T + T * 0.35, C('#9aa0a8'), o);
        b.cylinder(ox + h[0] * T, oy + h[1] * T, T * 0.4, z + T * 0.3, z + T * 0.42, C('#80868e'), 8, { rTop: T * 0.2 });
        b.box(W - T * 0.6, 0, T * 0.15, W - T * 0.45, T * 0.9, T * 0.3, C('#c0c0b8'), o);
        b.box(W - T * 0.66, T * 0.9, T * 0.09, W - T * 0.39, T * 1.05, T * 0.36, C('#5a7fa0'), o);
    },

    dock(b, dir, ox, oy, zLow) {
        const T = Models.T, C = Models.C;
        const m = Track.MID[dir];
        const o = { ox, oz: oy, oy: zLow };
        // A pier reaching over the water edge and a crane.
        const px = m[0] * T, pz = m[1] * T;
        b.box(Math.min(px, T * 0.5) - T * 0.3, 0, Math.min(pz, T * 0.5) - T * 0.3, Math.max(px, T * 0.5) + T * 0.3, T * 0.14, Math.max(pz, T * 0.5) + T * 0.3, C('#8a7050'), o);
        b.box(T * 0.45, T * 0.14, T * 0.45, T * 0.55, T * 0.7, T * 0.55, C('#d0a020'), o);
        b.box(T * 0.45, T * 0.62, T * 0.45, T * 0.55 + (px - T * 0.5) * 0.9, T * 0.68, T * 0.55 + (pz - T * 0.5) * 0.9, C('#d0a020'), o);
    },

    /** Bridge deck between two heads (world px), with pillars down to the ground. */
    bridge(b, wh, map, type) {
        const T = Models.T, L = Models.L, C = Models.C;
        const spec = TTDData.BRIDGES[type] || TTDData.BRIDGES[0];
        const col = /Wooden/.test(spec.name) ? C('#8a6a40') : /Concrete/.test(spec.name) ? C('#b0aca0') : C('#8a3a2a');
        const dir = wh.dir;
        const ax = map.tx(wh.a), ay = map.ty(wh.a);
        const n = IMath.manhattan(ax, ay, map.tx(wh.b), map.ty(wh.b));
        const zDeck = wh.z * L;
        for (let i = 1; i < n; i++) {
            const x = (ax + Dir.DX[dir] * i) * T, y = (ay + Dir.DY[dir] * i) * T;
            const o = { ox: x, oz: y, oy: zDeck };
            if (Dir.axis(dir) === 0) b.box(0, -T * 0.12, T * 0.15, T, 1, T * 0.85, col, o);
            else b.box(T * 0.15, -T * 0.12, 0, T * 0.85, 1, T, col, o);
            const t = map.idx(ax + Dir.DX[dir] * i, ay + Dir.DY[dir] * i);
            const ground = map.tileMinZ(t) * L;
            if (i % 2 === 1 && zDeck - ground > 4) {
                const pz = map.type[t] === GameMap.T_WATER ? 0 : ground;
                b.box(T * 0.4, pz - zDeck, T * 0.4, T * 0.6, -T * 0.12, T * 0.6, Models.shade(col, 0.8), o);
            }
            // Girders / rails of steel bridges.
            if (!/Wooden|Concrete/.test(spec.name)) {
                if (Dir.axis(dir) === 0) { b.box(0, 1, T * 0.13, T, T * 0.22, T * 0.17, col, o); b.box(0, 1, T * 0.83, T, T * 0.22, T * 0.87, col, o); }
                else { b.box(T * 0.13, 1, 0, T * 0.17, T * 0.22, T, col, o); b.box(T * 0.83, 1, 0, T * 0.87, T * 0.22, T, col, o); }
            } else {
                if (Dir.axis(dir) === 0) { b.box(0, 1, T * 0.15, T, T * 0.08, T * 0.18, col, o); b.box(0, 1, T * 0.82, T, T * 0.08, T * 0.85, col, o); }
                else { b.box(T * 0.15, 1, 0, T * 0.18, T * 0.08, T, col, o); b.box(T * 0.82, 1, 0, T * 0.85, T * 0.08, T, col, o); }
            }
        }
    },

    tunnelPortal(b, dir, ox, oy, z) {
        const T = Models.T, C = Models.C;
        const m = Track.MID[dir];
        const o = { ox, oz: oy, oy: z };
        const stone = C('#8a8478'), dark = C('#101012');
        // A stone face across the tile at its inner half with a dark mouth.
        if (Dir.axis(dir) === 0) {
            const x = m[0] * T * 0.6 + T * 0.2;
            b.box(x - 2, 0, T * 0.05, x + 2, T * 0.55, T * 0.95, stone, o);
            b.box(x - 2.5, 0, T * 0.25, x + 2.5, T * 0.38, T * 0.75, dark, o);
        } else {
            const zz = m[1] * T * 0.6 + T * 0.2;
            b.box(T * 0.05, 0, zz - 2, T * 0.95, T * 0.55, zz + 2, stone, o);
            b.box(T * 0.25, 0, zz - 2.5, T * 0.75, T * 0.38, zz + 2.5, dark, o);
        }
    },

    companyStatue(b, ox, oy, z) {
        const T = Models.T, C = Models.C;
        b.box(T * 0.3, 0, T * 0.3, T * 0.7, T * 0.15, T * 0.7, C('#c0b8a8'), { ox, oz: oy, oy: z });
        b.cylinder(ox + T * 0.5, oy + T * 0.5, T * 0.07, z + T * 0.15, z + T * 0.5, C('#b08a30'), 8);
    },

    // --- Vehicles ----------------------------------------------------------------------------------

    /**
     * A vehicle car model centred at the origin, nose along +X, wheels at y = 0.
     * kind: from Models.vehicleKind(); cargo colour for open wagons and trucks.
     */
    vehicle(kind, cargoCol, company) {
        const b = new MeshData(), T = Models.T, C = Models.C;
        const cc = company || C('#1d4f9a'), cream = C('#e8dcc0'), dark = C('#2a2a2e'), glass = C('#4a6a8a');
        const len = T * 0.46, wid = T * 0.17;
        const hl = len / 2, hw = wid / 2;
        const wheels = (n, r) => {
            for (let i = 0; i < n; i++) {
                const x = -hl + len * (i + 0.5) / n;
                for (const s of [-1, 1]) b.box(x - r, 0, s * hw - 1, x + r, r * 2, s * hw + 1, dark);
            }
        };
        switch (kind) {
            case 'steam': {
                wheels(3, T * 0.035);
                b.box(-hl, T * 0.06, -hw, hl, T * 0.09, hw, dark);
                // Boiler along x, cab at the back, chimney at the front.
                b.box(-hl * 0.1, T * 0.09, -hw * 0.8, hl * 0.9, T * 0.2, hw * 0.8, cc);
                b.box(-hl, T * 0.09, -hw, -hl * 0.1, T * 0.28, hw, cc, { top: dark });
                b.cylinder(hl * 0.7, 0, T * 0.03, T * 0.2, T * 0.3, dark, 6);
                b.box(-hl * 0.95, T * 0.2, -hw * 0.9, -hl * 0.3, T * 0.25, hw * 0.9, glass);
                break;
            }
            case 'diesel': case 'electric': case 'mono': case 'maglev': {
                wheels(kind === 'maglev' ? 0 : 2, T * 0.03);
                const body = kind === 'electric' ? C('#2a6a3a') : kind === 'mono' ? C('#c0c8d0') : kind === 'maglev' ? C('#e8e8f0') : cc;
                b.box(-hl, T * 0.06, -hw, hl, T * 0.24, hw, body, { top: Models.shade(body, 0.8) });
                b.box(hl * 0.6, T * 0.16, -hw - 0.5, hl + 0.5, T * 0.22, hw + 0.5, glass);
                b.box(-hl - 0.5, T * 0.16, -hw - 0.5, -hl * 0.6, T * 0.22, hw + 0.5, glass);
                b.box(-hl * 0.5, T * 0.13, -hw - 0.3, hl * 0.5, T * 0.15, hw + 0.3, cream);
                if (kind === 'electric') b.box(-T * 0.06, T * 0.24, -1, T * 0.06, T * 0.3, 1, dark);
                if (kind === 'maglev' || kind === 'mono') b.box(hl * 0.7, T * 0.06, -hw, hl + T * 0.04, T * 0.14, hw, body);
                break;
            }
            case 'coach': case 'dmu': case 'mail': {
                wheels(2, T * 0.03);
                const body = kind === 'mail' ? C('#8a2a2a') : kind === 'dmu' ? C('#3a6a3a') : C('#6a4a2a');
                b.box(-hl, T * 0.06, -hw, hl, T * 0.23, hw, body, { top: C('#4a4a4a') });
                b.box(-hl + 2, T * 0.14, -hw - 0.5, hl - 2, T * 0.2, hw + 0.5, kind === 'mail' ? body : glass);
                if (kind === 'dmu') b.box(hl * 0.7, T * 0.14, -hw - 0.6, hl + 0.5, T * 0.2, hw + 0.6, glass);
                break;
            }
            case 'hopper': {
                wheels(2, T * 0.03);
                b.box(-hl, T * 0.06, -hw, hl, T * 0.17, hw, C('#5a4a40'));
                b.box(-hl + 2, T * 0.17, -hw + 1.5, hl - 2, T * 0.19, hw - 1.5, cargoCol || C('#303030'));
                break;
            }
            case 'tanker': {
                wheels(2, T * 0.03);
                b.box(-hl, T * 0.06, -hw * 0.7, hl, T * 0.09, hw * 0.7, dark);
                b.box(-hl + 2, T * 0.09, -hw * 0.8, hl - 2, T * 0.2, hw * 0.8, cargoCol || C('#303030'), { top: Models.shade(cargoCol || C('#303030'), 1.2) });
                break;
            }
            case 'van': {
                wheels(2, T * 0.03);
                b.box(-hl, T * 0.06, -hw, hl, T * 0.22, hw, cargoCol || C('#7a5a3a'), { top: C('#5a5a5a') });
                break;
            }
            case 'flat': {
                wheels(2, T * 0.03);
                b.box(-hl, T * 0.06, -hw, hl, T * 0.09, hw, C('#5a4a40'));
                for (let i = 0; i < 3; i++) b.box(-hl + 3, T * 0.09 + i * 2, -hw + 2 + i, hl - 3, T * 0.09 + (i + 1) * 2, hw - 2 - i, cargoCol || C('#8a6038'));
                break;
            }
            case 'bus': {
                const bl = T * 0.34, bw = T * 0.13;
                for (const x of [-bl * 0.3, bl * 0.3]) for (const s of [-1, 1]) b.box(x - 2.5, 0, s * bw / 2 - 1, x + 2.5, 5, s * bw / 2 + 1, dark);
                b.box(-bl / 2, T * 0.04, -bw / 2, bl / 2, T * 0.17, bw / 2, cc, { top: C('#e0e0e0') });
                b.box(-bl / 2 + 1, T * 0.1, -bw / 2 - 0.5, bl / 2 + 0.5, T * 0.15, bw / 2 + 0.5, glass);
                break;
            }
            case 'truck': {
                const bl = T * 0.34, bw = T * 0.13;
                for (const x of [-bl * 0.3, bl * 0.35]) for (const s of [-1, 1]) b.box(x - 2.5, 0, s * bw / 2 - 1, x + 2.5, 5, s * bw / 2 + 1, dark);
                b.box(bl * 0.2, T * 0.04, -bw / 2, bl / 2, T * 0.16, bw / 2, cc);
                b.box(bl * 0.4, T * 0.1, -bw / 2 - 0.5, bl / 2 + 0.5, T * 0.14, bw / 2 + 0.5, glass);
                b.box(-bl / 2, T * 0.04, -bw / 2, bl * 0.18, T * 0.15, bw / 2, cargoCol || C('#8a8a8a'), { top: Models.shade(cargoCol || C('#8a8a8a'), 0.85) });
                break;
            }
            case 'ship': case 'ferry': case 'tanker_ship': case 'hover': {
                const sl = T * 0.9, sw = T * 0.28;
                const hull = kind === 'hover' ? C('#c8c8c8') : C('#3a3a40');
                b.box(-sl / 2, -T * 0.04, -sw / 2, sl / 2, T * 0.06, sw / 2, hull, { top: C('#8a5a3a') });
                b.box(sl / 2 - 1, -T * 0.04, -sw / 3, sl / 2 + T * 0.08, T * 0.06, sw / 3, hull);
                if (kind === 'ferry' || kind === 'hover') {
                    b.box(-sl * 0.35, T * 0.06, -sw * 0.4, sl * 0.3, T * 0.16, sw * 0.4, C('#f0f0f0'));
                    b.box(-sl * 0.33, T * 0.1, -sw * 0.41, sl * 0.28, T * 0.13, sw * 0.41, glass);
                } else if (kind === 'tanker_ship') {
                    b.box(-sl * 0.45, T * 0.06, -sw * 0.3, -sl * 0.25, T * 0.2, sw * 0.3, C('#f0f0f0'));
                    b.box(-sl * 0.2, T * 0.06, -sw * 0.25, sl * 0.4, T * 0.09, sw * 0.25, C('#a03020'));
                } else {
                    b.box(-sl * 0.45, T * 0.06, -sw * 0.3, -sl * 0.25, T * 0.2, sw * 0.3, C('#f0f0f0'));
                    for (let i = 0; i < 3; i++) b.box(-sl * 0.18 + i * sl * 0.2, T * 0.06, -sw * 0.3, -sl * 0.04 + i * sl * 0.2, T * 0.14, sw * 0.3, [C('#c04040'), C('#4060c0'), C('#40a040')][i]);
                }
                b.cylinder(-sl * 0.35, 0, T * 0.03, T * 0.16, T * 0.26, cc, 6);
                break;
            }
            case 'plane': case 'jet': case 'bigjet': {
                const fl = kind === 'bigjet' ? T * 1.1 : kind === 'jet' ? T * 0.9 : T * 0.7;
                const fw = kind === 'bigjet' ? T * 0.13 : T * 0.1;
                const span = kind === 'plane' ? T * 0.9 : T * 1.0;
                const body = C('#f0f0f0');
                b.box(-fl / 2, T * 0.05, -fw / 2, fl / 2, T * 0.05 + fw, fw / 2, body, { top: body });
                b.box(fl / 2 - 1, T * 0.07, -fw / 3, fl / 2 + T * 0.06, T * 0.05 + fw * 0.8, fw / 3, body);
                b.box(-fl * 0.08, T * 0.07, -span / 2, fl * 0.12, T * 0.09, span / 2, cc);
                b.box(-fl / 2, T * 0.07, -span * 0.2, -fl * 0.36, T * 0.085, span * 0.2, cc);
                b.box(-fl / 2, T * 0.05 + fw, -1.2, -fl * 0.36, T * 0.05 + fw + T * 0.14, 1.2, cc);
                b.box(-fl / 2 + 2, T * 0.05 + fw * 0.55, -fw / 2 - 0.5, fl / 2 - 3, T * 0.05 + fw * 0.75, fw / 2 + 0.5, glass);
                if (kind === 'plane') for (const s of [-1, 1]) b.cylinder(fl * 0.15, s * span * 0.28, T * 0.03, T * 0.05, T * 0.1, dark, 6);
                else for (const s of [-1, 1]) b.box(-fl * 0.05, T * 0.02, s * span * 0.25 - 2, fl * 0.15, T * 0.07, s * span * 0.25 + 2, C('#909090'));
                for (const x of [fl * 0.3, -fl * 0.05]) b.box(x - 1.5, 0, -1.5, x + 1.5, T * 0.05, 1.5, dark);
                break;
            }
            case 'heli': {
                b.box(-T * 0.18, T * 0.04, -T * 0.07, T * 0.18, T * 0.16, T * 0.07, cc, { top: C('#e0e0e0') });
                b.box(T * 0.05, T * 0.09, -T * 0.075, T * 0.19, T * 0.14, T * 0.075, glass);
                b.box(-T * 0.45, T * 0.1, -1.5, -T * 0.18, T * 0.13, 1.5, cc);
                b.box(-T * 0.35, T * 0.2, -2, T * 0.35, T * 0.21, 2, dark);
                b.box(-2, T * 0.2, -T * 0.35, 2, T * 0.21, T * 0.35, dark);
                b.box(-T * 0.2, 0, -T * 0.08, T * 0.2, 1.5, -T * 0.06, dark);
                b.box(-T * 0.2, 0, T * 0.06, T * 0.2, 1.5, T * 0.08, dark);
                break;
            }
            default:
                b.box(-hl, 0, -hw, hl, T * 0.2, hw, cc);
        }
        return b;
    },

    /** Model kind of an engine (and the cargo colour of a car). */
    /** A unit puff of steam or smoke (radius 1, low-poly): scaled per copy by the effects. */
    puff(b, col) {
        // An icosahedron.
        const t = (1 + Math.sqrt(5)) / 2, k = 1 / Math.hypot(1, t);
        const V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
            .map(v => [v[0] * k, v[1] * k, v[2] * k]);
        const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
            [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
        for (const [a, c, d] of F) {
            const n = [(V[a][0] + V[c][0] + V[d][0]) / 3, (V[a][1] + V[c][1] + V[d][1]) / 3, (V[a][2] + V[c][2] + V[d][2]) / 3];
            b.tri(V[a], V[c], V[d], null, null, null, col, n);
        }
    },

    vehicleKind(world, e, car) {
        const cargo = car && car.slot >= 0 ? world.cargo(car.slot) : null;
        const key = cargo ? cargo.key : '';
        if (e.type === 'rail') {
            if (!e.wagon) {
                if (/Steam/.test(e.name)) return 'steam';
                if (/DMU/.test(e.name)) return 'dmu';
                if (e.rail === 2) return 'mono';
                if (e.rail === 3) return 'maglev';
                if (e.rail === 1 || /Electric/.test(e.name)) return 'electric';
                return 'diesel';
            }
            if (key === 'passengers') return 'coach';
            if (key === 'mail') return 'mail';
            if (['oil', 'water', 'rubber'].includes(key)) return 'tanker';
            if (['coal', 'iron_ore', 'copper_ore', 'grain', 'maize'].includes(key)) return 'hopper';
            if (['wood', 'steel'].includes(key)) return 'flat';
            return 'van';
        }
        if (e.type === 'road') return key === 'passengers' ? 'bus' : 'truck';
        if (e.type === 'ship') return /Hovercraft/.test(e.name) ? 'hover' : key === 'passengers' ? 'ferry' : key === 'oil' ? 'tanker_ship' : 'ship';
        if (e.heli) return 'heli';
        if (e.fast && e.capacity >= 150) return 'bigjet';
        return e.fast ? 'jet' : 'plane';
    },
};
