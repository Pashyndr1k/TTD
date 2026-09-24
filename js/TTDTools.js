// TTDTools.js — the construction and picking tools of the TTD remake. A tool previews what the
// pointer would do (tile outline, cost, catchment area) and applies it on click or at the end of a
// drag through Commands (TTDCommands.js). TTD's autorail: drag along a row for straight track,
// diagonally for diagonal track; a click lays the piece nearest the pointer (corner pieces near a
// corner). Road: TTD's two road tools, one per axis; a drag runs along the axis from the half tile
// under the press to the half tile under the release (a click lays one half).

/** @satisfies {Record<string, any>} */
const Tools = {
    /** Piece of track under a tile-local point (TTD's autorail by position). */
    pieceAt(u, v) {
        const d = [[Math.hypot(u, v), Track.UPPER], [Math.hypot(1 - u, v), Track.LEFT], [Math.hypot(1 - u, 1 - v), Track.LOWER], [Math.hypot(u, 1 - v), Track.RIGHT]];
        d.sort((a, b) => a[0] - b[0]);
        if (d[0][0] < 0.32) return d[0][1];
        return Math.abs(v - 0.5) < Math.abs(u - 0.5) ? Track.X : Track.Y;
    },

    /** Track pieces from start to end (tile-space points), TTD autorail style. */
    railPath(a, b) {
        const dx = b.fx - a.fx, dy = b.fy - a.fy;
        const out = [];
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && a.tx === b.tx && a.ty === b.ty) {
            out.push({ x: a.tx, y: a.ty, track: Tools.pieceAt(a.fx - a.tx, a.fy - a.ty) });
            return out;
        }
        if (Math.abs(dy) <= Math.abs(dx) * 0.45) {
            for (let x = Math.min(a.tx, b.tx); x <= Math.max(a.tx, b.tx); x++) out.push({ x, y: a.ty, track: Track.X });
            return out;
        }
        if (Math.abs(dx) <= Math.abs(dy) * 0.45) {
            for (let y = Math.min(a.ty, b.ty); y <= Math.max(a.ty, b.ty); y++) out.push({ x: a.tx, y, track: Track.Y });
            return out;
        }
        // Diagonal: two alternating corner pieces; the first is the one nearer the start point.
        const sx = Math.sign(dx), sy = Math.sign(dy);
        const u = a.fx - a.tx, v = a.fy - a.ty;
        let p1, p2, m1, m2;
        if (sx === sy) {
            // RIGHT (E corner) and LEFT (W corner).
            const eFirst = Math.hypot(u, 1 - v) < Math.hypot(1 - u, v);
            if (sx > 0) { p1 = eFirst ? Track.RIGHT : Track.LEFT; }
            else { p1 = eFirst ? Track.RIGHT : Track.LEFT; }
            p2 = p1 === Track.RIGHT ? Track.LEFT : Track.RIGHT;
            // Moves after each piece.
            const moveAfter = (tr) => sx > 0 ? (tr === Track.RIGHT ? [0, 1] : [1, 0]) : (tr === Track.RIGHT ? [-1, 0] : [0, -1]);
            m1 = moveAfter(p1); m2 = moveAfter(p2);
        } else {
            const nFirst = Math.hypot(u, v) < Math.hypot(1 - u, 1 - v);
            p1 = nFirst ? Track.UPPER : Track.LOWER;
            p2 = p1 === Track.UPPER ? Track.LOWER : Track.UPPER;
            const moveAfter = (tr) => sx > 0 ? (tr === Track.UPPER ? [0, -1] : [1, 0]) : (tr === Track.LOWER ? [0, 1] : [-1, 0]);
            m1 = moveAfter(p1); m2 = moveAfter(p2);
        }
        const n = Math.round(Math.abs(dx) + Math.abs(dy)) + 1;
        let x = a.tx, y = a.ty;
        for (let i = 0; i < Math.min(n, 400); i++) {
            const tr = i % 2 === 0 ? p1 : p2, m = i % 2 === 0 ? m1 : m2;
            out.push({ x, y, track: tr });
            x += m[0]; y += m[1];
            if ((sx > 0 ? x > b.tx : x < b.tx) || (sy > 0 ? y > b.ty : y < b.ty)) break;
        }
        return out;
    },

    /** Road drag of the road tool (TTD's two road tools, locked to axis 0 X or 1 Y): [{ t, bits }]. */
    roadList(map, a, b, axis) { return Commands.roadDrag(map, a, b, axis); },

    /** Tile rectangle covered by a road drag. */
    roadRect(map, list) {
        const xs = list.map(q => map.tx(q.t)), ys = list.map(q => map.ty(q.t));
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    },

    /** Rectangle of tiles between two picks. */
    rect(a, b) {
        return [Math.min(a.tx, b.tx), Math.min(a.ty, b.ty), Math.max(a.tx, b.tx), Math.max(a.ty, b.ty)];
    },

    /** Entrance direction for a depot on tile t: toward an adjacent track/road that could join. */
    autoDir(world, t, kind) {
        const map = world.map;
        for (let d = 0; d < 4; d++) {
            const n = map.neighbour(t, d);
            if (n < 0) continue;
            if (kind === 'rail' && Track.railBits(map, n)) return d;
            if (kind === 'road' && Track.roadBits(map, n)) return d;
            if (kind === 'ship' && map.isWater(n)) return Dir.axis(d) === 0 ? Dir.SW : Dir.SE;
        }
        return -1;
    },
};

/**
 * The active tool: game.tool = new Tool(game, name, opts). Methods: preview(pick, dragStart),
 * apply(pick, dragStart). Options live in `opts` (rail type, orientation, sizes, remove mode).
 */
class Tool {
    constructor(game, name, opts) {
        this.game = game;
        this.name = name;
        this.opts = Object.assign({ remove: false, railType: 0, axis: 0, tracks: 1, length: 4, dir: -1, bridge: -1, airport: 0 }, opts || {});
        this.drag = ['rail', 'road', 'demolish', 'trees', 'level', 'bridge', 'station'].includes(name);
    }

    get world() { return this.game.world; }

    label() {
        const o = this.opts;
        const names = {
            rail: o.remove ? 'Remove track' : 'Build track (drag)', road: (o.remove ? 'Remove road ' : 'Build road ') + (o.axis ? '\\ (NW–SE)' : '/ (NE–SW)') + ' — drag',
            raildepot: 'Train depot', roaddepot: 'Road vehicle depot', shipdepot: 'Ship depot', station: 'Railway station',
            bus: 'Bus station', truck: 'Lorry station', signal: o.remove ? 'Remove signals' : 'Signals (click again to change)',
            bridge: 'Bridge (drag head to head)', tunnel: 'Tunnel (click a slope)', airport: 'Airport', dock: 'Dock',
            raise: 'Raise land', lower: 'Lower land', level: 'Level land (drag)', demolish: 'Demolish (drag)', trees: 'Plant trees',
            query: 'Land area information', order: 'Select a station or depot for the order',
        };
        return names[this.name] || this.name;
    }

    /** Preview for the pointer at `p` (drag started at `s` or null): { rect, ok, cost, area, text }. */
    preview(p, s) {
        const w = this.world, map = w.map, o = this.opts;
        const t = p.t;
        switch (this.name) {
            case 'rail': {
                const path = Tools.railPath(s || p, p);
                let cost = 0, ok = true;
                for (const q of path) {
                    const r = o.remove ? Commands.removeRail(w, map.idx(q.x, q.y), q.track, false) : Commands.buildRail(w, map.idx(q.x, q.y), q.track, o.railType, false);
                    if (r.ok) cost += r.cost; else ok = false;
                }
                return { rect: Tools.rect(s || p, p), ok, cost, text: path.length + ' piece(s)' };
            }
            case 'road': {
                const list = Tools.roadList(map, s || p, p, o.axis);
                if (!list.length) return { rect: Tools.rect(p, p), ok: false, cost: 0 };
                const r = o.remove ? Commands.removeLongRoad(w, list, false) : Commands.buildLongRoad(w, list, false);
                return { rect: Tools.roadRect(map, list), ok: r.ok, cost: r.cost, text: r.ok ? '' : r.err };
            }
            case 'raildepot': case 'roaddepot': case 'shipdepot': {
                const kind = this.name.replace('depot', '');
                const dir = o.dir >= 0 ? o.dir : Tools.autoDir(w, t, kind);
                const r = Commands.buildDepot(w, t, kind, dir < 0 ? 0 : dir, o.railType, false);
                return { rect: [p.tx, p.ty, p.tx, p.ty], ok: r.ok, cost: r.cost, text: 'Entrance: ' + Dir.NAMES[dir < 0 ? 0 : dir] + (r.ok ? '' : ' — ' + r.err) };
            }
            case 'station': {
                const w0 = o.axis === 0 ? o.length : o.tracks, h0 = o.axis === 0 ? o.tracks : o.length;
                const r = Commands.buildRailStation(w, t, o.axis, o.tracks, o.length, o.railType, false);
                return { rect: [p.tx, p.ty, p.tx + w0 - 1, p.ty + h0 - 1], ok: r.ok, cost: r.cost, area: this.catchRect(p.tx, p.ty, w0, h0, 4), text: r.ok ? '' : r.err };
            }
            case 'bus': case 'truck': {
                const axis = map.type[t] === GameMap.T_ROAD && map.road[t] === 10 ? 1 : map.type[t] === GameMap.T_ROAD && map.road[t] === 5 ? 0 : o.axis;
                const r = Commands.buildRoadStop(w, t, axis, this.name === 'truck', false);
                return { rect: [p.tx, p.ty, p.tx, p.ty], ok: r.ok, cost: r.cost, area: this.catchRect(p.tx, p.ty, 1, 1, 3), text: r.ok ? '' : r.err };
            }
            case 'airport': {
                const A = TTDData.AIRPORTS[o.airport];
                const r = Commands.buildAirport(w, t, o.airport, false);
                return { rect: [p.tx, p.ty, p.tx + A.w - 1, p.ty + A.h - 1], ok: r.ok, cost: r.cost, area: this.catchRect(p.tx, p.ty, A.w, A.h, A.radius), text: r.ok ? '' : r.err };
            }
            case 'dock': {
                const r = Commands.buildDock(w, t, false);
                return { rect: [p.tx, p.ty, p.tx, p.ty], ok: r.ok, cost: r.cost, area: this.catchRect(p.tx, p.ty, 1, 1, 5), text: r.ok ? '' : r.err };
            }
            case 'signal': {
                const tr = Tools.pieceAt(p.fx - p.tx, p.fy - p.ty);
                const r = o.remove ? Commands.removeSignal(w, t, tr, false) : Commands.buildSignal(w, t, this.signalTrack(t, tr), false);
                return { rect: [p.tx, p.ty, p.tx, p.ty], ok: r.ok, cost: r.cost, text: r.ok ? '' : r.err };
            }
            case 'bridge': {
                if (!s) return { rect: [p.tx, p.ty, p.tx, p.ty], ok: true, cost: 0, text: 'Drag from one bridge head to the other' };
                const type = this.bridgeType(s.t, p.t);
                const r = type >= 0 ? Commands.buildBridge(w, s.t, p.t, type, o.transport, o.railType, false) : Commands.fail('No bridge type fits');
                return { rect: Tools.rect(s, p), ok: r.ok, cost: r.cost, text: (type >= 0 ? TTDData.BRIDGES[type].name + ', ' + TTDData.BRIDGES[type].speed + ' km/h' : '') + (r.ok ? '' : ' — ' + r.err) };
            }
            case 'tunnel': {
                const r = Commands.buildTunnel(w, t, o.transport, o.railType, false);
                return { rect: [p.tx, p.ty, p.tx, p.ty], ok: r.ok, cost: r.cost, text: r.ok ? '' : r.err };
            }
            case 'raise': case 'lower': {
                const cx = Math.round(p.fx), cy = Math.round(p.fy);
                const r = Commands.terraform(w, cx, cy, this.name === 'raise' ? 1 : -1, false);
                return { rect: [cx - 1, cy - 1, cx, cy], ok: r.ok, cost: r.cost, corner: [cx, cy], text: r.ok ? '' : r.err };
            }
            case 'level': case 'demolish': case 'trees': {
                const rc = Tools.rect(s || p, p);
                let cost = 0;
                if (this.name !== 'level') {
                    for (let y = rc[1]; y <= rc[3]; y++) for (let x = rc[0]; x <= rc[2]; x++) {
                        const r = this.name === 'trees' ? Commands.plantTree(w, map.idx(x, y), false) : Commands.demolish(w, map.idx(x, y), false);
                        if (r.ok) cost += r.cost;
                    }
                }
                return { rect: rc, ok: true, cost };
            }
            case 'query': case 'order':
                return { rect: [p.tx, p.ty, p.tx, p.ty], ok: true, cost: 0 };
        }
        return { rect: [p.tx, p.ty, p.tx, p.ty], ok: true, cost: 0 };
    }

    catchRect(x, y, w, h, r) {
        const map = this.world.map, out = [];
        for (let yy = y - r; yy < y + h + r; yy++) for (let xx = x - r; xx < x + w + r; xx++) if (map.inside(xx, yy)) out.push(map.idx(xx, yy));
        return out;
    }

    /** The piece a signal goes on: the pointed one if present, otherwise the tile's only piece. */
    signalTrack(t, tr) {
        const bits = this.world.map.rail[t];
        if (bits & (1 << tr)) return tr;
        for (let k = 0; k < 6; k++) if (bits & (1 << k)) return k;
        return tr;
    }

    /** Bridge type: the chosen one, or the cheapest that fits the length. */
    bridgeType(a, b) {
        const w = this.world, map = w.map;
        const len = IMath.manhattan(map.tx(a), map.ty(a), map.tx(b), map.ty(b)) - 1;
        if (this.opts.bridge >= 0) return this.opts.bridge;
        let best = -1;
        TTDData.BRIDGES.forEach((s, i) => {
            if (s.year > w.year || len > s.maxLen || len < s.minLen) return;
            if (best < 0 || s.price < TTDData.BRIDGES[best].price) best = i;
        });
        return best;
    }

    /** Do it (on click or at the end of a drag). */
    apply(p, s) {
        const g = this.game, w = this.world, map = w.map, o = this.opts;
        const t = p.t;
        const run = (fn) => g.run(fn);
        switch (this.name) {
            case 'rail': {
                let first = null;
                for (const q of Tools.railPath(s || p, p)) {
                    const tt = map.idx(q.x, q.y);
                    const r = Commands.run(w, ex => o.remove ? Commands.removeRail(w, tt, q.track, ex) : Commands.buildRail(w, tt, q.track, o.railType, ex), true);
                    if (!r.ok && !first && r.err !== 'Already built') first = r;
                    if (r.ok) g.spent(r.cost, tt);
                }
                if (first) g.error(first.err);
                return;
            }
            case 'road': {
                const list = Tools.roadList(map, s || p, p, o.axis);
                if (!list.length) return;
                const r = Commands.run(w, ex => o.remove ? Commands.removeLongRoad(w, list, ex) : Commands.buildLongRoad(w, list, ex), true);
                if (r.ok) g.spent(r.cost, list[list.length - 1].t);
                else if (r.err !== 'Already built') g.error(r.err);
                return;
            }
            case 'raildepot': case 'roaddepot': case 'shipdepot': {
                const kind = this.name.replace('depot', '');
                const dir = o.dir >= 0 ? o.dir : Tools.autoDir(w, t, kind);
                run(ex => Commands.buildDepot(w, t, kind, dir < 0 ? 0 : dir, o.railType, ex));
                return;
            }
            case 'station': run(ex => Commands.buildRailStation(w, t, o.axis, o.tracks, o.length, o.railType, ex)); return;
            case 'bus': case 'truck': {
                const axis = map.type[t] === GameMap.T_ROAD && map.road[t] === 10 ? 1 : map.type[t] === GameMap.T_ROAD && map.road[t] === 5 ? 0 : o.axis;
                run(ex => Commands.buildRoadStop(w, t, axis, this.name === 'truck', ex));
                return;
            }
            case 'airport': run(ex => Commands.buildAirport(w, t, o.airport, ex)); return;
            case 'dock': run(ex => Commands.buildDock(w, t, ex)); return;
            case 'signal': {
                const tr = Tools.pieceAt(p.fx - p.tx, p.fy - p.ty);
                run(ex => o.remove ? Commands.removeSignal(w, t, this.signalTrack(t, tr), ex) : Commands.buildSignal(w, t, this.signalTrack(t, tr), ex));
                return;
            }
            case 'bridge': {
                if (!s || s.t === p.t) return;
                const type = this.bridgeType(s.t, p.t);
                if (type < 0) { g.error('No bridge type fits this length'); return; }
                run(ex => Commands.buildBridge(w, s.t, p.t, type, o.transport, o.railType, ex));
                return;
            }
            case 'tunnel': run(ex => Commands.buildTunnel(w, t, o.transport, o.railType, ex)); return;
            case 'raise': case 'lower': {
                const cx = Math.round(p.fx), cy = Math.round(p.fy);
                run(ex => Commands.terraform(w, cx, cy, this.name === 'raise' ? 1 : -1, ex));
                return;
            }
            case 'level': {
                // Bring every corner of the rectangle to the height of the start corner.
                const a = s || p;
                const target = map.cornerH(Math.round(a.fx), Math.round(a.fy));
                const rc = Tools.rect(s || p, p);
                let total = 0, err = null;
                for (let pass = 0; pass < 16; pass++) {
                    let changed = false;
                    for (let cy = rc[1]; cy <= rc[3] + 1; cy++) for (let cx = rc[0]; cx <= rc[2] + 1; cx++) {
                        const h = map.cornerH(cx, cy);
                        if (h === target) continue;
                        const r = Commands.run(w, ex => Commands.terraform(w, cx, cy, h < target ? 1 : -1, ex), true);
                        if (r.ok) { total += r.cost; changed = true; } else if (!err) err = r.err;
                    }
                    if (!changed) break;
                }
                if (total) g.spent(total, p.t);
                if (err && !total) g.error(err);
                return;
            }
            case 'demolish': case 'trees': {
                const rc = Tools.rect(s || p, p);
                let total = 0, err = null;
                for (let y = rc[1]; y <= rc[3]; y++) for (let x = rc[0]; x <= rc[2]; x++) {
                    const tt = map.idx(x, y);
                    const r = Commands.run(w, ex => this.name === 'trees' ? Commands.plantTree(w, tt, ex) : Commands.demolish(w, tt, ex), true);
                    if (r.ok) total += r.cost; else if (!err && rc[0] === rc[2] && rc[1] === rc[3]) err = r.err;
                }
                if (total) g.spent(total, p.t);
                if (err) g.error(err);
                return;
            }
            case 'query': g.gui.showTile(t); return;
            case 'order': g.gui.orderPicked(t); return;
        }
    }
}
