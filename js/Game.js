// Game.js — the Transport Tycoon Deluxe remake on ArcEngine: owns the world simulation (World,
// TTDWorld.js), its 3D view (TTDRender3D), the camera, the HUD (Gui) and the active tool (Tool).
// main.js creates it and calls update(dt) every frame before the render: the clock turns real
// time into game ticks (TTD_TICK_MS each, fast forward ×ffMult), the view catches up with what
// changed, the HUD refreshes.
//
// Input: left click selects (vehicle, station, depot, town, industry) or applies the active tool,
// left drag scrolls the map when no tool is active (TTD scrolls with a drag too), drags a tool's
// area otherwise; the kit's camera keeps WASD flight, the wheel zoom, right-drag turning.
// Saves (Game menu, yearly autosave) go to the browser through Store.

class Game {
    constructor(canvas) {
        this.canvas = canvas;
        /** @type {View3D | null} */
        this.view = null;
        /** @type {World | null} */
        this.world = null;
        /** @type {TTDRender3D | null} */
        this.render = null;
        /** @type {CameraController | null} */
        this.camera = null;
        /** @type {Tool | null} */
        this.tool = null;
        this.removeMode = false;
        this.railType = 0;
        this.paused = false;
        this.fast = false;
        this.ffMult = typeof TTD_FAST_FORWARD !== 'undefined' ? TTD_FAST_FORWARD : 6;
        this.acc = 0;
        this.selected = null;
        this.orderVehicle = null;
        this.mouse = null;
        this.down = null;
        this.hoverDirty = false;
        this._fpsT = 0;
        this._tipT = 0;
        this.gui = new Gui(this);
        this.bindInput();
        this.newGame(World.defaultSettings());
        this.gui.showNewGame(true);
        this.ready = Promise.resolve();
    }

    static tickMs() { return typeof TTD_TICK_MS !== 'undefined' ? TTD_TICK_MS : 27; }

    // --- World lifecycle ------------------------------------------------------------------------

    newGame(settings) {
        const w = new World(Object.assign({}, settings));
        w.generate();
        this.attach(w);
        // Start the camera over the biggest town.
        const town = w.towns.slice().sort((a, b) => b.population - a.population)[0];
        if (town) this.lookAtTile(town.xy);
    }

    attach(world) {
        if (this.camera) this.camera.detach();
        if (this.view) this.view.dispose();
        this.setTool(null);
        this.gui.close();
        this.world = world;
        this.view = World3D.createView({});
        this.view.camera.maxZ = 90000;
        this.render = new TTDRender3D(this.view, world);
        this.render.onPuff = (v, kind, x, y) => {
            if ((typeof TTD_VEHICLE_SOUNDS !== 'undefined' ? TTD_VEHICLE_SOUNDS : 1) && v.owner === 0) this.sfx('chuff', x, y, 0.3);
        };
        this._vstate = null;
        this.render.update(0, 0);
        const T = this.render.T;
        this.camera = new CameraController(this.view, { terrain: this.render.terrain, bounds: { w: world.map.W * T, h: world.map.H * T } });
        this.camera.attach(this.canvas);
        this.camera.leftPan = true;
        Money.currency = world.settings.currency;
        world.listeners.push((what, data) => this.onWorldEvent(what, data));
        if (window.app) { window.app.camera = this.camera; window.app.view = this.view; }
        this.acc = 0;
    }

    saveGame(key) {
        if (!this.world) return false;
        let ok = false;
        try { ok = Store.set(key, this.world.save()); } catch (e) { ok = false; }
        if (!ok) this.error('Could not save: browser storage is full or blocked');
        return ok;
    }

    loadGame(key) {
        const raw = Store.get(key || Game.SAVE_KEY);
        if (!raw) { this.error('No saved game'); return false; }
        try {
            const w = World.load(raw);
            this.attach(w);
            const town = w.towns[0];
            if (town) this.lookAtTile(town.xy);
            this.info('Game loaded: ' + Calendar.format(w.date, true));
            return true;
        } catch (e) {
            console.error(e);
            this.error('The saved game could not be loaded');
            return false;
        }
    }

    onWorldEvent(what, data) {
        const T = this.render ? this.render.T : 64, m = this.world.map;
        if (what === 'news') { this.gui.onNews(data); this.sfx('news'); }
        else if (what === 'year') this.saveGame(Game.AUTOSAVE_KEY);
        else if (what === 'income') {
            this.money('+' + Money.format(data.amount));
            if (data.tile >= 0) this.sfx('cash', (m.tx(data.tile) + 0.5) * T, (m.ty(data.tile) + 0.5) * T);
        }
        else if (what === 'crash') this.sfx('crash', data.x * T, data.y * T);
        else if (what === 'breakdown') this.sfx('breakdown', data.x * T, data.y * T);
        else if (what === 'gameover' && data.bankrupt) this.paused = true;
    }

    // --- Sounds -------------------------------------------------------------------------------------

    /**
     * Play one of Game.SOUNDS: at world px (x, y) — heard from where the camera is, fading with
     * distance (Sound3D) — or, without a point, as a plain 2D effect. A point far off screen is
     * skipped without making a sound node at all.
     */
    sfx(name, x, y, volume) {
        const src = Game.SOUNDS[name];
        if (!src) return;
        const o = { volume: volume == null ? 1 : volume };
        if (x != null) {
            const c = this.camera && this.camera.target;
            const far = (typeof AUDIO_FALLOFF_MAX !== 'undefined' ? AUDIO_FALLOFF_MAX : 1024) * 1.6;
            if (c && Math.hypot(c.x - x, c.y - y) > far / Math.max(0.25, this.camera.zoom)) return;
            o.x = x; o.y = y;
        }
        Sound3D.play(src, o);
    }

    /**
     * Vehicle sounds (TTD plays them as a vehicle starts off): a steam whistle or a horn as a
     * train leaves a station or depot, a honk for road vehicles, a foghorn for ships, a roar as an
     * aircraft takes off. Watched from the vehicles' states, so the simulation stays silent.
     */
    updateVehicleSounds() {
        const w = this.world, T = this.render.T;
        const on = typeof TTD_VEHICLE_SOUNDS !== 'undefined' ? TTD_VEHICLE_SOUNDS : 1;
        if (!this._vstate) this._vstate = new Map();
        for (const v of w.vehicles) {
            if (!v) continue;
            const phase = v instanceof Aircraft ? v.phase : '';
            const key = v.state + '|' + phase;
            const was = this._vstate.get(v.id);
            this._vstate.set(v.id, key);
            if (!on || was == null || was === key || v.owner !== 0) continue;
            const x = v.x * T, y = v.y * T;
            const left = (was.startsWith('load') || was.startsWith('depot')) && v.state === 'run';
            if (v.type === 'air') { if (phase === 'takeoff') this.sfx('plane', x, y, 0.8); continue; }
            if (!left) continue;
            if (v.type === 'train') {
                const e = v.cars.map(c => World.ENGINE[c.engine]).find(e => !e.wagon);
                this.sfx(e && /Steam/.test(e.name) ? 'whistle' : 'horn', x, y, 0.7);
            } else if (v.type === 'road') this.sfx('bus', x, y, 0.6);
            else if (v.type === 'ship') this.sfx('ship', x, y, 0.8);
        }
        if (this._vstate.size > w.vehicles.length + 50) for (const id of [...this._vstate.keys()]) if (!w.vehicles[id]) this._vstate.delete(id);
    }

    // --- Messages ----------------------------------------------------------------------------------

    error(msg) { this.gui.error(msg); this.sfx('error'); }
    info(msg) { this.gui.error(msg); }

    /** A short money note next to the cost tip (TTD's floating cost text). */
    money(text) {
        const e = UI.get('costTip');
        if (e) e.setText(text);
        this._tipT = 2.5;
    }

    spent(cost, tile) {
        if (cost) this.money((cost > 0 ? '-' : '+') + Money.format(Math.abs(cost)));
        // Building / demolition sound, once per drag even when a drag builds many pieces.
        const now = performance.now();
        if (now - (this._buildSfxT || 0) < 120) return;
        this._buildSfxT = now;
        const name = this.tool && this.tool.name === 'demolish' ? 'demolish' : 'build';
        if (tile != null && tile >= 0 && this.render) {
            const m = this.world.map, T = this.render.T;
            this.sfx(name, (m.tx(tile) + 0.5) * T, (m.ty(tile) + 0.5) * T);
        } else this.sfx(name);
    }

    /** Run a command with exec, report failure or cost. */
    run(fn) {
        const r = Commands.run(this.world, fn, true);
        if (!r.ok) this.error(r.err); else this.spent(r.cost);
        return r;
    }

    // --- Speed ------------------------------------------------------------------------------------

    togglePause() { this.paused = !this.paused; }
    toggleFast() { this.fast = !this.fast; }

    // --- Camera helpers ---------------------------------------------------------------------------

    lookAtTile(t) {
        if (!this.camera || !this.world) return;
        const T = this.render.T, m = this.world.map;
        this.camera.follow(null);
        this.camera.lookAt(m.tx(t) * T + T / 2, m.ty(t) * T + T / 2);
    }

    follow(v) {
        if (!this.camera) return;
        const T = this.render.T;
        this.camera.follow({ get x() { return v.x * T; }, get y() { return v.y * T; } });
    }

    sendToDepot(v) {
        const w = this.world, map = w.map;
        if (v.type === 'air') {
            const st = w.stations.filter(s => s && s.airport && s.owner === 0)
                .sort((a, b) => IMath.manhattan(map.tx(a.xy), map.ty(a.xy), v.x, v.y) - IMath.manhattan(map.tx(b.xy), map.ty(b.xy), v.x, v.y))[0];
            if (!st) { this.error('No airport with a hangar'); return; }
            v.orders.splice(v.cur, 0, { kind: 'depot', dest: st.id, stop: true });
            v.onOrderChanged();
            return;
        }
        const kind = { train: 'rail', road: 'road', ship: 'ship' }[v.type];
        const d = w.depots.filter(d => d && d.kind === kind && d.owner === v.owner)
            .sort((a, b) => IMath.manhattan(map.tx(a.t), map.ty(a.t), v.x, v.y) - IMath.manhattan(map.tx(b.t), map.ty(b.t), v.x, v.y))[0];
        if (!d) { this.error('Unable to find local depot'); return; }
        v.orders.splice(v.cur, 0, { kind: 'depot', dest: d.id, stop: true });
        v.onOrderChanged();
    }

    // --- Tools --------------------------------------------------------------------------------------

    setTool(name, opts) {
        if (!name || (this.tool && this.tool.name === name && !opts)) {
            this.tool = null;
        } else {
            this.tool = new Tool(this, name, Object.assign({ remove: this.removeMode, railType: this.railType }, opts || {}));
        }
        if (this.camera) this.camera.leftPan = !this.tool;
        if (this.render) { this.render.setCursor(null); if (!this.gui.win || this.gui.win.kind !== 'station') this.render.setArea(null); }
        this.gui.renderBar();
        const tip = UI.get('costTip');
        if (tip) tip.setText(this.tool ? this.tool.label() : '');
        this.hoverDirty = true;
    }

    // --- Input --------------------------------------------------------------------------------------

    bindInput() {
        const c = this.canvas;
        const local = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
        c.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const p = local(e);
            this.down = { x: p.x, y: p.y, pick: this.render ? this.render.pick(p.x, p.y) : null, moved: false };
        });
        c.addEventListener('pointermove', (e) => {
            const p = local(e);
            this.mouse = p;
            if (this.down && Math.hypot(p.x - this.down.x, p.y - this.down.y) > 6) this.down.moved = true;
            this.hoverDirty = true;
        });
        window.addEventListener('pointerup', (e) => {
            if (e.button !== 0 || !this.down) return;
            const d = this.down;
            this.down = null;
            if (!this.world || !this.render) return;
            const p = local(e);
            if (this.tool) {
                const pk = this.render.pick(p.x, p.y);
                if (pk) this.tool.apply(pk, this.tool.drag && d.pick ? d.pick : null);
                this.hoverDirty = true;
                if (this.tool && ['station', 'raildepot', 'roaddepot', 'shipdepot', 'airport', 'dock', 'tunnel', 'bus', 'truck'].includes(this.tool.name)) { /* stays active, like TTD */ }
            } else if (!d.moved) {
                this.clickSelect(p.x, p.y);
            }
        });
        window.addEventListener('keydown', (e) => {
            const t = /** @type {HTMLElement} */ (e.target);
            if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
            if (e.code === 'Escape') { if (this.tool) this.setTool(null); else { this.gui.openBar(null); this.gui.close(); } }
            else if (e.code === 'KeyP' && !e.repeat) this.togglePause();
            else if (e.code === 'KeyF' && !e.repeat) this.toggleFast();
        });
    }

    clickSelect(px, py) {
        const w = this.world, r = this.render;
        const v = r.pickVehicle(px, py);
        if (v) { this.gui.open('vehicle', v.id); return; }
        const p = r.pick(px, py);
        if (!p) return;
        const t = p.t, map = w.map, k = map.type[t];
        const st = w.stationAt(t);
        if (st) { this.gui.open('station', st.id); return; }
        const dep = w.depotAt(t);
        if (dep) { this.gui.win = null; this.gui.open('depot', dep.id); return; }
        if (k === GameMap.T_INDUSTRY && w.industries[map.obj[t]]) { this.gui.open('industry', map.obj[t]); return; }
        if ((k === GameMap.T_HOUSE || k === GameMap.T_ROAD) && map.town[t] >= 0) { this.gui.open('town', map.town[t]); return; }
        if (k === GameMap.T_OBJECT && map.town[t] >= 0) { this.gui.open('town', map.town[t]); return; }
    }

    /** Hover: tool preview, cursor outline, cost tip, the name of what is under the pointer. */
    updateHover() {
        this.hoverDirty = false;
        const r = this.render, w = this.world;
        if (!this.mouse || !r) return;
        const p = r.pick(this.mouse.x, this.mouse.y);
        const hover = UI.get('hover');
        if (!p) { r.setCursor(null); if (hover) hover.setText(''); return; }
        const map = w.map, t = p.t;
        if (this.tool) {
            const s = this.down && this.tool.drag ? this.down.pick : null;
            const pv = this.tool.preview(p, s);
            r.setCursor(pv.rect, pv.ok);
            if (pv.area) r.setArea(pv.area);
            const tip = UI.get('costTip');
            if (tip && this._tipT <= 0) tip.setText(this.tool.label() + (pv.cost ? '   Cost: ' + Money.format(pv.cost) : '') + (pv.text ? '   ' + pv.text : ''));
        } else {
            r.setCursor([p.tx, p.ty, p.tx, p.ty], true);
        }
        if (hover) {
            let s = '';
            const st = w.stationAt(t);
            if (st) s = st.name;
            else if (map.type[t] === GameMap.T_INDUSTRY && w.industries[map.obj[t]]) s = Industries.name(w, w.industries[map.obj[t]]);
            else if (map.type[t] === GameMap.T_HOUSE) s = (w.towns[map.town[t]] ? w.towns[map.town[t]].name + ': ' : '') + TTDData.HOUSES[map.sub[t]].name;
            else if (map.town[t] >= 0 && w.towns[map.town[t]]) s = w.towns[map.town[t]].name;
            hover.setText(s + (s ? '   ' : '') + 'height ' + map.tileMinZ(t));
        }
    }

    /** Remember where every vehicle part stands before the last tick of a frame. */
    snapshot() {
        for (const v of this.world.vehicles) {
            if (!v || !v.parts) continue;
            const prev = v._prev || (v._prev = []);
            prev.length = v.parts.length;
            for (let i = 0; i < v.parts.length; i++) {
                const p = v.parts[i];
                const q = prev[i] || (prev[i] = { x: 0, y: 0, z: 0, heading: 0, grade: 0, hidden: true });
                q.x = p.x; q.y = p.y; q.z = p.z; q.heading = p.heading; q.grade = p.grade; q.hidden = p.hidden;
            }
        }
    }

    // --- Frame ----------------------------------------------------------------------------------------

    update(dt) {
        const w = this.world;
        if (!w) return;
        if (!this.paused && !w.gameOver) {
            this.acc += dt * 1000 * (this.fast ? this.ffMult : 1);
            const ms = Game.tickMs();
            let n = Math.floor(this.acc / ms);
            const cap = this.fast ? 400 : 12;
            if (n > cap) { n = cap; this.acc = 0; }
            else this.acc -= n * ms;
            for (let i = 0; i < n; i++) {
                if (i === n - 1) this.snapshot();
                w.tick();
            }
        }
        // Vehicles are drawn between the last two ticks (smooth at any frame rate).
        const alpha = this.paused ? 1 : IMath.clamp(this.acc / Game.tickMs(), 0, 1);
        this.render.update(dt, 6, alpha);
        this.updateVehicleSounds();
        if (this.hoverDirty || this.down) this.updateHover();
        this.render.setSelected(this.selected);
        if (this._tipT > 0) this._tipT -= dt;
        this.gui.update(dt);
        this._fpsT -= dt;
        if (this._fpsT <= 0) {
            this._fpsT = 0.5;
            const fps = UI.get('fps');
            if (fps) fps.setText(Math.round(World3D.engine.getFps()) + ' fps');
        }
    }
}

/** The game's sound effects (synthesized by tools/make-sounds.mjs). */
Game.SOUNDS = {
    click: 'assets/sounds/click.wav', build: 'assets/sounds/build.wav', demolish: 'assets/sounds/demolish.wav',
    cash: 'assets/sounds/cash.wav', whistle: 'assets/sounds/whistle.wav', chuff: 'assets/sounds/chuff.wav',
    horn: 'assets/sounds/horn.wav', bus: 'assets/sounds/bus.wav', ship: 'assets/sounds/ship.wav',
    plane: 'assets/sounds/plane.wav', crash: 'assets/sounds/crash.wav', breakdown: 'assets/sounds/breakdown.wav',
    news: 'assets/sounds/news.wav', error: 'assets/sounds/error.wav',
};
Game.SAVE_KEY = 'ttd3d.save';
Game.AUTOSAVE_KEY = 'ttd3d.autosave';
