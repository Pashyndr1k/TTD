// TTDTerrain3D.js — the 3D picture of the TTD tile map: chunked terrain meshes (one per
// GameMap.CHUNK² tiles, flat-shaded tiles folded along the same diagonal as GameMap.groundZ),
// foundations under buildings on slopes, a sea plane at water level around and inside the map,
// and a texture atlas of ground kinds (grass, rough, rocks, fields, desert, rainforest, …).
//
// It also stands in for the kit's Terrain3D where the kit expects one: CameraController and
// View3D.pointerToGround read heightAt(x, y) (world px), hgrid, hMin and hMax.
//
// Winding follows the kit's convention (skill render-conventions): the cross product of a
// triangle's edges points AGAINST its normal, default sideOrientation. addTri() orders every
// triangle by a normal hint, so walls and tops come out right whatever order they are listed in.

class TTDTerrain3D {
    /** @param {View3D} view @param {GameMap} map */
    constructor(view, map) {
        this.view = view;
        this.scene = view.scene;
        this.map = map;
        const c = TTDTerrain3D.cfg();
        this.TILE = c.tile;
        this.LEVEL = c.level;
        this.hgrid = map.hc;                 // pointerToGround only checks that a grid exists
        this.hMin = -this.LEVEL;
        this.hMax = map.maxHeight * this.LEVEL + this.LEVEL * 2;
        /** @type {(BABYLON.Mesh | null)[]} */
        this.chunks = new Array(map.chunksX * map.chunksY).fill(null);
        this._buildAtlas();
        this._buildWater();
        /** Tile -> atlas cell override for the ground under built things (set by TTDRender3D). */
        this.groundCell = null;
        /** Tile -> heights of the foundation top's corners [N, W, S, E], or null (set by TTDRender3D). */
        this.foundationOf = null;
    }

    static cfg() {
        const U = 'undefined';
        return {
            tile: typeof TTD_TILE !== U ? TTD_TILE : 64,
            level: typeof TTD_LEVEL !== U ? TTD_LEVEL : 24,
            water: typeof TTD_WATER_LEVEL !== U ? TTD_WATER_LEVEL : 0.35,
            waterColor: typeof TTD_WATER_COLOR !== U ? TTD_WATER_COLOR : 0x2f6fa8,
        };
    }

    // --- Kit Terrain3D interface -----------------------------------------------------

    /** Ground height in world px under a world point. */
    heightAt(x, y) {
        return this.map.groundZ(x / this.TILE, y / this.TILE) * this.LEVEL;
    }

    // --- Atlas ------------------------------------------------------------------------

    _buildAtlas() {
        const N = TTDTerrain3D.ATLAS_CELLS, S = TTDTerrain3D.CELL_PX;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = N * S;
        this.atlasCanvas = canvas;
        const g = canvas.getContext('2d');
        const rng = new Rng(12345);
        const paint = (cell, base, spots) => {
            const x0 = (cell % N) * S, y0 = Math.floor(cell / N) * S;
            g.fillStyle = base;
            g.fillRect(x0, y0, S, S);
            for (const [color, count, size] of spots) {
                g.fillStyle = color;
                for (let i = 0; i < count; i++) {
                    const r = size * (0.5 + rng.float());
                    g.beginPath();
                    g.ellipse(x0 + rng.float() * S, y0 + rng.float() * S, r, r * (0.6 + rng.float() * 0.5), rng.float() * 3, 0, 6.3);
                    g.fill();
                }
            }
        };
        const A = TTDTerrain3D.A;
        paint(A.GRASS, '#5f9a3c', [['#6ea846', 90, 10], ['#4f8a31', 70, 7], ['#7cb452', 40, 4]]);
        paint(A.ROUGH, '#6f8e3e', [['#5b6f33', 80, 9], ['#8a8a4a', 40, 6], ['#4c5e2a', 60, 4]]);
        paint(A.ROCKS, '#7d8a5a', [['#9a9a92', 40, 16], ['#7c7c76', 50, 10], ['#b4b4aa', 30, 6]]);
        this._paintFields(g, A.FIELDS, '#b49a4a', '#8c7434');
        this._paintFields(g, A.FIELDS2, '#8fb04a', '#6d8c34');
        paint(A.SNOW, '#e8eef2', [['#ffffff', 60, 12], ['#cfd8e0', 50, 8]]);
        paint(A.DESERT, '#dcc27e', [['#e8d49a', 80, 10], ['#c8ad68', 60, 7], ['#f0e0b0', 30, 4]]);
        paint(A.RAINFOREST, '#3e7a2c', [['#2f6522', 90, 11], ['#4f8d36', 60, 6], ['#6b5a2a', 30, 4]]);
        paint(A.DIRT, '#8a7048', [['#7a6040', 80, 8], ['#9c8258', 60, 5]]);
        paint(A.PAVED, '#9a9a94', [['#8c8c86', 60, 6], ['#a8a8a2', 60, 4]]);
        paint(A.SEABED, '#b8a878', [['#a89868', 60, 8]]);
        paint(A.CLIFF, '#8c7a5c', [['#7a6a4c', 90, 8], ['#9e8c6c', 60, 5]]);
        paint(A.GRASS_DARK, '#4f8a32', [['#5c9a3a', 80, 9], ['#437a2a', 70, 6]]);
        paint(A.CONCRETE, '#b0aca0', [['#a4a094', 40, 5]]);
        paint(A.SHORE, '#cdbb86', [['#bfae78', 60, 7]]);
        paint(A.DESERT_DARK, '#c9ad6c', [['#b89c5c', 60, 8]]);
        // Paved grid lines on concrete (station and industry yards).
        {
            const x0 = (A.CONCRETE % N) * S, y0 = Math.floor(A.CONCRETE / N) * S;
            g.strokeStyle = 'rgba(80,80,72,0.35)';
            g.lineWidth = 2;
            for (let i = 0; i <= 4; i++) {
                g.beginPath(); g.moveTo(x0 + i * S / 4, y0); g.lineTo(x0 + i * S / 4, y0 + S); g.stroke();
                g.beginPath(); g.moveTo(x0, y0 + i * S / 4); g.lineTo(x0 + S, y0 + i * S / 4); g.stroke();
            }
        }
        const tex = new BABYLON.DynamicTexture('ttdAtlas', canvas, this.scene, true,
            BABYLON.Texture.TRILINEAR_SAMPLINGMODE, BABYLON.Constants.TEXTUREFORMAT_RGBA, false);
        tex.update(false);
        tex.wrapU = tex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
        tex.anisotropicFilteringLevel = IS_MOBILE ? 2 : 8;
        this.atlas = tex;
        const mat = new BABYLON.StandardMaterial('ttdGround', this.scene);
        mat.metadata = { toonGroup: 'ground' };
        mat.diffuseTexture = tex;
        mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
        World3D.applyMaterialConstants(mat);
        this.material = mat;
        // The kit's painted grass, sand and snow replace the procedural cells when they arrive.
        this._loadCell('assets/ground_texture_g.jpg', [A.GRASS, A.GRASS_DARK, A.ROUGH], [1, 0.82, 0.78]);
        this._loadCell('assets/ground_texture_d.jpg', [A.DESERT, A.DESERT_DARK], [1, 0.88]);
        this._loadCell('assets/ground_texture_s.jpg', [A.SNOW], [1]);
    }

    _paintFields(g, cell, a, b) {
        const N = TTDTerrain3D.ATLAS_CELLS, S = TTDTerrain3D.CELL_PX;
        const x0 = (cell % N) * S, y0 = Math.floor(cell / N) * S;
        for (let i = 0; i < 16; i++) {
            g.fillStyle = i % 2 ? a : b;
            g.fillRect(x0, y0 + i * S / 16, S, S / 16);
        }
    }

    _loadCell(url, cells, tints) {
        if (typeof Image === 'undefined') return;
        const img = new Image();
        img.onload = () => {
            const N = TTDTerrain3D.ATLAS_CELLS, S = TTDTerrain3D.CELL_PX;
            const g = this.atlasCanvas.getContext('2d');
            cells.forEach((cell, i) => {
                const x0 = (cell % N) * S, y0 = Math.floor(cell / N) * S;
                g.drawImage(img, x0, y0, S, S);
                const t = tints[i];
                if (t < 1) {
                    g.fillStyle = 'rgba(40,50,20,' + (1 - t) + ')';
                    g.fillRect(x0, y0, S, S);
                }
            });
            if (this.atlas) this.atlas.update(false);
        };
        img.src = url;
    }

    // --- Water --------------------------------------------------------------------------

    _buildWater() {
        const c = TTDTerrain3D.cfg(), T = this.TILE, m = this.map;
        const margin = 9000, w = m.W * T + margin * 2, h = m.H * T + margin * 2;
        const water = BABYLON.MeshBuilder.CreateGround('ttdWater', { width: w, height: h, subdivisions: 1 }, this.scene);
        water.position.set(m.W * T / 2, c.water * this.LEVEL, m.H * T / 2);
        const mat = new BABYLON.StandardMaterial('ttdWaterMat', this.scene);
        mat.metadata = { toonGroup: 'prop' };
        mat.diffuseColor = World3D.hexColor3(c.waterColor);
        mat.specularColor = new BABYLON.Color3(0.25, 0.28, 0.3);
        mat.specularPower = 48;
        water.material = mat;
        water.receiveShadows = true;
        water.isPickable = false;
        water.freezeWorldMatrix();
        this.water = water;
        this.waterMaterial = mat;
    }

    // --- Chunks -------------------------------------------------------------------------

    /** Rebuild the chunks the map marked dirty; at most `budget` per call (0 — all). */
    update(budget) {
        const m = this.map;
        if (!m.dirty.size) return 0;
        let n = 0;
        for (const k of m.dirty) {
            this.buildChunk(k);
            m.dirty.delete(k);
            if (budget && ++n >= budget) break;
        }
        return n;
    }

    buildChunk(k) {
        const m = this.map, N = m.chunk;
        const cx = k % m.chunksX, cy = (k / m.chunksX) | 0;
        const x0 = cx * N, y0 = cy * N, x1 = Math.min(m.W, x0 + N), y1 = Math.min(m.H, y0 + N);
        const b = new MeshData();
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this._tile(b, y * m.W + x);
        const old = this.chunks[k];
        if (old) old.dispose(false, false);
        const mesh = b.toMesh('ttdChunk' + k, this.scene);
        mesh.material = this.material;
        mesh.receiveShadows = true;
        mesh.isPickable = false;
        mesh.freezeWorldMatrix();
        this.chunks[k] = mesh;
    }

    /** Atlas cell for a tile's ground. */
    cellOf(t) {
        const m = this.map, A = TTDTerrain3D.A;
        if (this.groundCell) {
            const c = this.groundCell(t);
            if (c >= 0) return c;
        }
        const tp = m.type[t];
        if (tp === GameMap.T_WATER) return A.SEABED;
        const g = m.ground[t];
        if (tp === GameMap.T_TREES) {
            if (m.zone[t] === GameMap.Z_DESERT || g === GameMap.G_DESERT) return A.DESERT_DARK;
            if (m.zone[t] === GameMap.Z_RAINFOREST) return A.RAINFOREST;
            return g === GameMap.G_ROUGH ? A.ROUGH : A.GRASS_DARK;
        }
        switch (g) {
            case GameMap.G_ROUGH: return A.ROUGH;
            case GameMap.G_ROCKS: return A.ROCKS;
            case GameMap.G_FIELDS: return (m.tx(t) + m.ty(t)) % 3 === 0 ? A.FIELDS2 : A.FIELDS;
            case GameMap.G_SNOW: return A.SNOW;
            case GameMap.G_DESERT: return A.DESERT;
        }
        if (m.zone[t] === GameMap.Z_RAINFOREST) return A.RAINFOREST;
        if (m.tileMinZ(t) === 0 && m.tileMaxZ(t) > 0) return A.SHORE;
        return A.GRASS;
    }

    /** UV rectangle of a tile: a quarter of its atlas cell, picked by tile parity (repeats every 2 tiles). */
    _uv(t, cell) {
        const m = this.map, N = TTDTerrain3D.ATLAS_CELLS, pad = 4 / TTDTerrain3D.CELL_PX;
        const qx = m.tx(t) & 1, qy = m.ty(t) & 1;
        const u0 = (cell % N + qx * 0.5 + pad) / N, v0 = (Math.floor(cell / N) + qy * 0.5 + pad) / N;
        const du = (0.5 - 2 * pad) / N;
        return [u0, v0, du];
    }

    _tile(b, t) {
        const m = this.map, T = this.TILE, L = this.LEVEL;
        const x = m.tx(t) * T, y = m.ty(t) * T;
        const c = m.corners(t);   // N W S E
        const cell = this.cellOf(t);
        const [u0, v0, du] = this._uv(t, cell);
        const top = this.foundationOf ? this.foundationOf(t) : null;
        const shade = 0.94 + (((m.tx(t) * 73856093) ^ (m.ty(t) * 19349663)) & 15) / 250;
        const col = [shade, shade, shade];
        const sea = m.type[t] === GameMap.T_WATER ? -0.6 : 0;
        if (top) {
            // The foundation's top (flat, or an incline for a road on an inclined foundation) and
            // walls of cliff down to the natural ground. Corners: N, W, S, E.
            const z = top.map(h => h * L);
            const P = [[x, z[0], y], [x + T, z[1], y], [x + T, z[2], y + T], [x, z[3], y + T]];
            const U = [[u0, v0], [u0 + du, v0], [u0 + du, v0 + du], [u0, v0 + du]];
            b.quad(P, U, col, [0, 1, 0]);
            const [cu, cv, cd] = this._uv(t, TTDTerrain3D.A.CLIFF);
            const wall = (ax, ay, ha, za, bx, by, hb, zb, n) => {
                if (ha * L >= za && hb * L >= zb) return;
                const wc = [col[0] * 0.8, col[1] * 0.8, col[2] * 0.8];
                b.quad([[ax, ha * L, ay], [bx, hb * L, by], [bx, zb, by], [ax, za, ay]],
                    [[cu, cv + cd], [cu + cd, cv + cd], [cu + cd, cv], [cu, cv]], wc, n);
            };
            wall(x, y, c[0], z[0], x, y + T, c[3], z[3], [-1, 0, 0]);             // NE side (x)
            wall(x, y + T, c[3], z[3], x + T, y + T, c[2], z[2], [0, 0, 1]);      // SE side
            wall(x + T, y + T, c[2], z[2], x + T, y, c[1], z[1], [1, 0, 0]);      // SW side
            wall(x + T, y, c[1], z[1], x, y, c[0], z[0], [0, 0, -1]);             // NW side
            return;
        }
        const pN = [x, c[0] * L + sea * L, y], pW = [x + T, c[1] * L + sea * L, y];
        const pS = [x + T, c[2] * L + sea * L, y + T], pE = [x, c[3] * L + sea * L, y + T];
        const uN = [u0, v0], uW = [u0 + du, v0], uS = [u0 + du, v0 + du], uE = [u0, v0 + du];
        if (m.splitOf(t) === 0) {
            b.tri(pN, pW, pS, uN, uW, uS, col, [0, 1, 0]);
            b.tri(pN, pS, pE, uN, uS, uE, col, [0, 1, 0]);
        } else {
            b.tri(pN, pW, pE, uN, uW, uE, col, [0, 1, 0]);
            b.tri(pW, pS, pE, uW, uS, uE, col, [0, 1, 0]);
        }
    }

    dispose() {
        for (const c of this.chunks) if (c) c.dispose(false, false);
        this.chunks = [];
        if (this.water) this.water.dispose(false, false);
        if (this.material) this.material.dispose(false, false);
        if (this.waterMaterial) this.waterMaterial.dispose(false, false);
        if (this.atlas) this.atlas.dispose();
    }
}

TTDTerrain3D.ATLAS_CELLS = 4;
TTDTerrain3D.CELL_PX = 256;
// Atlas cells.
TTDTerrain3D.A = {
    GRASS: 0, ROUGH: 1, ROCKS: 2, FIELDS: 3,
    SNOW: 4, DESERT: 5, RAINFOREST: 6, DIRT: 7,
    PAVED: 8, SEABED: 9, CLIFF: 10, GRASS_DARK: 11,
    CONCRETE: 12, SHORE: 13, DESERT_DARK: 14, FIELDS2: 15,
};

/**
 * Growing vertex buffers for flat-shaded procedural geometry (terrain chunks, tracks, models).
 * Every triangle gets its own vertices and a face normal; tri() orders the indices so the edge
 * cross product points AGAINST the normal hint — the kit's winding convention (default
 * sideOrientation, back faces culled).
 */
class MeshData {
    constructor() {
        this.pos = [];
        this.nrm = [];
        this.uv = [];
        this.col = [];
        this.idx = [];
    }

    get empty() { return this.idx.length === 0; }

    /** Triangle a, b, c (arrays [x, y, z]); ua.. — UVs; col — [r, g, b]; hint — the outward side. */
    tri(a, b, c, ua, ub, uc, col, hint) {
        const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
        const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
        let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-9) return;
        nx /= len; ny /= len; nz /= len;
        // Outward normal: the face normal turned toward the hint.
        let flip = false;
        if (hint && nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) { nx = -nx; ny = -ny; nz = -nz; flip = true; }
        // Kit convention: cross(b − a, c − a) must point AGAINST the outward normal.
        // cross of (a, b, c) points along the original face normal; if that is the outward one,
        // store as (a, c, b).
        const base = this.pos.length / 3;
        const push = (p, u) => {
            this.pos.push(p[0], p[1], p[2]);
            this.nrm.push(nx, ny, nz);
            this.uv.push(u ? u[0] : 0, u ? u[1] : 0);
            this.col.push(col[0], col[1], col[2], 1);
        };
        push(a, ua); push(b, ub); push(c, uc);
        if (flip) this.idx.push(base, base + 1, base + 2);
        else this.idx.push(base, base + 2, base + 1);
    }

    /** Quad p0..p3 (in order around the face). */
    quad(P, U, col, hint) {
        U = U || [null, null, null, null];
        this.tri(P[0], P[1], P[2], U[0], U[1], U[2], col, hint);
        this.tri(P[0], P[2], P[3], U[0], U[2], U[3], col, hint);
    }

    /**
     * Axis-aligned box rotated by `rot` (rad about the vertical) around (ox, oz), from
     * (x0, y0, z0) to (x1, y1, z1) in local space (y up). Faces: top, bottom (optional), four sides.
     */
    box(x0, y0, z0, x1, y1, z1, col, opts) {
        const o = opts || {};
        const rot = o.rot || 0, ox = o.ox || 0, oz = o.oz || 0, oy = o.oy || 0;
        const cr = Math.cos(rot), sr = Math.sin(rot);
        const P = (x, y, z) => [ox + x * cr - z * sr, oy + y, oz + x * sr + z * cr];
        const R = (n) => [n[0] * cr - n[2] * sr, n[1], n[0] * sr + n[2] * cr];
        const top = o.top || col, side = o.side || [col[0] * 0.86, col[1] * 0.86, col[2] * 0.86];
        this.quad([P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], null, top, R([0, 1, 0]));
        if (o.bottom) this.quad([P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)], null, side, R([0, -1, 0]));
        this.quad([P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0)], null, side, R([0, 0, -1]));
        this.quad([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], null, side, R([0, 0, 1]));
        this.quad([P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)], null, side, R([-1, 0, 0]));
        this.quad([P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0)], null, side, R([1, 0, 0]));
    }

    /**
     * Gable roof over a box footprint: the ridge runs along local x (opts.alongZ — along z) at
     * height y0 + rise.
     */
    roof(x0, z0, x1, z1, y0, rise, col, opts) {
        const o = opts || {};
        const rot = o.rot || 0, ox = o.ox || 0, oz = o.oz || 0, oy = o.oy || 0;
        const cr = Math.cos(rot), sr = Math.sin(rot);
        const P = (x, y, z) => [ox + x * cr - z * sr, oy + y, oz + x * sr + z * cr];
        const R = (n) => [n[0] * cr - n[2] * sr, n[1], n[0] * sr + n[2] * cr];
        const y1 = y0 + rise;
        const gable = o.gable || [col[0] * 0.8, col[1] * 0.8, col[2] * 0.8];
        if (o.alongZ) {
            const xm = (x0 + x1) / 2;
            this.quad([P(x0, y0, z0), P(x0, y0, z1), P(xm, y1, z1), P(xm, y1, z0)], null, col, R([-0.7, 0.7, 0]));
            this.quad([P(x1, y0, z0), P(x1, y0, z1), P(xm, y1, z1), P(xm, y1, z0)], null, col, R([0.7, 0.7, 0]));
            this.tri(P(x0, y0, z0), P(x1, y0, z0), P(xm, y1, z0), null, null, null, gable, R([0, 0, -1]));
            this.tri(P(x0, y0, z1), P(x1, y0, z1), P(xm, y1, z1), null, null, null, gable, R([0, 0, 1]));
            return;
        }
        const zm = (z0 + z1) / 2;
        this.quad([P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, zm), P(x0, y1, zm)], null, col, R([0, 0.7, -0.7]));
        this.quad([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, zm), P(x0, y1, zm)], null, col, R([0, 0.7, 0.7]));
        this.tri(P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, zm), null, null, null, gable, R([-1, 0, 0]));
        this.tri(P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, zm), null, null, null, gable, R([1, 0, 0]));
    }

    /** Vertical cylinder (n sides) centred at (cx, cz), from y0 to y1. */
    cylinder(cx, cz, r, y0, y1, col, n, opts) {
        const o = opts || {};
        const sides = n || 8, top = o.top || col;
        const rTop = o.rTop != null ? o.rTop : r;
        for (let i = 0; i < sides; i++) {
            const a0 = i / sides * Math.PI * 2, a1 = (i + 1) / sides * Math.PI * 2, am = (a0 + a1) / 2;
            const p = (a, rr, y) => [cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr];
            this.quad([p(a0, r, y0), p(a1, r, y0), p(a1, rTop, y1), p(a0, rTop, y1)], null, col, [Math.cos(am), 0, Math.sin(am)]);
            if (rTop > 0.01) this.tri(p(a0, rTop, y1), p(a1, rTop, y1), [cx, y1, cz], null, null, null, top, [0, 1, 0]);
        }
    }

    /** Cone / pyramid (n sides) — tree crowns, spires. */
    cone(cx, cz, r, y0, y1, col, n) {
        const sides = n || 6;
        for (let i = 0; i < sides; i++) {
            const a0 = i / sides * Math.PI * 2, a1 = (i + 1) / sides * Math.PI * 2, am = (a0 + a1) / 2;
            const p = (a) => [cx + Math.cos(a) * r, y0, cz + Math.sin(a) * r];
            this.tri(p(a0), p(a1), [cx, y1, cz], null, null, null, col, [Math.cos(am), 0.5, Math.sin(am)]);
        }
    }

    /** Append another MeshData translated by (dx, dy, dz). */
    append(other, dx, dy, dz) {
        const base = this.pos.length / 3;
        for (let i = 0; i < other.pos.length; i += 3) this.pos.push(other.pos[i] + (dx || 0), other.pos[i + 1] + (dy || 0), other.pos[i + 2] + (dz || 0));
        for (const v of other.nrm) this.nrm.push(v);
        for (const v of other.uv) this.uv.push(v);
        for (const v of other.col) this.col.push(v);
        for (const i of other.idx) this.idx.push(base + i);
    }

    /** @returns {BABYLON.Mesh} */
    toMesh(name, scene) {
        const mesh = new BABYLON.Mesh(name, scene);
        if (!this.idx.length) return mesh;
        const vd = new BABYLON.VertexData();
        vd.positions = this.pos;
        vd.normals = this.nrm;
        vd.uvs = this.uv;
        vd.colors = this.col;
        vd.indices = this.idx;
        vd.applyToMesh(mesh, false);
        return mesh;
    }
}
