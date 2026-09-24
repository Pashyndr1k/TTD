// TTDMap.js — the tile map of the Transport Tycoon Deluxe remake: corner heights, what stands on
// every tile, and the landscape generator. Pure logic (no Babylon): the 3D view reads it, the
// simulation and the construction commands change it and mark chunks dirty for the renderer.
//
// GEOMETRY (as in TTD). The map is W × H tiles; tile (0, 0) is the north corner, x grows toward
// SW, y toward SE. Heights are whole levels 0..MAX_HEIGHT stored at the (W+1) × (H+1) CORNERS.
// Neighbouring corners differ by at most one level (the generator and terraforming keep that),
// so a tile is flat, an incline (one side raised), a one/three-corner slope, or "steep" (the
// diagonal differs by two). Corners of tile (x, y), TTD names:
//     N (x, y)   W (x+1, y)   S (x+1, y+1)   E (x, y+1)
// Edges: NE between N and E (x side), SE between E and S, SW between W and S, NW between N and W.
//
// World coordinates for the 3D view: tile x -> world x = x · TILE, tile y -> world y = y · TILE,
// height = level · LEVEL (px). Game logic works in tiles and levels only (invariant 4).

class GameMap {
    /** @param {number} w @param {number} h tiles */
    constructor(w, h) {
        this.W = w;
        this.H = h;
        this.size = w * h;
        this.CW = w + 1;
        /** Corner heights, (W+1) × (H+1). */
        this.hc = new Uint8Array((w + 1) * (h + 1));
        this.type = new Uint8Array(this.size);         // GameMap.T_*
        this.ground = new Uint8Array(this.size);       // GameMap.G_* (clear land, or the land under trees)
        this.density = new Uint8Array(this.size);      // 0..3: rough/field/snow growth stage
        this.zone = new Uint8Array(this.size);         // GameMap.Z_* (sub-tropical desert / rainforest)
        this.owner = new Uint8Array(this.size).fill(GameMap.OWNER_NONE);
        this.rail = new Uint8Array(this.size);         // track bits (Track.*), T_RAIL / crossing / station
        this.railType = new Uint8Array(this.size);
        this.signals = new Uint16Array(this.size);     // per track: 2 bits (dir A, dir B) — Track.sigBits
        this.road = new Uint8Array(this.size);         // road bits: 1 << DiagDir
        this.roadOwner = new Uint8Array(this.size).fill(GameMap.OWNER_NONE);
        this.treeType = new Uint8Array(this.size);
        this.treeCount = new Uint8Array(this.size);    // 1..4 on T_TREES
        this.obj = new Int32Array(this.size).fill(-1); // house / industry / station / depot / bridge index
        this.sub = new Uint8Array(this.size);          // subtype (station part, depot direction, …)
        this.town = new Int16Array(this.size).fill(-1);// town that owns the road / house
        this.over = new Int32Array(this.size).fill(-1);// bridge (wormhole index) passing above the tile
        this.wz = new Uint8Array(this.size);           // bridge/tunnel head: height of its inner end (deck / tunnel floor)
        this.maxHeight = GameMap.MAX_HEIGHT;
        /** Renderer chunks that changed (index = cy · chunksX + cx). */
        this.dirty = new Set();
        this.chunk = GameMap.CHUNK;
        this.chunksX = Math.ceil(w / this.chunk);
        this.chunksY = Math.ceil(h / this.chunk);
        this.version = 0;
    }

    // --- Indices --------------------------------------------------------------------

    idx(x, y) { return y * this.W + x; }
    tx(t) { return t % this.W; }
    ty(t) { return (t / this.W) | 0; }
    inside(x, y) { return x >= 0 && y >= 0 && x < this.W && y < this.H; }
    /** Inside and not on the one-tile border that TTD keeps as sea/void. */
    valid(x, y) { return x > 0 && y > 0 && x < this.W - 1 && y < this.H - 1; }
    ci(cx, cy) { return cy * this.CW + cx; }
    cornerH(cx, cy) { return this.hc[cy * this.CW + cx]; }

    /** Neighbour tile index in direction d, -1 outside the map. */
    neighbour(t, d) {
        const x = this.tx(t) + Dir.DX[d], y = this.ty(t) + Dir.DY[d];
        return this.inside(x, y) ? y * this.W + x : -1;
    }

    // --- Heights and slopes ------------------------------------------------------------

    /** Corner heights of a tile: [N, W, S, E]. */
    corners(t) {
        const x = this.tx(t), y = this.ty(t), cw = this.CW, i = y * cw + x;
        return [this.hc[i], this.hc[i + 1], this.hc[i + cw + 1], this.hc[i + cw]];
    }

    tileMinZ(t) { const c = this.corners(t); return Math.min(c[0], c[1], c[2], c[3]); }
    tileMaxZ(t) { const c = this.corners(t); return Math.max(c[0], c[1], c[2], c[3]); }

    /** TTD slope bits: W 1, S 2, E 4, N 8 (corner above the lowest), STEEP 16. */
    slope(t) {
        const c = this.corners(t), m = Math.min(c[0], c[1], c[2], c[3]);
        let s = 0;
        if (c[1] > m) s |= GameMap.SLOPE_W;
        if (c[2] > m) s |= GameMap.SLOPE_S;
        if (c[3] > m) s |= GameMap.SLOPE_E;
        if (c[0] > m) s |= GameMap.SLOPE_N;
        if (Math.max(c[0], c[1], c[2], c[3]) - m > 1) s |= GameMap.SLOPE_STEEP;
        return s;
    }

    isFlat(t) { return this.slope(t) === 0; }

    /** Incline along an axis (0 — X: NE↔SW, 1 — Y: NW↔SE); -1 — not an incline. */
    inclineAxis(t) {
        const s = this.slope(t);
        if (s === GameMap.SLOPE_NE || s === GameMap.SLOPE_SW) return 0;
        if (s === GameMap.SLOPE_NW || s === GameMap.SLOPE_SE) return 1;
        return -1;
    }

    /** Heights of the two corners of edge d of a tile. */
    edgeCorners(t, d) {
        const c = this.corners(t);   // N W S E
        switch (d) {
            case Dir.NE: return [c[0], c[3]];
            case Dir.SE: return [c[3], c[2]];
            case Dir.SW: return [c[1], c[2]];
            default: return [c[0], c[1]];   // NW
        }
    }

    /**
     * Height (levels) of a built piece of track/road at edge d of tile t. Flat tile — its
     * level; an incline along the piece's axis — the height of that edge; any other slope — a
     * foundation up to the highest corner (TTD's "build on slopes"). Two pieces connect across
     * an edge only when their edge heights agree.
     */
    pieceEdgeZ(t, d, axis) {
        const s = this.slope(t);
        if (s === 0) return this.tileMinZ(t);
        if (this.inclineAxis(t) === axis && Dir.axis(d) === axis) return this.edgeCorners(t, d)[0];
        return this.tileMaxZ(t);
    }

    // --- Roads on slopes (TTD's CheckRoadSlope / GetRoadFoundation) ---------------------------

    /**
     * Foundation a road with `bits` (1 << DiagDir) needs on tile t: 0 — none (flat, or a straight
     * road along an incline), 1 — levelled (flat top at the highest corner), 2 — inclined (a
     * straight road on a one-corner or steep slope: the tile is raised into an incline along the
     * road), -1 — TTD does not allow these bits on this slope.
     */
    roadFoundation(t, bits) {
        const s = this.slope(t);
        if (s === 0) return 0;
        const straight = bits === GameMap.ROAD_X || bits === GameMap.ROAD_Y;
        if (s & GameMap.SLOPE_STEEP) return straight ? 2 : -1;
        if ((bits & ~GameMap.ROAD_ON_SLOPE[s]) === 0) return 0;
        if ((bits & ~GameMap.ROAD_ON_FOUNDATION[s]) === 0) return 1;
        if (straight && (s === GameMap.SLOPE_W || s === GameMap.SLOPE_S || s === GameMap.SLOPE_E || s === GameMap.SLOPE_N)) return 2;
        return -1;
    }

    /**
     * TTD's CheckRoadSlope: may `pieces` be added to the `existing` road bits of tile t? Returns
     * null if the land is sloped the wrong way, else { pieces, found }: pieces as TTD completes
     * them (a half road on an incline or a one-corner slope becomes the full straight road) and
     * found — a new foundation is paid for (the terraform price).
     */
    roadSlopeCheck(t, pieces, existing) {
        const s = this.slope(t);
        const full = (p) => p | ((p & 3) << 2) | ((p & 12) >> 2);   // NE<->SW, SE<->NW
        if (s & GameMap.SLOPE_STEEP) {
            if (existing) return null;
            pieces = full(pieces);
            return pieces === GameMap.ROAD_X || pieces === GameMap.ROAD_Y ? { pieces, found: true } : null;
        }
        const all = pieces | existing;
        if ((all & ~GameMap.ROAD_ON_SLOPE[s]) === 0) {
            if (s) pieces |= GameMap.ROAD_ON_SLOPE[s];
            return { pieces, found: false };
        }
        if ((all & ~GameMap.ROAD_ON_FOUNDATION[s]) === 0) return { pieces, found: !existing };
        if (!existing && (s === GameMap.SLOPE_W || s === GameMap.SLOPE_S || s === GameMap.SLOPE_E || s === GameMap.SLOPE_N)) {
            pieces = full(pieces);
            if (pieces === GameMap.ROAD_X || pieces === GameMap.ROAD_Y) return { pieces, found: true };
        }
        return null;
    }

    /**
     * Height (levels) of the road end at edge d of road tile t: levelled — the top of the
     * foundation; otherwise the higher corner of that edge (a flat tile, an incline, or the raised
     * end of an inclined foundation).
     */
    roadEdgeZ(t, d) {
        const f = this.roadFoundation(t, this.road[t]);
        if (f === 1 || f < 0) return this.tileMaxZ(t);
        const e = this.edgeCorners(t, d);
        return Math.max(e[0], e[1]);
    }

    /**
     * Heights of the built surface's corners [N, W, S, E] of a road tile with a foundation, or
     * null — the road lies on the natural ground.
     */
    roadTop(t) {
        const f = this.roadFoundation(t, this.road[t]);
        if (f === 0) return null;
        if (f !== 2) { const z = this.tileMaxZ(t); return [z, z, z, z]; }
        if (this.road[t] === GameMap.ROAD_X) {
            const ne = this.roadEdgeZ(t, Dir.NE), sw = this.roadEdgeZ(t, Dir.SW);
            return [ne, sw, sw, ne];
        }
        const nw = this.roadEdgeZ(t, Dir.NW), se = this.roadEdgeZ(t, Dir.SE);
        return [nw, nw, se, se];
    }

    /** Roadside of a road tile (GameMap.RS_*), kept in the low bits of density. */
    roadside(t) { return this.density[t] & 7; }
    setRoadside(t, rs) { this.density[t] = (this.density[t] & ~7) | rs; }
    /** Road works counter (0 — none, 1..15 — in progress), the high bits of density. */
    roadWorks(t) { return this.type[t] === GameMap.T_ROAD && this.sub[t] === 0 ? this.density[t] >> 4 : 0; }
    setRoadWorks(t, n) { this.density[t] = (this.density[t] & 15) | (n << 4); }

    /** Height of the flat top of a building/station/depot on the tile (foundation on a slope). */
    buildZ(t) { return this.isFlat(t) ? this.tileMinZ(t) : this.tileMaxZ(t); }

    /** Foundation needed for a piece along axis (or a building: axis -1). */
    needsFoundation(t, axis) {
        const s = this.slope(t);
        if (s === 0) return false;
        return !(axis >= 0 && this.inclineAxis(t) === axis);
    }

    /**
     * The diagonal the tile is split along — the same for the mesh and for heightAt:
     * 0 — N–S, 1 — W–E. A one-corner slope folds along the diagonal that does not touch the
     * odd corner, like TTD's sprites.
     */
    splitOf(t) {
        const c = this.corners(t);
        if (c[1] === c[3] && c[0] !== c[2]) return 1;
        return 0;
    }

    /** Ground height (levels, fractional) at a tile-space point — natural terrain, no foundations. */
    groundZ(fx, fy) {
        const x = Math.max(0, Math.min(this.W - 1e-6, fx)), y = Math.max(0, Math.min(this.H - 1e-6, fy));
        const ix = Math.floor(x), iy = Math.floor(y), u = x - ix, v = y - iy;
        const t = iy * this.W + ix;
        const c = this.corners(t);   // N(0,0) W(1,0) S(1,1) E(0,1)
        if (this.splitOf(t) === 0) {
            // Diagonal N(0,0)–S(1,1): triangles N-W-S (u >= v) and N-S-E.
            if (u >= v) return c[0] + (c[1] - c[0]) * u + (c[2] - c[1]) * v;
            return c[0] + (c[3] - c[0]) * v + (c[2] - c[3]) * u;
        }
        // Diagonal W(1,0)–E(0,1): triangles N-W-E (u + v <= 1) and W-S-E.
        if (u + v <= 1) return c[0] + (c[1] - c[0]) * u + (c[3] - c[0]) * v;
        return c[2] + (c[3] - c[2]) * (1 - u) + (c[1] - c[2]) * (1 - v);
    }

    // --- Dirty tracking for the renderer ------------------------------------------

    markDirty(t) {
        const x = this.tx(t), y = this.ty(t), n = this.chunk;
        this.dirty.add(((y / n) | 0) * this.chunksX + ((x / n) | 0));
        // A tile at a chunk edge also changes the neighbouring chunk's seams (heights, foundations).
        if (x % n === 0 && x > 0) this.dirty.add(((y / n) | 0) * this.chunksX + ((x / n) | 0) - 1);
        if (y % n === 0 && y > 0) this.dirty.add((((y / n) | 0) - 1) * this.chunksX + ((x / n) | 0));
        this.version++;
    }

    markAllDirty() {
        for (let i = 0; i < this.chunksX * this.chunksY; i++) this.dirty.add(i);
        this.version++;
    }

    // --- Simple tile queries ---------------------------------------------------------

    isWater(t) { return this.type[t] === GameMap.T_WATER; }

    /** Tile that can be cleared or built on (grass, rough, rocks, fields, desert, trees). */
    isClearable(t) {
        const k = this.type[t];
        return k === GameMap.T_CLEAR || k === GameMap.T_TREES;
    }

    /** Clear land without trees. */
    setClear(t, ground) {
        this.type[t] = GameMap.T_CLEAR;
        if (ground != null) this.ground[t] = ground;
        this.treeCount[t] = 0;
        this.obj[t] = -1;
        this.sub[t] = 0;
        this.rail[t] = 0;
        this.road[t] = 0;
        this.signals[t] = 0;
        this.owner[t] = GameMap.OWNER_NONE;
        this.roadOwner[t] = GameMap.OWNER_NONE;
        this.town[t] = -1;
        this.density[t] = 0;
        this.markDirty(t);
    }

    // --- Terraforming ----------------------------------------------------------------

    /**
     * Raise (+1) or lower (−1) the corner (cx, cy) and whatever neighbours must follow so that
     * adjacent corners stay within one level. Returns the list of changed corners or null when
     * the change is impossible (map edge, height limit, a tile that cannot move is touched).
     * canChange(t) decides whether a tile may change shape (clear land, trees, water edge).
     */
    planTerraform(cx, cy, dir, canChange) {
        return this.planTerraformCorners([[cx, cy]], dir, canChange);
    }

    /** planTerraform for several corners moved together (TTD's terraform of a tile's corners). */
    planTerraformCorners(list, dir, canChange) {
        const cw = this.CW, changed = new Map();
        const queue = list.map(([cx, cy]) => [cx, cy, this.hc[cy * cw + cx] + dir]);
        while (queue.length) {
            const [x, y, h] = queue.pop();
            if (x <= 0 || y <= 0 || x >= this.W || y >= this.H) return null;   // edge corners stay at sea level
            if (h < 0 || h > this.maxHeight) return null;
            const k = y * cw + x;
            const cur = changed.has(k) ? changed.get(k) : this.hc[k];
            if (dir > 0 ? cur >= h : cur <= h) continue;
            changed.set(k, h);
            for (let d = 0; d < 4; d++) {
                const nx = x + Dir.DX[d], ny = y + Dir.DY[d];
                if (nx < 0 || ny < 0 || nx > this.W || ny > this.H) continue;
                const nk = ny * cw + nx, nh = changed.has(nk) ? changed.get(nk) : this.hc[nk];
                if (dir > 0 && nh < h - 1) queue.push([nx, ny, h - 1]);
                if (dir < 0 && nh > h + 1) queue.push([nx, ny, h + 1]);
            }
        }
        // Every tile touching a changed corner must allow it.
        const tiles = new Set();
        for (const k of changed.keys()) {
            const x = k % cw, y = (k / cw) | 0;
            for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
                const tx = x + ox, ty = y + oy;
                if (this.inside(tx, ty)) tiles.add(ty * this.W + tx);
            }
        }
        for (const t of tiles) if (canChange && !canChange(t)) return null;
        return { corners: [...changed.entries()], tiles: [...tiles] };
    }

    /** Apply a plan from planTerraform. */
    applyTerraform(plan) {
        for (const [k, h] of plan.corners) this.hc[k] = h;
        for (const t of plan.tiles) {
            // Land that sank to sea level next to the sea floods; raised water becomes land.
            if (this.type[t] === GameMap.T_WATER && this.tileMaxZ(t) > 0) this.setClear(t, GameMap.G_GRASS);
            this.markDirty(t);
        }
    }

    // --- Generation ------------------------------------------------------------------

    /**
     * Landscape: heights, sea, zones, ground, trees. opts: { seed, climate, terrain (0..3 —
     * very flat .. mountainous), sea (0..3 — very low .. high), smooth (0..3) }.
     */
    generate(opts) {
        const o = opts || {};
        const rng = new Rng((o.seed >>> 0) ^ 0x51ab);
        const noise = new SimplexNoise(String(o.seed >>> 0));
        const W = this.W, H = this.H, cw = this.CW;
        const terrain = IMath.clamp(o.terrain == null ? 2 : o.terrain, 0, 3);
        const maxH = [4, 7, 11, 15][terrain];
        const seaFrac = [0.04, 0.12, 0.2, 0.3][IMath.clamp(o.sea == null ? 1 : o.sea, 0, 3)];
        const rough = [0.55, 0.6, 0.68, 0.75][IMath.clamp(o.smooth == null ? 1 : o.smooth, 0, 3)];
        // Feature size scales with the map but stays TTD-like (hills ~20–40 tiles).
        const base = 34 + Math.min(W, H) * 0.06;

        const field = new Float32Array(cw * (H + 1));
        let lo = Infinity, hi = -Infinity;
        for (let y = 0; y <= H; y++) {
            for (let x = 0; x <= W; x++) {
                let amp = 1, freq = 1 / base, n = 0, norm = 0;
                for (let oct = 0; oct < 5; oct++) {
                    n += noise.noise2D(x * freq + oct * 31.7, y * freq - oct * 17.3) * amp;
                    norm += amp;
                    amp *= rough;
                    freq *= 2;
                }
                n /= norm;
                // Fade to sea at the map border so the edge is water, like TTD's maps.
                const ex = Math.min(x, W - x), ey = Math.min(y, H - y), edge = Math.min(ex, ey);
                const fade = Math.min(1, edge / 6);
                n = n * fade - (1 - fade) * 0.6;
                field[y * cw + x] = n;
                if (n < lo) lo = n;
                if (n > hi) hi = n;
            }
        }
        // Sea level: the given fraction of the corners ends up at level 0.
        const sorted = Array.from(field).sort((a, b) => a - b);
        const cut = sorted[Math.floor(seaFrac * (sorted.length - 1))];
        for (let k = 0; k < field.length; k++) {
            const v = (field[k] - cut) / Math.max(1e-6, hi - cut);
            // A soft curve: plains near the sea, peaks rarer (TTD's TGP has similar distributions).
            this.hc[k] = v <= 0 ? 0 : IMath.clamp(Math.round(Math.pow(v, 1.35) * maxH + 0.4), 1, maxH);
        }
        for (let x = 0; x <= W; x++) { this.hc[x] = 0; this.hc[H * cw + x] = 0; }
        for (let y = 0; y <= H; y++) { this.hc[y * cw] = 0; this.hc[y * cw + W] = 0; }
        GameMap.limitSlopes(this.hc, cw, H + 1);

        // Tiles: water at sea level, land elsewhere.
        const tropic = o.climate === 1;
        const moist = new SimplexNoise(String((o.seed >>> 0) + 7));
        for (let t = 0; t < this.size; t++) {
            const x = t % W, y = (t / W) | 0;
            this.obj[t] = -1;
            if (this.tileMaxZ(t) === 0) {
                this.type[t] = GameMap.T_WATER;
                this.ground[t] = GameMap.G_GRASS;
                this.owner[t] = GameMap.OWNER_WATER;
            } else {
                this.type[t] = GameMap.T_CLEAR;
                this.ground[t] = GameMap.G_GRASS;
                this.density[t] = 3;
            }
            if (!this.valid(x, y) && this.type[t] !== GameMap.T_WATER) {
                this.type[t] = GameMap.T_WATER;
                this.owner[t] = GameMap.OWNER_WATER;
            }
        }
        if (tropic) this._makeZones(moist);
        // Rough land and rocks scattered like TTD's generator.
        for (let t = 0; t < this.size; t++) {
            if (this.type[t] !== GameMap.T_CLEAR) continue;
            if (this.zone[t] === GameMap.Z_DESERT) { this.ground[t] = GameMap.G_DESERT; continue; }
            const r = rng.int(1000);
            if (r < 12) this.ground[t] = GameMap.G_ROCKS;
            else if (r < 60) this.ground[t] = GameMap.G_ROUGH;
        }
        this._plantForests(rng, moist, tropic);
        this.markAllDirty();
    }

    /**
     * Keep neighbouring corners within one level: h(c) <- min over c' of h(c') + |c − c'|₁.
     * Two passes of a chamfer distance transform give the exact result; it only lowers.
     */
    static limitSlopes(hc, cw, ch) {
        for (let y = 0; y < ch; y++) {
            for (let x = 0; x < cw; x++) {
                const k = y * cw + x;
                if (x > 0 && hc[k] > hc[k - 1] + 1) hc[k] = hc[k - 1] + 1;
                if (y > 0 && hc[k] > hc[k - cw] + 1) hc[k] = hc[k - cw] + 1;
            }
        }
        for (let y = ch - 1; y >= 0; y--) {
            for (let x = cw - 1; x >= 0; x--) {
                const k = y * cw + x;
                if (x < cw - 1 && hc[k] > hc[k + 1] + 1) hc[k] = hc[k + 1] + 1;
                if (y < ch - 1 && hc[k] > hc[k + cw] + 1) hc[k] = hc[k + cw] + 1;
            }
        }
    }

    /** Sub-tropical zones: desert far from water and low, rainforest in wet highlands. */
    _makeZones(moist) {
        const W = this.W, H = this.H;
        // Distance to water (tiles, Chebyshev), capped.
        const dist = new Uint8Array(this.size).fill(255);
        const q = [];
        for (let t = 0; t < this.size; t++) if (this.type[t] === GameMap.T_WATER) { dist[t] = 0; q.push(t); }
        for (let i = 0; i < q.length; i++) {
            const t = q[i], x = t % W, y = (t / W) | 0, d = dist[t] + 1;
            if (d > 20) continue;
            for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
                const nx = x + ox, ny = y + oy;
                if (!this.inside(nx, ny)) continue;
                const n = ny * W + nx;
                if (dist[n] > d) { dist[n] = d; q.push(n); }
            }
        }
        for (let t = 0; t < this.size; t++) {
            if (this.type[t] === GameMap.T_WATER) continue;
            const x = t % W, y = (t / W) | 0, h = this.tileMaxZ(t);
            const m = moist.noise2D(x / 40, y / 40) * 0.7 + moist.noise2D(x / 13 + 5, y / 13 - 3) * 0.3;
            if (dist[t] > 7 && h <= 6 && m < 0.25) this.zone[t] = GameMap.Z_DESERT;
            else if ((m > 0.2 && h >= 3) || (m > 0.45)) this.zone[t] = GameMap.Z_RAINFOREST;
            else this.zone[t] = GameMap.Z_NORMAL;
        }
    }

    /** Forests in noise clusters; tropic: dense rainforest, cacti in the desert. */
    _plantForests(rng, moist, tropic) {
        const W = this.W;
        for (let t = 0; t < this.size; t++) {
            if (this.type[t] !== GameMap.T_CLEAR || this.ground[t] === GameMap.G_ROCKS) continue;
            const x = t % W, y = (t / W) | 0;
            const f = moist.noise2D(x / 11 + 40, y / 11 - 40);
            let p;
            if (tropic && this.zone[t] === GameMap.Z_RAINFOREST) p = 0.25 + f * 0.5;
            else if (tropic && this.zone[t] === GameMap.Z_DESERT) p = 0.015;
            else p = f > 0.25 ? 0.55 : f > 0 ? 0.12 : 0.03;
            if (rng.float() < p) this.plantTree(t, rng, tropic);
        }
    }

    /** Put 1..4 trees of a climate-appropriate type on clear land. */
    plantTree(t, rng, tropic) {
        const z = this.zone[t];
        let type;
        if (tropic) type = z === GameMap.Z_DESERT ? GameMap.TREE_CACTUS : z === GameMap.Z_RAINFOREST ? GameMap.TREE_JUNGLE : GameMap.TREE_PALM;
        else type = rng.chance(1, 2) ? GameMap.TREE_CONIFER : GameMap.TREE_DECIDUOUS;
        this.type[t] = GameMap.T_TREES;
        this.treeType[t] = type;
        this.treeCount[t] = type === GameMap.TREE_CACTUS ? 1 : rng.range(1, 4);
        this.markDirty(t);
    }

    // --- Save / load -------------------------------------------------------------------

    static ARRAYS = ['hc', 'type', 'ground', 'density', 'zone', 'owner', 'rail', 'railType', 'signals', 'road',
        'roadOwner', 'treeType', 'treeCount', 'obj', 'sub', 'town', 'over', 'wz'];

    toJSON() {
        const out = { W: this.W, H: this.H };
        for (const k of GameMap.ARRAYS) out[k] = GameMap.encode(this[k]);
        return out;
    }

    static fromJSON(o) {
        const m = new GameMap(o.W, o.H);
        for (const k of GameMap.ARRAYS) if (o[k]) GameMap.decode(o[k], m[k]);
        m.markAllDirty();
        return m;
    }

    /** Typed array -> base64 of its bytes. */
    static encode(arr) {
        const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
        return typeof btoa !== 'undefined' ? btoa(s) : /** @type {any} */ (globalThis).Buffer.from(s, 'binary').toString('base64');
    }

    static decode(str, into) {
        const s = typeof atob !== 'undefined' ? atob(str) : /** @type {any} */ (globalThis).Buffer.from(str, 'base64').toString('binary');
        const bytes = new Uint8Array(into.buffer, into.byteOffset, into.byteLength);
        for (let i = 0; i < bytes.length && i < s.length; i++) bytes[i] = s.charCodeAt(i);
    }
}

// Tile types (TTD's MP_*).
GameMap.T_CLEAR = 0;
GameMap.T_RAIL = 1;        // track, or a rail depot (sub = 1)
GameMap.T_ROAD = 2;        // road, level crossing (sub = 1), road depot (sub = 2)
GameMap.T_HOUSE = 3;
GameMap.T_TREES = 4;
GameMap.T_STATION = 5;     // any station part; sub = GameMap.ST_*
GameMap.T_WATER = 6;       // sea; sub = 1 — ship depot
GameMap.T_INDUSTRY = 7;
GameMap.T_TUNBRIDGE = 8;   // bridge head or tunnel portal; obj = wormhole index
GameMap.T_OBJECT = 9;      // statue, company HQ, transmitter, lighthouse

GameMap.RAIL_SUB_DEPOT = 1;
GameMap.ROAD_SUB_CROSSING = 1;
GameMap.ROAD_SUB_DEPOT = 2;
GameMap.WATER_SUB_DEPOT = 1;

// Station parts (sub on T_STATION).
GameMap.ST_RAIL = 0;       // platform along axis (rail bits give the axis)
GameMap.ST_BUS = 1;
GameMap.ST_TRUCK = 2;
GameMap.ST_AIRPORT = 3;
GameMap.ST_DOCK = 4;
GameMap.ST_OILRIG = 5;

// Clear ground (TTD's CLEAR_*), also the ground under trees.
GameMap.G_GRASS = 0;
GameMap.G_ROUGH = 1;
GameMap.G_ROCKS = 2;
GameMap.G_FIELDS = 3;
GameMap.G_SNOW = 4;
GameMap.G_DESERT = 5;

// Sub-tropical zones.
GameMap.Z_NORMAL = 0;
GameMap.Z_DESERT = 1;
GameMap.Z_RAINFOREST = 2;

// Trees.
GameMap.TREE_DECIDUOUS = 0;
GameMap.TREE_CONIFER = 1;
GameMap.TREE_PALM = 2;
GameMap.TREE_JUNGLE = 3;
GameMap.TREE_CACTUS = 4;

// Owners.
GameMap.OWNER_NONE = 255;
GameMap.OWNER_TOWN = 254;
GameMap.OWNER_WATER = 253;

// Slopes (TTD's Slope enum).
GameMap.SLOPE_W = 1;
GameMap.SLOPE_S = 2;
GameMap.SLOPE_E = 4;
GameMap.SLOPE_N = 8;
GameMap.SLOPE_STEEP = 16;
GameMap.SLOPE_NE = GameMap.SLOPE_N | GameMap.SLOPE_E;   // raised NE edge: rises toward NE
GameMap.SLOPE_SW = GameMap.SLOPE_S | GameMap.SLOPE_W;
GameMap.SLOPE_NW = GameMap.SLOPE_N | GameMap.SLOPE_W;
GameMap.SLOPE_SE = GameMap.SLOPE_S | GameMap.SLOPE_E;

// Road bits (1 << DiagDir): straight roads.
GameMap.ROAD_X = 5;        // NE | SW
GameMap.ROAD_Y = 10;       // SE | NW
GameMap.ROAD_ALL = 15;
// TTD's _valid_tileh_slopes_road, by slope (non-steep): road bits allowed on the bare slope, and
// with a levelled foundation. NE 1, SE 2, SW 4, NW 8.
GameMap.ROAD_ON_SLOPE = [15, 0, 0, 5, 0, 0, 10, 0, 0, 10, 0, 0, 5, 0, 0];
GameMap.ROAD_ON_FOUNDATION = [0, 4 | 8, 4 | 2, 10 | 4, 2 | 1, 15, 5 | 2, 15, 8 | 1, 5 | 8, 15, 15, 10 | 1, 15, 15];
// Roadside (TTD's Roadside): what lines a road; the tile loop sets it by the town zone.
GameMap.RS_BARREN = 0;
GameMap.RS_GRASS = 1;
GameMap.RS_PAVED = 2;
GameMap.RS_LIGHTS = 3;
GameMap.RS_TREES = 4;

GameMap.MAX_HEIGHT = 15;
GameMap.CHUNK = 16;        // tiles per renderer chunk side
