// TTDTrack.js — track and road geometry of the TTD remake: which tile edges a piece joins, where
// a vehicle stands at a given distance along it, and path finding over rails, roads and water.
// Pure logic on GameMap; vehicles (TTDVehicle.js) move along the "steps" produced here.
//
// TRACKS (TTD's Track enum): six pieces per tile, each joining two edges (DiagDir):
//   X     NE–SW  (straight along x)     Y     NW–SE  (straight along y)
//   UPPER NE–NW  (N corner)             LOWER SE–SW  (S corner)
//   LEFT  SW–NW  (W corner)             RIGHT NE–SE  (E corner)
// A "trackdir" is a track travelled from one of its edges to the other: td = track * 2 + rev,
// rev 0 — from EDGES[track][0] to EDGES[track][1].
//
// ROADS: road bits are 1 << DiagDir — half-tile pieces from the centre to that edge. A road
// vehicle crossing a tile goes from its entry edge to an exit edge (straight, a turn, or a
// U-turn at a dead end), keeping to the right-hand lane.
//
// Heights of a piece's ends come from GameMap.pieceEdgeZ; two pieces connect across an edge only
// if both ends are at the same height (a foundation next to an incline does not join).

/** @satisfies {Record<string, any>} */
const Track = {
    X: 0, Y: 1, UPPER: 2, LOWER: 3, LEFT: 4, RIGHT: 5,
    NAMES: ['X', 'Y', 'upper', 'lower', 'left', 'right'],
    /** Edges joined by each track. */
    EDGES: [[Dir.NE, Dir.SW], [Dir.SE, Dir.NW], [Dir.NE, Dir.NW], [Dir.SE, Dir.SW], [Dir.SW, Dir.NW], [Dir.NE, Dir.SE]],
    /** Axis of a straight track (0 X, 1 Y), -1 for diagonal pieces. */
    AXIS: [0, 1, -1, -1, -1, -1],
    /** Edge midpoints in tile-local (u along x, v along y). */
    MID: [[0, 0.5], [0.5, 1], [1, 0.5], [0.5, 0]],

    bit(track) { return 1 << track; },

    /** Trackdir of `track` entered through edge `from`; -1 if the track does not touch it. */
    tdFrom(track, from) {
        const e = Track.EDGES[track];
        return e[0] === from ? track * 2 : e[1] === from ? track * 2 + 1 : -1;
    },
    tdTrack(td) { return td >> 1; },
    tdEntry(td) { const e = Track.EDGES[td >> 1]; return (td & 1) ? e[1] : e[0]; },
    tdExit(td) { const e = Track.EDGES[td >> 1]; return (td & 1) ? e[0] : e[1]; },
    tdReverse(td) { return td ^ 1; },
    /** Length of a piece in tiles. */
    length(track) { return track < 2 ? 1 : Math.SQRT1_2; },

    /** Unit direction (tile space) of a trackdir. */
    tdVector(td) {
        const a = Track.MID[Track.tdEntry(td)], b = Track.MID[Track.tdExit(td)];
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
        return [dx / l, dy / l];
    },

    /**
     * Height (levels) of a piece's end at edge d of tile t. Bridge and tunnel heads: the inner end
     * (toward the other head) is at the deck / tunnel floor height stored in map.wz.
     */
    edgeZ(map, t, d, axis) {
        const k = map.type[t];
        if (k === GameMap.T_TUNBRIDGE && map.density[t] === d) return map.wz[t];
        // Plain track and level crossings: TTD's foundations put every piece end at the higher
        // corner of its edge (GameMap.railFoundation).
        if ((k === GameMap.T_RAIL && map.sub[t] === 0) || (k === GameMap.T_ROAD && map.sub[t] === GameMap.ROAD_SUB_CROSSING)) return map.edgeMaxZ(t, d);
        return map.pieceEdgeZ(t, d, axis);
    },

    // --- Curves -------------------------------------------------------------------------

    /**
     * Does the line of `kind` ('rail' | 'road') leave edge e of tile t straight along the chord
     * direction (vx, vy)? Yes when a corner piece across the edge continues the diagonal, or
     * nothing joins there at all (a loose end stays straight); no when a straight piece or a
     * turning corner joins — then the piece bends into it.
     */
    continuesDiagonal(map, t, e, vx, vy, kind) {
        const n = map.neighbour(t, e);
        if (n < 0) return true;
        const r = Dir.reverse(e), mr = Track.MID[r];
        const same = (f) => {
            const mf = Track.MID[f];
            return Math.abs(mf[0] - mr[0] - vx) < 1e-6 && Math.abs(mf[1] - mr[1] - vy) < 1e-6;
        };
        if (kind === 'rail') {
            const bits = Track.railBits(map, n);
            let joined = false;
            for (let tr = 0; tr < 6; tr++) {
                if (!(bits & (1 << tr))) continue;
                const E = Track.EDGES[tr];
                if (E[0] !== r && E[1] !== r) continue;
                if (tr >= 2 && same(E[0] === r ? E[1] : E[0])) return true;
                joined = true;
            }
            return !joined;
        }
        const bits = Track.roadBits(map, n);
        if (!(bits & (1 << r))) return true;
        for (let f = 0; f < 4; f++) if (f !== r && (f ^ r) !== 2 && bits === ((1 << r) | (1 << f)) && same(f)) return true;
        return false;
    },

    /**
     * Centre line of a corner piece of tile t travelled from edge a to edge b (perpendicular):
     * a cubic Bézier [P0, P1, P2, P3] in tile-local units. Joining straight pieces it is a quarter
     * circle — a curve; inside a diagonal line of corner pieces it is the straight chord, so the
     * line looks straight (TTD's diagonal track, and road zig-zags drawn as a diagonal road).
     */
    curve(map, t, a, b, kind) {
        const A = Track.MID[a], B = Track.MID[b];
        const cx = B[0] - A[0], cy = B[1] - A[1], cl = Math.hypot(cx, cy);
        const ux = cx / cl, uy = cy / cl;
        // Tangent at a (into the tile) and at b (out of it).
        let ta = [0.5 - A[0], 0.5 - A[1]], tb = [B[0] - 0.5, B[1] - 0.5];
        if (Track.continuesDiagonal(map, t, a, -cx, -cy, kind)) ta = [ux, uy];
        if (Track.continuesDiagonal(map, t, b, cx, cy, kind)) tb = [ux, uy];
        const na = Math.hypot(ta[0], ta[1]), nb = Math.hypot(tb[0], tb[1]), k = 0.26;
        return [A, [A[0] + ta[0] / na * k, A[1] + ta[1] / na * k], [B[0] - tb[0] / nb * k, B[1] - tb[1] / nb * k], B];
    },

    /** Point and derivative of a Bézier from Track.curve at f. */
    bezier(P, f) {
        const u = 1 - f;
        const x = u * u * u * P[0][0] + 3 * u * u * f * P[1][0] + 3 * u * f * f * P[2][0] + f * f * f * P[3][0];
        const y = u * u * u * P[0][1] + 3 * u * u * f * P[1][1] + 3 * u * f * f * P[2][1] + f * f * f * P[3][1];
        const dx = 3 * u * u * (P[1][0] - P[0][0]) + 6 * u * f * (P[2][0] - P[1][0]) + 3 * f * f * (P[3][0] - P[2][0]);
        const dy = 3 * u * u * (P[1][1] - P[0][1]) + 6 * u * f * (P[2][1] - P[1][1]) + 3 * f * f * (P[3][1] - P[2][1]);
        return { x, y, dx, dy };
    },

    /** Two trackdirs one after another turn by at most 45° (TTD forbids 90° turns). */
    smooth(td1, td2) {
        const a = Track.tdVector(td1), b = Track.tdVector(td2);
        return a[0] * b[0] + a[1] * b[1] > 0.5;
    },

    /** Tracks of a straight axis: 0 -> X, 1 -> Y. */
    axisTrack(axis) { return axis === 0 ? Track.X : Track.Y; },

    /**
     * Point at distance s (tiles) along trackdir td of tile t: { x, y, z } in tile units/levels
     * and the heading (rad). z follows the piece's end heights.
     */
    pointOn(map, t, td, s) {
        const tr = td >> 1, a = Track.MID[Track.tdEntry(td)], b = Track.MID[Track.tdExit(td)];
        const len = Track.length(tr), f = Math.max(0, Math.min(1, s / len));
        const axis = Track.AXIS[tr];
        const za = Track.edgeZ(map, t, Track.tdEntry(td), axis), zb = Track.edgeZ(map, t, Track.tdExit(td), axis);
        if (tr >= 2) {
            // Corner pieces follow the drawn curve (Track.curve).
            const c = Track.bezier(Track.curve(map, t, Track.tdEntry(td), Track.tdExit(td), 'rail'), f);
            return { x: map.tx(t) + c.x, y: map.ty(t) + c.y, z: za + (zb - za) * f, heading: Math.atan2(c.dy, c.dx), grade: (zb - za) / len };
        }
        const x = map.tx(t) + a[0] + (b[0] - a[0]) * f, y = map.ty(t) + a[1] + (b[1] - a[1]) * f;
        return { x, y, z: za + (zb - za) * f, heading: Math.atan2(b[1] - a[1], b[0] - a[0]), grade: (zb - za) / len };
    },

    // --- Rail connectivity -------------------------------------------------------

    /** Track bits a tile offers to trains (plain track, crossing, platform, depot, bridge/tunnel head). */
    railBits(map, t) {
        const k = map.type[t];
        if (k === GameMap.T_RAIL || k === GameMap.T_TUNBRIDGE) return map.rail[t];
        if (k === GameMap.T_ROAD && map.sub[t] === GameMap.ROAD_SUB_CROSSING) return map.rail[t];
        if (k === GameMap.T_STATION && map.sub[t] === GameMap.ST_RAIL) return map.rail[t];
        return 0;
    },

    /** Height of the end of a rail piece at edge d (for joining checks). */
    railEdgeZ(map, t, track, d) {
        return Track.edgeZ(map, t, d, Track.AXIS[track]);
    },

    /**
     * Trackdirs a train can take after leaving tile t through edge `exit` at height z:
     * pieces of the neighbour that touch the opposite edge at the same height, and whose
     * rail type the train may use. The wormhole (bridge/tunnel) jump is handled by World.
     */
    railNext(map, t, exit, z, railOk) {
        const n = map.neighbour(t, exit);
        if (n < 0) return { tile: -1, tds: [] };
        const bits = Track.railBits(map, n);
        if (!bits) return { tile: n, tds: [] };
        if (railOk && !railOk(map.railType[n])) return { tile: n, tds: [] };
        const from = Dir.reverse(exit), out = [];
        for (let tr = 0; tr < 6; tr++) {
            if (!(bits & (1 << tr))) continue;
            const td = Track.tdFrom(tr, from);
            if (td < 0) continue;
            if (Track.railEdgeZ(map, n, tr, from) !== z) continue;
            out.push(td);
        }
        return { tile: n, tds: out };
    },

    // --- Roads ------------------------------------------------------------------

    /** Road bits a tile offers (road, crossing, road stop, depot entrance, bridge/tunnel head). */
    roadBits(map, t) {
        const k = map.type[t];
        if (k === GameMap.T_ROAD || k === GameMap.T_TUNBRIDGE) return map.road[t];
        if (k === GameMap.T_STATION && (map.sub[t] === GameMap.ST_BUS || map.sub[t] === GameMap.ST_TRUCK)) return map.road[t];
        return 0;
    },

    /**
     * Height of a road end at edge d. Plain road: TTD's foundations (GameMap.roadEdgeZ); a depot
     * sits on a levelled foundation; stops and bridge heads: a straight road along an incline
     * follows it.
     */
    roadEdgeZ(map, t, d) {
        if (map.type[t] === GameMap.T_ROAD) {
            if (map.sub[t] === 0) return map.roadEdgeZ(t, d);
            if (map.sub[t] === GameMap.ROAD_SUB_DEPOT) return map.buildZ(t);
        }
        const bits = map.road[t];
        const straight = bits === 5 || bits === 10 || bits === 1 || bits === 4 || bits === 2 || bits === 8;
        const axis = straight ? (bits & 5 ? 0 : 1) : -1;
        return Track.edgeZ(map, t, d, axis);
    },

    /** Can a road vehicle go from tile t through edge d into the neighbour? */
    roadConnects(map, t, d) {
        if (!(Track.roadBits(map, t) & (1 << d))) return -1;
        const n = map.neighbour(t, d);
        if (n < 0) return -1;
        const from = Dir.reverse(d);
        if (!(Track.roadBits(map, n) & (1 << from))) return -1;
        if (Track.roadEdgeZ(map, t, d) !== Track.roadEdgeZ(map, n, from)) return -1;
        if (map.roadWorks(n)) return -1;   // TTD: a tile under road works is closed to traffic
        return n;
    },

    /**
     * Point on a road vehicle's path across a tile from edge `a` to edge `b` (b === a — U-turn),
     * at fraction f 0..1, right-hand lane. Returns tile-space { x, y } and the heading.
     */
    roadPoint(map, t, a, b, f, lane) {
        const off = lane == null ? 0.17 : lane;
        const x0 = map.tx(t), y0 = map.ty(t);
        const pa = Track.MID[a], pb = Track.MID[b];
        // Travel direction when entering: from edge a toward the centre.
        const din = [0.5 - pa[0], 0.5 - pa[1]], dout = [pb[0] - 0.5, pb[1] - 0.5];
        // Right of a direction (dx, dy) on this map (y down, x toward SW) is (−dy, dx) mirrored:
        // the lane side must stay the same on straights and turns, so use one convention.
        const rin = [-din[1] * 2, din[0] * 2], rout = [-dout[1] * 2, dout[0] * 2];
        const P0 = [pa[0] + rin[0] * off, pa[1] + rin[1] * off];
        const P2 = [pb[0] + rout[0] * off, pb[1] + rout[1] * off];
        if (a !== b && (a ^ b) !== 2) {
            // A turn: the road's drawn curve (Track.curve), kept to the right-hand lane.
            const c = Track.bezier(Track.curve(map, t, a, b, 'road'), f);
            const l = Math.hypot(c.dx, c.dy) || 1;
            return { x: x0 + c.x - c.dy / l * off, y: y0 + c.y + c.dx / l * off, heading: Math.atan2(c.dy, c.dx) };
        }
        let P1;
        if (a === b) {
            // U-turn: loop through the far lane at the tile centre.
            P1 = [0.5 + din[0] * 0.8, 0.5 + din[1] * 0.8];
        } else {
            P1 = [0.5 + (rin[0] + rout[0]) * off * 0.5, 0.5 + (rin[1] + rout[1]) * off * 0.5];
        }
        const u = 1 - f;
        const x = u * u * P0[0] + 2 * u * f * P1[0] + f * f * P2[0];
        const y = u * u * P0[1] + 2 * u * f * P1[1] + f * f * P2[1];
        const dx = 2 * u * (P1[0] - P0[0]) + 2 * f * (P2[0] - P1[0]);
        const dy = 2 * u * (P1[1] - P0[1]) + 2 * f * (P2[1] - P1[1]);
        return { x: x0 + x, y: y0 + y, heading: Math.atan2(dy, dx) };
    },

    /** Length (tiles) of a road path across a tile. */
    roadLength(a, b) {
        if (a === b) return 1.1;
        return (a ^ b) === 2 ? 1 : 0.8;
    },

    /** Height of a road vehicle at fraction f from edge a to edge b. */
    roadZ(map, t, a, b, f) {
        const za = Track.roadEdgeZ(map, t, a), zb = Track.roadEdgeZ(map, t, b);
        if (a === b) return za;
        return za + (zb - za) * f;
    },
};

/**
 * Path finding (A*). Every search is bounded by maxNodes; a result is the list of steps from the
 * start to the goal, or null.
 */
/** @satisfies {Record<string, any>} */
const PathFinder = {
    /**
     * Rail: from (tile, trackdir) toward any goal tile (goal(tile) -> true). Steps are
     * { tile, td } — the pieces to drive in order; the first one is the start. `next(tile, td)`
     * yields successor { tile, td, cost } entries (World supplies it: tracks, wormholes, reversing
     * at dead ends). h(tile) — the heuristic in tiles.
     */
    search(start, goal, next, h, maxNodes) {
        const open = IMath.heap();
        const key = (s) => s.tile * 16 + s.td;
        const g = new Map(), from = new Map();
        const k0 = key(start);
        g.set(k0, 0);
        open.push(start, h(start.tile));
        let nodes = 0;
        while (open.size) {
            const cur = open.pop();
            const kc = key(cur), gc = g.get(kc);
            if (goal(cur)) {
                const path = [cur];
                let k = kc;
                while (from.has(k)) { const p = from.get(k); path.push(p); k = key(p); }
                return path.reverse();
            }
            if (++nodes > (maxNodes || 20000)) return null;
            for (const n of next(cur)) {
                const kn = key(n), gn = gc + n.cost;
                if (g.has(kn) && g.get(kn) <= gn) continue;
                g.set(kn, gn);
                from.set(kn, cur);
                open.push({ tile: n.tile, td: n.td }, gn + h(n.tile));
            }
        }
        return null;
    },
};
