// TTDGui.js — the HUD of the TTD remake, built only from UILayout.js records (skill ui): the
// toolbar (TTD's order), build bars with their option bars, the status bar (date, speed, news
// ticker, money), one info/list window reused by every view (vehicle and orders, depot and
// vehicle purchase, station, town and local authority, industry, finances, company, subsidies,
// lists, news, game menu, land info), the newspaper popup, the error popup and the new game
// dialog. Rows, action and option buttons are copies of the 'wr', 'wb', 'ob', 'bb', 'ng'
// templates.

class Gui {
    /** @param {Game} game */
    constructor(game) {
        this.game = game;
        this.win = null;          // { kind, ref, page, sel, tab }
        this.bar = null;          // open build bar name
        this.rows = [];
        this.acts = [];
        this.opts = [];
        this.bbs = [];
        this.ngs = [];
        this._refresh = 0;
        this._msgT = 0;
        this._newsT = 0;
        this.newsItem = null;
        this.tickerIdx = 0;
        this.ng = null;           // new game settings being edited
        this.makeCopies();
        this.bindToolbar();
    }

    get world() { return this.game.world; }

    // --- Template copies --------------------------------------------------------------------

    makeCopies() {
        const copy = (tpl, n, place) => {
            const t = UI.def(tpl);
            const out = [];
            if (!t) return out;
            for (let i = 0; i < n; i++) {
                const e = UI.add(Object.assign({}, t, place(t, i), { id: tpl + i, visible: 0 }));
                if (e) out.push(e);
            }
            return out;
        };
        this.rows = copy('wr', 22, (t, i) => ({ y: t.y + i * (t.h + 2) }));
        this.lrows = copy('wl', 12, (t, i) => ({ y: t.y + i * (t.h + 2) }));
        this.acts = copy('wb', 12, (t, i) => ({ x: t.x + (i % 4) * (t.w + 4), y: t.y + Math.floor(i / 4) * (t.h + 4) }));
        this.bbs = copy('bb', 12, (t, i) => ({ x: t.x + i * (t.w + 3) }));
        this.opts = copy('ob', 8, (t, i) => ({ x: t.x + i * (t.w + 3) }));
        this.ngs = copy('ng', 14, (t, i) => ({ y: t.y + i * (t.h + 3) }));
    }

    on(id, fn) { const e = UI.get(id); if (e) e.onClick(fn); }
    text(id, s) { const e = UI.get(id); if (e) e.setText(s); }
    show(id, on) { const e = UI.get(id); if (e) e.show(on); }

    bindToolbar() {
        const g = this.game;
        this.on('tb_pause', () => g.togglePause());
        this.on('tb_ff', () => g.toggleFast());
        this.on('tb_menu', () => this.open('menu'));
        this.on('tb_towns', () => this.open('towns'));
        this.on('tb_subs', () => this.open('subsidies'));
        this.on('tb_stations', () => this.open('stations'));
        this.on('tb_fin', () => this.open('finances'));
        this.on('tb_company', () => this.open('company'));
        this.on('tb_ind', () => this.open('industries'));
        this.on('tb_trains', () => this.open('vlist', 'train'));
        this.on('tb_rvs', () => this.open('vlist', 'road'));
        this.on('tb_ships', () => this.open('vlist', 'ship'));
        this.on('tb_air', () => this.open('vlist', 'air'));
        this.on('tb_news', () => this.open('news'));
        this.on('tb_query', () => g.setTool('query'));
        this.on('tb_land', () => this.openBar('land'));
        this.on('tb_demolish', () => { this.openBar(null); g.setTool('demolish'); });
        this.on('tb_bair', () => this.openBar('air'));
        this.on('tb_docks', () => this.openBar('docks'));
        this.on('tb_broad', () => this.openBar('road'));
        this.on('tb_brail', () => this.openBar('rail'));
        this.on('winClose', () => this.close());
        this.on('winPrev', () => { if (this.win) { this.win.page = Math.max(0, (this.win.page || 0) - 1); this.render(); } });
        this.on('winNext', () => { if (this.win) { this.win.page = (this.win.page || 0) + 1; this.render(); } });
        this.on('newsClose', () => this.show('newsBox', false));
        this.on('newsGo', () => { if (this.newsItem && this.newsItem.tile >= 0) g.lookAtTile(this.newsItem.tile); });
        this.on('ngStart', () => this.startNewGame());
        this.on('ngLoad', () => { if (g.loadGame()) this.show('ngDim', false); });
        this.on('ngResume', () => this.show('ngDim', false));
    }

    // --- Build bars -----------------------------------------------------------------------------

    openBar(name) {
        const g = this.game;
        if (this.bar === name && name) { this.bar = null; this.show('buildbar', false); this.show('optbar', false); g.setTool(null); return; }
        this.bar = name;
        g.setTool(null);
        if (!name) { this.show('buildbar', false); this.show('optbar', false); return; }
        this.show('buildbar', true);
        this.renderBar();
    }

    /** Buttons of the open bar: [label, onClick]. @returns {Array<[string, () => void]>} */
    barItems() {
        const g = this.game, t = g.tool, rt = g.railType;
        const on = (n) => t && t.name === n ? '• ' : '';
        const railNames = ['Rail', 'Electric', 'Monorail', 'Maglev'];
        switch (this.bar) {
            case 'rail': return [
                [on('rail') + 'Track', () => g.setTool('rail', { railType: rt })],
                [on('raildepot') + 'Depot', () => g.setTool('raildepot', { railType: rt })],
                [on('station') + 'Station', () => g.setTool('station', { railType: rt })],
                [on('signal') + 'Signals', () => g.setTool('signal')],
                [on('bridge') + 'Bridge', () => g.setTool('bridge', { transport: 'rail', railType: rt })],
                [on('tunnel') + 'Tunnel', () => g.setTool('tunnel', { transport: 'rail', railType: rt })],
                [(g.removeMode ? '• ' : '') + 'Remove', () => { g.removeMode = !g.removeMode; if (g.tool) g.tool.opts.remove = g.removeMode; this.renderBar(); }],
                [railNames[rt], () => { g.railType = (g.railType + 1) % 4; if (g.tool) g.tool.opts.railType = g.railType; this.renderBar(); }],
            ];
            case 'road': return [
                [on('road') + 'Road', () => g.setTool('road')],
                [on('roaddepot') + 'Depot', () => g.setTool('roaddepot')],
                [on('bus') + 'Bus stop', () => g.setTool('bus')],
                [on('truck') + 'Lorry stop', () => g.setTool('truck')],
                [on('bridge') + 'Bridge', () => g.setTool('bridge', { transport: 'road' })],
                [on('tunnel') + 'Tunnel', () => g.setTool('tunnel', { transport: 'road' })],
                [(g.removeMode ? '• ' : '') + 'Remove', () => { g.removeMode = !g.removeMode; if (g.tool) g.tool.opts.remove = g.removeMode; this.renderBar(); }],
            ];
            case 'docks': return [
                [on('dock') + 'Dock', () => g.setTool('dock')],
                [on('shipdepot') + 'Ship depot', () => g.setTool('shipdepot')],
            ];
            case 'air': return TTDData.AIRPORTS.map((a, i) => [(t && t.name === 'airport' && t.opts.airport === i ? '• ' : '') + a.name.replace(' Airport', ''), () => g.setTool('airport', { airport: i })]);
            case 'land': return [
                [on('raise') + 'Raise', () => g.setTool('raise')],
                [on('lower') + 'Lower', () => g.setTool('lower')],
                [on('level') + 'Level', () => g.setTool('level')],
                [on('demolish') + 'Demolish', () => g.setTool('demolish')],
                [on('trees') + 'Trees', () => g.setTool('trees')],
            ];
        }
        return [];
    }

    renderBar() {
        const items = this.bar ? this.barItems() : [];
        this.bbs.forEach((b, i) => {
            if (i < items.length) { b.setText(items[i][0]); b.onClick(() => { items[i][1](); this.renderBar(); }); b.show(true); }
            else b.show(false);
        });
        this.renderOpts();
    }

    /** Option bar for tools with settings (station size, orientation, depot direction…). */
    renderOpts() {
        const g = this.game, t = g.tool;
        /** @type {Array<[string, () => void]>} */
        let items = [];
        if (t && t.name === 'station') {
            items = [
                ['Axis: ' + (t.opts.axis ? 'Y' : 'X'), () => { t.opts.axis ^= 1; }],
                ['Platforms: ' + t.opts.tracks, () => { t.opts.tracks = t.opts.tracks % 7 + 1; }],
                ['Length: ' + t.opts.length, () => { t.opts.length = t.opts.length % 7 + 1; }],
            ];
        } else if (t && (t.name === 'raildepot' || t.name === 'roaddepot' || t.name === 'shipdepot')) {
            items = [['Entrance: ' + (t.opts.dir < 0 ? 'auto' : Dir.NAMES[t.opts.dir]), () => { t.opts.dir = t.opts.dir >= 3 ? -1 : t.opts.dir + 1; }]];
        } else if (t && (t.name === 'bus' || t.name === 'truck')) {
            items = [['Axis: ' + (t.opts.axis ? 'Y' : 'X') + ' (on empty land)', () => { t.opts.axis ^= 1; }]];
        } else if (t && t.name === 'bridge') {
            const types = [-1].concat(TTDData.BRIDGES.map((b, i) => i).filter(i => TTDData.BRIDGES[i].year <= this.world.year));
            const cur = t.opts.bridge;
            items = [['Bridge: ' + (cur < 0 ? 'cheapest' : TTDData.BRIDGES[cur].name + ' ' + TTDData.BRIDGES[cur].speed + 'km/h'), () => {
                const i = types.indexOf(cur);
                t.opts.bridge = types[(i + 1) % types.length];
            }]];
        }
        this.show('optbar', items.length > 0);
        this.opts.forEach((b, i) => {
            if (i < items.length) { b.setText(items[i][0]); b.onClick(() => { items[i][1](); this.renderOpts(); }); b.show(true); }
            else b.show(false);
        });
    }

    // --- Window -----------------------------------------------------------------------------------

    open(kind, ref) {
        if (this.win && this.win.kind === kind && this.win.ref === ref && kind !== 'vehicle') { this.close(); return; }
        this.win = { kind, ref, page: 0, sel: -1, tab: 0 };
        this.show('win', true);
        this.render();
    }

    close() {
        this.win = null;
        this.show('win', false);
        this.game.render && this.game.render.setArea(null);
        if (this.game.tool && this.game.tool.name === 'order') this.game.setTool(null);
        this.game.selected = null;
    }

    /** Fill the window: { title, text, info, rows: [[label, fn]], acts: [[label, fn]] }. */
    fill(d) {
        this.text('winTitle', d.title || '');
        this.text('winText', d.text || '');
        this.text('winInfo', d.info || '');
        const rows = d.rows || [];
        // With body text the rows sit below it ('wl'), otherwise at the top ('wr').
        const lower = !!d.text;
        const set = lower ? this.lrows : this.rows, other = lower ? this.rows : this.lrows;
        const acts0 = d.acts || [];
        const room = lower ? (acts0.length > 8 ? 9 : acts0.length > 4 ? 10 : 11) : d.info ? 11 : acts0.length > 4 ? 18 : 20;
        const per = Math.min(d.perPage || room, room, set.length);
        const pages = Math.max(1, Math.ceil(rows.length / per));
        const page = Math.min(this.win.page || 0, pages - 1);
        this.win.page = page;
        this.show('winPrev', pages > 1);
        this.show('winNext', pages > 1);
        for (const r of other) r.show(false);
        set.forEach((r, i) => {
            const item = rows[page * per + i];
            if (i < per && item) { r.setText(item[0]); r.onClick(item[1]); r.show(true); }
            else r.show(false);
        });
        const acts = d.acts || [];
        this.acts.forEach((b, i) => {
            if (i < acts.length) { b.setText(acts[i][0]); b.onClick(() => { acts[i][1](); this.render(); }); b.show(true); }
            else b.show(false);
        });
    }

    render() {
        if (!this.win || !this.world) return;
        const w = this.win;
        const fn = {
            vehicle: () => this.vVehicle(w.ref), depot: () => this.vDepot(w.ref), station: () => this.vStation(w.ref),
            town: () => this.vTown(w.ref), authority: () => this.vAuthority(w.ref), industry: () => this.vIndustry(w.ref),
            finances: () => this.vFinances(), company: () => this.vCompany(), subsidies: () => this.vSubsidies(),
            stations: () => this.vStations(), vlist: () => this.vVehicles(w.ref), towns: () => this.vTowns(),
            industries: () => this.vIndustries(), news: () => this.vNews(), menu: () => this.vMenu(), tile: () => this.vTile(w.ref),
            help: () => this.vHelp(), fund: () => this.vFund(),
        }[w.kind];
        if (fn) this.fill(fn());
    }

    // --- Views ------------------------------------------------------------------------------------

    vehicleStatus(v) {
        const w = this.world;
        if (v.state === 'crashed') return 'Crashed!';
        if (v.state === 'depot') return v.stopped ? 'Stopped in depot' : 'Leaving depot';
        if (v.stopped) return 'Stopped';
        if (v.broken > 0) return 'Broken down';
        if (v.state === 'load') { const st = w.stations[v.load ? v.load.station : -1]; return 'Loading / unloading at ' + (st ? st.name : '?'); }
        const dep = v.destDepot();
        if (dep >= 0 && v.type !== 'air') return 'Heading for depot' + (v.serviceDepot >= 0 ? ' (service)' : '');
        const st = w.stations[v.destStation()];
        if (st) return 'Heading for ' + st.name + ', ' + Math.round(v.speed) + ' km/h';
        return 'No orders';
    }

    orderText(o, i, cur) {
        const w = this.world;
        let s = (i === cur ? '> ' : '  ') + (i + 1) + ': ';
        if (o.kind === 'station') {
            const st = w.stations[o.dest];
            s += 'Go to ' + (st ? st.name : '(removed)');
            if (o.full) s += ' (Full load)';
            if (o.unload) s += ' (Unload)';
            if (o.transfer) s += ' (Transfer)';
            if (o.nonstop) s += ' (Non-stop)';
        } else {
            s += (o.stop ? 'Go to depot and stop' : 'Service at depot');
        }
        return s;
    }

    vVehicle(id) {
        const w = this.world, g = this.game, v = w.vehicles[id];
        if (!v) { this.close(); return {}; }
        g.selected = v;
        const e = v.spec;
        const caps = {};
        for (const car of v.cars) if (car.cap) caps[car.slot] = caps[car.slot] || { cap: 0, n: 0 }, caps[car.slot].cap += car.cap, caps[car.slot].n += v.cargoCount(car);
        const cargo = Object.keys(caps).map(s => w.cargo(Number(s)).name + ': ' + caps[s].n + ' / ' + caps[s].cap).join(', ');
        const rel = Math.round(v.reliability / 655.35);
        const lines = [
            this.vehicleStatus(v),
            e.name + (v.type === 'train' ? ' + ' + (v.cars.length - 1) + ' car(s)' : ''),
            'Age: ' + Math.floor(v.age / 365) + ' of ' + Math.floor(v.maxAge / 365) + ' years   Max speed: ' + v.maxSpeed() + ' km/h',
            'Reliability: ' + rel + '%   Breakdowns since last service: ' + v.breakdowns,
            'Profit this year: ' + Money.format(v.profitThis) + '   last year: ' + Money.format(v.profitLast),
            'Value: ' + Money.format(v.value) + '   Running cost: ' + Money.format(Vehicles.runningCost(w, v)) + '/yr',
            'Capacity: ' + (cargo || 'none'),
            'Service every ' + v.serviceInterval + ' days, last ' + Calendar.format(v.lastService, true),
            '',
            'Orders:',
        ];
        const sel = this.win.sel;
        const rows = v.orders.map((o, i) => [this.orderText(o, i, v.cur) + (i === sel ? '   <' : ''), () => { this.win.sel = i; this.render(); }]);
        rows.push(['  (end of orders)', () => { this.win.sel = -1; this.render(); }]);
        const o = v.orders[sel];
        const acts = [
            [v.stopped ? 'Start' : 'Stop', () => { v.stopped = !v.stopped; if (!v.stopped && !v.orders.length) g.error('This vehicle has no orders'); }],
            ['Go To…', () => { g.orderVehicle = v; g.setTool('order'); }],
            ['Delete', () => { if (o) { v.orders.splice(sel, 1); if (v.cur >= v.orders.length) v.cur = 0; v.onOrderChanged(); this.win.sel = -1; } }],
            ['Skip', () => { v.nextOrder(); }],
            ['Full load', () => { if (o && o.kind === 'station') { o.full = !o.full; if (o.full) o.unload = o.transfer = false; } }],
            ['Unload', () => { if (o && o.kind === 'station') { o.unload = !o.unload; if (o.unload) o.full = false; } }],
            ['Transfer', () => { if (o && o.kind === 'station') { o.transfer = !o.transfer; if (o.transfer) o.full = false; } }],
            ['Non-stop', () => { if (o && o.kind === 'station') o.nonstop = !o.nonstop; }],
            ['To depot', () => { g.sendToDepot(v); }],
            ['Center', () => { g.follow(v); }],
        ];
        if (v.state === 'depot') {
            acts.push(['Sell', () => { const err = Vehicles.sell(w, v); if (err) g.error(err); else { this.close(); g.money('+' + Money.format(v.value)); } }]);
            if (v.type === 'train') acts.push(['Add wagons', () => { this.open('depot', v.type === 'air' ? -1 : v.depot); this.win.tab = 1; this.win.train = v.id; this.render(); }]);
        }
        return { title: v.displayName() + (v.name ? '' : ' (' + e.name + ')'), text: lines.join('\n'), rows, perPage: 10, info: '', acts,
            infoLines: 0 };
    }

    /** Depot / hangar window: vehicles inside (tab 0) and the vehicles to buy (tab 1). */
    vDepot(id) {
        const w = this.world, g = this.game;
        const isHangar = id < 0 && this.win.hangar != null;
        const depot = isHangar ? null : w.depots[id];
        const hangar = isHangar ? w.stations[this.win.hangar] : null;
        if (!depot && !hangar) { this.close(); return {}; }
        const type = hangar ? 'air' : depot.kind === 'rail' ? 'rail' : depot.kind;
        const vtype = { rail: 'train', road: 'road', ship: 'ship', air: 'air' }[type];
        const inside = w.vehicles.filter(v => v && v.state === 'depot' && (hangar ? v.hangar === hangar.id : v.depot === id));
        const title = hangar ? hangar.name + ' hangar' : { rail: 'Train depot', road: 'Road vehicle depot', ship: 'Ship depot' }[depot.kind];
        const tab = this.win.tab || 0;
        const acts = [
            ['Vehicles (' + inside.length + ')', () => { this.win.tab = 0; this.win.sel = -1; this.win.page = 0; }],
            ['New vehicles', () => { this.win.tab = 1; this.win.sel = -1; this.win.page = 0; }],
        ];
        if (tab === 0) {
            const rows = inside.map(v => [v.displayName() + ' — ' + v.spec.name + (v.type === 'train' ? ' (' + v.cars.length + ' cars)' : '') + (v.stopped ? '' : ' ▶'), () => this.open('vehicle', v.id)]);
            acts.push(['Start all', () => { for (const v of inside) if (v.orders.length) v.stopped = false; }]);
            return { title, text: inside.length ? '' : 'No vehicles in this depot. Use "New vehicles" to buy one.', rows, acts };
        }
        const railType = depot && depot.kind === 'rail' ? w.map.railType[depot.t] : null;
        let list = w.buyable(type, railType);
        if (type === 'air' && hangar && hangar.airport && hangar.airport.type === 2) list = list.filter(e => e.heli);
        const trains = /** @type {Train[]} */ (inside.filter(v => v instanceof Train && v.hasEngine()));
        const target = trains.find(v => v.id === this.win.train) || trains[trains.length - 1];
        const rows = list.map((e, i) => [e.name + ' — ' + Money.format(Vehicles.price(w, e)), () => { this.win.sel = i; this.render(); }]);
        const e = list[this.win.sel];
        let info = 'Select a vehicle to see its details.';
        if (e) {
            const cap = e.type === 'air' ? e.capacity + ' passengers, ' + e.mail + ' bags of mail' : e.capacity ? e.capacity + ' ' + (w.cargo(e.cargo) ? w.cargo(e.cargo).name.toLowerCase() : '') : 'none';
            info = [e.name,
                'Cost: ' + Money.format(Vehicles.price(w, e)) + (e.wagon ? '' : '   Running cost: ' + Money.format(Vehicles.engineRunning(w, e)) + '/yr'),
                e.wagon ? 'Weight: ' + e.weight + ' t' : 'Speed: ' + Vehicles.speedKmh(e) + ' km/h' + (e.type === 'rail' ? '   Power: ' + e.power + ' hp   Weight: ' + e.weight + ' t' : ''),
                'Capacity: ' + cap,
                'Designed: ' + Calendar.toYMD(w.engines[e.id].intro).y + '   Life: ' + e.life + ' years',
                'Reliability: ' + Math.round(w.engines[e.id].reliability / 655.35) + '%',
                e.wagon ? (target ? 'Will be attached to ' + target.displayName() : 'Buy an engine first, then add wagons to it') : ''].join('\n');
        }
        acts.push([e && e.wagon ? 'Add wagon' : 'Buy', () => {
            if (!e) return;
            if (e.wagon) {
                if (!target) { g.error('No train in this depot to attach the wagon to'); return; }
                const err = Vehicles.addWagon(w, target, e.id);
                if (err) g.error(err); else g.money('-' + Money.format(Vehicles.price(w, e)));
                return;
            }
            const v = Vehicles.build(w, e.id, hangar ? hangar.id : id);
            if (typeof v === 'string') { g.error(v); return; }
            g.money('-' + Money.format(v.value));
            this.win.train = v.id;
            if (v.type !== 'train') this.open('vehicle', v.id);
        }]);
        return { title, text: '', rows, info, acts };
    }

    vStation(id) {
        const w = this.world, st = w.stations[id];
        if (!st) { this.close(); return {}; }
        const lines = [];
        const fac = [];
        if (st.facilities & 1) fac.push('railway'); if (st.facilities & 4) fac.push('bus'); if (st.facilities & 2) fac.push('lorry');
        if (st.facilities & 8) fac.push('airport'); if (st.facilities & 16) fac.push('dock');
        lines.push('Facilities: ' + fac.join(', '));
        lines.push('', 'Waiting:');
        let any = false;
        for (let s = 0; s < 12; s++) {
            const c = w.cargo(s), g = st.goods[s];
            if (!c || !g.active) continue;
            any = true;
            lines.push('  ' + c.name + ': ' + st.waiting(s) + ' ' + c.unit + '   rating ' + Math.round(g.rating / 2.55) + '%');
        }
        if (!any) lines.push('  nothing');
        lines.push('', 'Accepts: ' + (st.accepts.map((a, s) => a && w.cargo(s) ? w.cargo(s).name : null).filter(Boolean).join(', ') || 'nothing'));
        const users = w.vehicles.filter(v => v && v.orders.some(o => o.kind === 'station' && o.dest === id));
        lines.push('', 'Vehicles with orders here: ' + users.length);
        const town = w.towns[st.town];
        if (town) lines.push('Town: ' + town.name);
        lines.push('Built: ' + Calendar.format(st.built, true));
        const acts = [
            ['Center', () => this.game.lookAtTile(st.xy)],
            ['Catchment', () => { this.game.render.setArea(this.game.render.areaMesh ? null : st.catchment(w.map)); }],
        ];
        if (st.airport) acts.push(['Hangar', () => { this.win = { kind: 'depot', ref: -1, page: 0, sel: -1, tab: 0, hangar: st.id }; this.render(); }]);
        return { title: st.name, text: lines.join('\n'), acts, rows: users.map(v => [v.displayName() + ' — ' + this.vehicleStatus(v), () => this.open('vehicle', v.id)]), perPage: 6, info: ' ' };
    }

    vTown(id) {
        const w = this.world, town = w.towns[id];
        if (!town) { this.close(); return {}; }
        const r = town.rating(0);
        const pax = town.lastPaxMax ? Math.round(town.lastPaxAct * 100 / town.lastPaxMax) : 0;
        const mail = town.lastMailMax ? Math.round(town.lastMailAct * 100 / town.lastMailMax) : 0;
        const days = town.growthRate < (1 << 29) ? Math.round(town.growthRate * Town.TICKS / 74) : -1;
        const lines = [
            'Population: ' + town.population + '   Houses: ' + town.numHouses,
            'Passengers last month: ' + town.lastPaxAct + '  max: ' + town.lastPaxMax + ' (' + pax + '% transported)',
            'Mail last month: ' + town.lastMailAct + '  max: ' + town.lastMailMax + ' (' + mail + '% transported)',
            'Goods delivered last month: ' + town.lastGoods,
        ];
        if (w.climate === 1 && w.map.zone[town.xy] === GameMap.Z_DESERT) {
            lines.push('Desert town: needs Food and Water to grow', '  Food last month: ' + town.lastFood + '   Water last month: ' + town.lastWater);
        }
        lines.push(days > 0 ? 'Town grows every ' + days + ' days' + (town.fundMonths ? ' (funded)' : '') : 'Town is not growing');
        lines.push('', 'Local authority rating of ' + w.player.name + ':', '  ' + Town.ratingName(r) + ' (' + r + ')');
        if (town.statues[0]) lines.push('  A statue of the company owner stands here.');
        if (town.exclusive === 0) lines.push('  Exclusive transport rights: ' + town.exclusiveMonths + ' months left');
        return {
            title: town.name, text: lines.join('\n'),
            acts: [['Center', () => this.game.lookAtTile(town.xy)], ['Local authority', () => this.open('authority', id)]],
        };
    }

    vAuthority(id) {
        const w = this.world, town = w.towns[id], g = this.game;
        if (!town) { this.close(); return {}; }
        const rows = Towns.ACTIONS.map((a, i) => [a.name + ' — ' + Money.format(w.price('buildIndustry') / 256 * a.factor), () => {
            const r = Commands.townAction(w, town, i, true);
            if (!r.ok) g.error(r.err); else g.money('-' + Money.format(r.cost));
            this.render();
        }]);
        return { title: town.name + ' local authority', text: 'Rating: ' + Town.ratingName(town.rating(0)) + '\n\nActions available:', rows: rows.map(r => r), info: ' ',
            acts: [['Back', () => this.open('town', id)]] };
    }

    vIndustry(id) {
        const w = this.world, ind = w.industries[id];
        if (!ind) { this.close(); return {}; }
        const lines = [];
        for (const p of ind.produced) {
            const c = w.cargo(p.slot);
            lines.push('Production last month: ' + p.lastMonth + ' ' + c.unit + ' of ' + c.name + ' (' + Math.round(p.pctLast * 100 / 256) + '% transported)');
        }
        if (ind.accepts.length) lines.push('Requires: ' + ind.accepts.map(s => w.cargo(s).name).join(', '));
        if (ind.accepts.length && ind.produced.length && !ind.spec.produces[0][1]) lines.push('Delivered last month: ' + ind.deliveredLast + ' (becomes ' + w.cargo(ind.produced[0].slot).name + ')');
        else if (ind.accepts.length) lines.push('Delivered last month: ' + ind.deliveredLast);
        lines.push('Founded: ' + ind.founded);
        return { title: Industries.name(w, ind), text: lines.join('\n'), acts: [['Center', () => this.game.lookAtTile(ind.xy)]] };
    }

    vFinances() {
        const w = this.world, c = w.player, y = w.year;
        const lines = ['Category                ' + y + '        ' + (y - 1)];
        Company.CATS.forEach((name, i) => {
            const a = c.finances[0][i], b = c.finances[1][i];
            if (!a && !b) return;
            lines.push(name + ':   ' + Money.format(a) + '    ' + Money.format(b));
        });
        const tot = (k) => c.finances[k].reduce((s, v) => s + v, 0);
        lines.push('Total:   ' + Money.format(tot(0)) + '    ' + Money.format(tot(1)));
        lines.push('', 'Bank balance: ' + Money.format(c.money), 'Loan: ' + Money.format(c.loan) + '   Maximum loan: ' + Money.format(w.maxLoan),
            'Interest rate: ' + w.economy.interest + '%' + (w.economy.recession ? '   RECESSION' : ''));
        const g = this.game;
        const step = Money.format(Company.LOAN_STEP);
        return {
            title: w.player.name + ' Finances', text: lines.join('\n'),
            acts: [['Borrow ' + step, () => { const r = Commands.borrow(w, false); if (!r.ok) g.error(r.err); }],
                ['Repay ' + step, () => { const r = Commands.repay(w, false); if (!r.ok) g.error(r.err); }],
                ['Borrow max', () => { const r = Commands.borrow(w, true); if (!r.ok) g.error(r.err); }],
                ['Repay all', () => { const r = Commands.repay(w, true); if (!r.ok) g.error(r.err); }]],
        };
    }

    vCompany() {
        const w = this.world, c = w.player;
        const count = (t) => w.vehicles.filter(v => v && v.owner === 0 && v.type === t).length;
        const q = c.quarters[0];
        const lines = [
            'President: ' + c.president, 'Inaugurated: ' + c.inaugurated,
            'Company value: ' + Money.format(w.companyValue(c)),
            'Vehicles: ' + count('train') + ' trains, ' + count('road') + ' road vehicles, ' + count('ship') + ' ships, ' + count('air') + ' aircraft',
            'Stations: ' + w.stations.filter(s => s && s.owner === 0).length,
            '', 'Performance rating: ' + c.score + ' / 1000 (' + World.scoreTitle(c.score) + ')',
        ];
        if (q) lines.push('Last quarter: income ' + Money.format(q.income) + ', expenses ' + Money.format(q.expenses) + ', ' + q.delivered + ' units delivered');
        lines.push('This quarter: income ' + Money.format(c.cur.income) + ', expenses ' + Money.format(c.cur.expenses) + ', ' + c.cur.delivered + ' units delivered');
        if (c.bankruptcy) lines.push('', 'WARNING: money below zero for ' + c.bankruptcy + ' quarter(s)!');
        return { title: c.name, text: lines.join('\n'), acts: [] };
    }

    vSubsidies() {
        const w = this.world;
        const offers = w.subsidies.filter(s => !s.awarded), awarded = w.subsidies.filter(s => s.awarded);
        const lines = ['Subsidies on offer for services taking:'];
        if (!offers.length) lines.push('  None');
        for (const s of offers) lines.push('  ' + Subsidies.describe(w, s) + ' (by ' + Calendar.format(w.date + (12 - s.months) * 30) + ')');
        lines.push('', 'Services already subsidised:');
        if (!awarded.length) lines.push('  None');
        for (const s of awarded) lines.push('  ' + Subsidies.describe(w, s) + ' (' + w.companies[s.company].name + ', until ' + Calendar.format(w.date + (12 - s.months) * 30) + ')');
        return { title: 'Subsidies', text: lines.join('\n') };
    }

    vStations() {
        const w = this.world;
        const list = w.stations.filter(s => s && s.owner === 0);
        const rows = list.map(st => {
            const parts = [];
            for (let s = 0; s < 12; s++) { const n = st.waiting(s); if (n) parts.push(n + ' ' + w.cargo(s).name.toLowerCase()); }
            return [st.name + (parts.length ? ' — ' + parts.slice(0, 3).join(', ') : ''), () => { this.open('station', st.id); this.game.lookAtTile(st.xy); }];
        });
        return { title: 'Stations (' + list.length + ')', text: list.length ? '' : 'No stations', rows };
    }

    vVehicles(type) {
        const w = this.world;
        const list = w.vehicles.filter(v => v && v.owner === 0 && v.type === type).sort((a, b) => a.unit - b.unit);
        const title = { train: 'Trains', road: 'Road Vehicles', ship: 'Ships', air: 'Aircraft' }[type];
        const rows = list.map(v => [v.displayName() + ' — ' + Money.format(v.profitThis) + ' — ' + this.vehicleStatus(v), () => { this.open('vehicle', v.id); this.game.follow(v); }]);
        const total = list.reduce((s, v) => s + v.profitThis, 0);
        return { title: title + ' (' + list.length + ')', text: list.length ? '' : 'None. Build a depot, then buy vehicles in it.', rows, info: ' ',
            acts: [['Profit: ' + Money.format(total), () => {}]] };
    }

    vTowns() {
        const w = this.world;
        const list = w.towns.slice().sort((a, b) => b.population - a.population);
        const total = list.reduce((s, t) => s + t.population, 0);
        return { title: 'Towns (' + list.length + ', population ' + total + ')', rows: list.map(t => [t.name + ' — ' + t.population, () => { this.open('town', t.id); this.game.lookAtTile(t.xy); }]) };
    }

    vIndustries() {
        const w = this.world;
        const list = w.industries.filter(Boolean);
        const rows = list.map(ind => {
            const p = ind.produced.map(p => p.lastMonth + ' ' + w.cargo(p.slot).name.toLowerCase() + ' (' + Math.round(p.pctLast * 100 / 256) + '%)').join(', ');
            return [Industries.name(w, ind) + (p ? ' — ' + p : ''), () => { this.open('industry', ind.id); this.game.lookAtTile(ind.xy); }];
        });
        return { title: 'Industries (' + list.length + ')', rows, acts: [['Fund new…', () => this.open('fund')]] };
    }

    vFund() {
        const w = this.world, g = this.game;
        const types = Industries.typesFor(w.climate).filter(id => id !== 5);
        const rows = types.map(id => {
            const s = TTDData.INDUSTRIES[id];
            const cost = w.price('buildIndustry') / 256 * s.cost;
            return [s.name + ' — ' + Money.format(cost), () => {
                if (w.player.money < cost) { g.error('Not enough cash - requires ' + Money.format(cost)); return; }
                const ind = Industries.place(w, id, 400);
                if (!ind) { g.error('Can\'t find a suitable site for a ' + s.name); return; }
                w.player.spend(cost, Company.C_CONSTRUCTION);
                w.addNews('New ' + s.name + ' funded near ' + (w.towns[ind.town] ? w.towns[ind.town].name : '?') + '!', { tile: ind.xy, kind: 'economy' });
                g.lookAtTile(ind.xy);
            }];
        });
        return { title: 'Fund new industry', text: 'The industry is built on a random suitable site.', rows: rows, info: ' ', perPage: 12 };
    }

    vNews() {
        const w = this.world;
        return { title: 'Message history', rows: w.news.map(n => [Calendar.format(n.date) + ': ' + n.text, () => { if (n.tile >= 0) this.game.lookAtTile(n.tile); }]) };
    }

    vMenu() {
        const g = this.game;
        const has = !!Store.get(Game.SAVE_KEY), auto = !!Store.get(Game.AUTOSAVE_KEY);
        return {
            title: 'Game', text: 'Transport Tycoon Deluxe rules in 3D on ArcEngine.\n\nSaves go to this browser (local storage).',
            rows: [
                ['New game…', () => this.showNewGame()],
                ['Save game', () => { if (g.saveGame(Game.SAVE_KEY)) g.info('Game saved'); }],
                [(has ? '' : '(no save) ') + 'Load game', () => { if (g.loadGame(Game.SAVE_KEY)) this.close(); }],
                [(auto ? '' : '(no autosave) ') + 'Load autosave', () => { if (g.loadGame(Game.AUTOSAVE_KEY)) this.close(); }],
                ['Currency: ' + Money.CURRENCIES[Money.currency].id, () => { Money.currency = (Money.currency + 1) % Money.CURRENCIES.length; this.world.settings.currency = Money.currency; this.render(); }],
                ['Game speed: fast forward x' + g.ffMult, () => { g.ffMult = g.ffMult >= 16 ? 2 : g.ffMult * 2; this.render(); }],
                ['Help and keys', () => this.open('help')],
            ],
        };
    }

    vHelp() {
        return {
            title: 'Help', text: [
                'Camera: WASD / arrows fly, wheel zooms, left drag (no tool) or',
                'middle drag scrolls, right drag turns, Q/E up/down, R resets.',
                'Esc cancels the tool, P pauses, F fast-forwards.',
                '',
                'Getting started (as in TTD):',
                '1. Railway > Station: place a station near a town or industry',
                '   (the blue area is the catchment).',
                '2. Railway > Track: drag to lay track (diagonal drags lay',
                '   diagonal track). Railway > Depot next to the track.',
                '3. Click the depot, "New vehicles", buy an engine, then add',
                '   wagons for the cargo.',
                '4. In the train window: Go To…, click station A, Go To…,',
                '   click station B, then Start.',
                'Road vehicles: road + bus/lorry stops + road depot.',
                'Income: distance x amount x cargo rate, less for slow delivery.',
                'Signals split the line into blocks: one train per block.',
                'Sub-tropical towns in the desert need food and water to grow.',
            ].join('\n'),
        };
    }

    showTile(t) { this.open('tile', t); }

    vTile(t) {
        const w = this.world, map = w.map;
        const k = map.type[t];
        const names = ['Clear land', 'Railway track', 'Road', 'Town building', 'Trees', 'Station', 'Water', 'Industry', 'Bridge / tunnel', 'Object'];
        const lines = ['Tile ' + map.tx(t) + ', ' + map.ty(t) + '   height ' + map.tileMinZ(t) + (map.slope(t) ? ' (sloped)' : '')];
        lines.push('Type: ' + names[k]);
        if (k === GameMap.T_CLEAR) lines.push('Ground: ' + ['Grass', 'Rough land', 'Rocks', 'Fields', 'Snow', 'Desert'][map.ground[t]]);
        if (k === GameMap.T_HOUSE) { const h = TTDData.HOUSES[map.sub[t]]; lines.push(h.name + ' (' + h.pop + ' people)', 'Accepts: passengers ' + h.accPax + '/8, mail ' + h.accMail + '/8, goods ' + h.accGoods + '/8' + (w.climate === 1 ? ', food ' + h.accFood + '/8' : '')); }
        if (w.climate === 1) lines.push('Zone: ' + ['Normal', 'Desert', 'Rainforest'][map.zone[t]]);
        const town = map.town[t] >= 0 ? w.towns[map.town[t]] : w.nearestTown(t);
        if (town) lines.push('Town: ' + town.name);
        const c = Commands.demolish(w, t, false);
        lines.push('Cost to clear: ' + (c.ok ? Money.format(c.cost) : c.err));
        return { title: 'Land Area Information', text: lines.join('\n') };
    }

    /** The order tool picked a tile: a station or depot of the selected vehicle's kind. */
    orderPicked(t) {
        const g = this.game, w = this.world, v = g.orderVehicle;
        if (!v || !w.vehicles[v.id]) { g.setTool(null); return; }
        const st = w.stationAt(t);
        const dep = w.depotAt(t);
        let order = null;
        if (st) {
            const ok = { train: 1, road: 2 | 4, ship: 16, air: 8 }[v.type] & st.facilities;
            if (!ok) { g.error('This station can\'t be used by this vehicle'); return; }
            order = { kind: 'station', dest: st.id, full: false, unload: false, transfer: false, nonstop: false };
        } else if (dep && dep.kind === { train: 'rail', road: 'road', ship: 'ship' }[v.type]) {
            order = { kind: 'depot', dest: dep.id, stop: false };
        } else {
            g.error('Select a station or depot');
            return;
        }
        const at = this.win && this.win.sel >= 0 ? this.win.sel : v.orders.length;
        v.orders.splice(at, 0, order);
        if (this.win && this.win.sel >= 0) this.win.sel++;
        v.onOrderChanged();
        this.render();
    }

    // --- New game dialog ------------------------------------------------------------------------------

    showNewGame(first) {
        this.ng = Object.assign({}, this.world ? this.world.settings : World.defaultSettings());
        this.ng.seed = 0;
        this.text('ngSub', first ? 'Settings default to your openttd.cfg (TTD.zip). Click an option to change it.' : 'New game');
        this.show('ngResume', !!this.world && !first);
        this.show('ngLoad', !!Store.get(Game.SAVE_KEY));
        this.renderNewGame();
        this.show('ngDim', true);
    }

    renderNewGame() {
        const s = this.ng;
        const cyc = (key, n) => () => { s[key] = (s[key] + 1) % n; this.renderNewGame(); };
        const L = (a, i) => a[IMath.clamp(i, 0, a.length - 1)];
        const items = [
            ['Climate: ' + TTDData.CLIMATE_NAMES[s.climate], cyc('climate', 2)],
            ['Map size: ' + (1 << s.mapLog2) + ' x ' + (1 << s.mapLog2), () => { s.mapLog2 = s.mapLog2 >= 8 ? 6 : s.mapLog2 + 1; this.renderNewGame(); }],
            ['Start year: ' + s.startYear, () => { const Y = [1930, 1941, 1950, 1960, 1970, 1980, 1990, 2000]; s.startYear = Y[(Y.indexOf(s.startYear) + 1) % Y.length] || 1950; this.renderNewGame(); }],
            ['Number of towns: ' + L(['Low', 'Normal', 'High'], s.towns), cyc('towns', 3)],
            ['Number of industries: ' + L(['None', 'Low', 'Normal', 'High'], s.industries), cyc('industries', 4)],
            ['Terrain: ' + L(['Very flat', 'Flat', 'Hilly', 'Mountainous'], s.terrain), cyc('terrain', 4)],
            ['Sea level: ' + L(['Very low', 'Low', 'Medium', 'High'], s.sea), cyc('sea', 4)],
            ['Maximum initial loan: ' + Money.format(s.maxLoan), () => { s.maxLoan = s.maxLoan >= 500000 ? 100000 : s.maxLoan + 50000; this.renderNewGame(); }],
            ['Interest rate: ' + s.interest + '%', () => { s.interest = s.interest >= 4 ? 2 : s.interest + 1; this.renderNewGame(); }],
            ['Construction costs: ' + L(['Low', 'Medium', 'High'], s.constructionCosts) + '   Running costs: ' + L(['Low', 'Medium', 'High'], s.vehicleCosts), () => { s.constructionCosts = (s.constructionCosts + 1) % 3; this.renderNewGame(); }],
            ['Vehicle breakdowns: ' + L(['None', 'Reduced', 'Normal'], s.breakdowns), cyc('breakdowns', 3)],
            ['Economy: ' + L(['Steady', 'Variable'], s.economy) + '   Inflation: ' + (s.inflation ? 'on' : 'off'), () => { if (s.economy && s.inflation) { s.inflation = 0; } else if (s.economy) { s.economy = 0; s.inflation = 1; } else { s.economy = 1; s.inflation = 1; } this.renderNewGame(); }],
            ['Town names: ' + L(['English', 'Catalan'], s.townNames) + '   Town council: ' + L(['Permissive', 'Tolerant', 'Hostile'], s.townTolerance), () => { s.townNames = (s.townNames + 1) % 2; this.renderNewGame(); }],
            ['Subsidy multiplier: ' + L(['x1.5', 'x2', 'x3', 'x4'], s.subsidyMult) + '   Currency: ' + Money.CURRENCIES[s.currency].id, () => { s.subsidyMult = (s.subsidyMult + 1) % 4; if (s.subsidyMult === 0) s.currency = (s.currency + 1) % Money.CURRENCIES.length; this.renderNewGame(); }],
        ];
        this.ngs.forEach((b, i) => {
            if (i < items.length) { b.setText(items[i][0]); b.onClick(items[i][1]); b.show(true); }
            else b.show(false);
        });
    }

    startNewGame() {
        this.show('ngDim', false);
        this.close();
        this.game.newGame(this.ng);
    }

    // --- Status bar, messages, news -------------------------------------------------------------------

    error(msg) {
        this.text('msgText', msg);
        this.show('msg', true);
        this._msgT = 3.5;
    }

    onNews(item) {
        if (!item.big) return;
        this.newsItem = item;
        this.text('newsHead', Calendar.format(item.date, true).toUpperCase() + '  —  ' + (item.kind === 'accident' ? 'ACCIDENT' : item.kind === 'subsidy' ? 'SUBSIDY' : item.kind === 'vehicle' ? 'NEW VEHICLE' : 'NEWS'));
        this.text('newsText', Gui.wrap(item.text, 70));
        this.show('newsGo', item.tile >= 0);
        this.show('newsBox', true);
        this._newsT = 8;
    }

    static wrap(s, n) {
        const words = String(s).split(' '), lines = [];
        let cur = '';
        for (const w of words) {
            if ((cur + ' ' + w).trim().length > n) { lines.push(cur.trim()); cur = w; }
            else cur += ' ' + w;
        }
        if (cur.trim()) lines.push(cur.trim());
        return lines.slice(0, 3).join('\n');
    }

    update(dt) {
        const w = this.world, g = this.game;
        if (this._msgT > 0 && (this._msgT -= dt) <= 0) this.show('msg', false);
        if (this._newsT > 0 && (this._newsT -= dt) <= 0) this.show('newsBox', false);
        if (!w) return;
        this.text('st_date', Calendar.format(w.date, true));
        this.text('st_money', Money.format(w.player.money));
        this.text('st_speed', g.paused ? 'PAUSED' : g.fast ? 'FAST x' + g.ffMult : '');
        const n = w.news[0];
        this.text('st_news', n ? Gui.wrap(n.text, 90).split('\n')[0] : '');
        this._refresh -= dt;
        if (this._refresh <= 0) {
            this._refresh = 0.5;
            this.render();
        }
    }
}
