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
        if (map.type[t] === GameMap.T_TUNBRIDGE && map.density[t] === d) return map.wz[t];
        return map.pieceEdgeZ(t, d, axis);
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

    /** Height of a road end at edge d: a straight road along an incline follows it. */
    roadEdgeZ(map, t, d) {
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
