// TTDUtil.js — shared helpers of the Transport Tycoon Deluxe remake: seeded random numbers,
// the four tile directions, calendar dates, money formatting. No Babylon, no DOM: the
// simulation files (GameMap, World, …) and the tests in node:vm use it the same way.
//
// Tile directions follow TTD's DiagDirection: 0 NE, 1 SE, 2 SW, 3 NW. On the map
// x grows toward SW and y toward SE (tile (0, 0) is the north corner), so
//   NE = (−1, 0), SE = (0, +1), SW = (+1, 0), NW = (0, −1).

/** Deterministic random numbers (mulberry32): the same seed builds the same world. */
class Rng {
    /** @param {number} seed */
    constructor(seed) {
        this.s = (seed >>> 0) || 0x9e3779b9;
    }

    /** 32 random bits. */
    next() {
        let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return (t ^ (t >>> 14)) >>> 0;
    }

    /** [0, 1) */
    float() { return this.next() / 4294967296; }

    /** Integer in [0, n). */
    int(n) { return n > 0 ? Math.floor(this.float() * n) : 0; }

    /** Integer in [a, b]. */
    range(a, b) { return a + this.int(b - a + 1); }

    /** true with probability a / b — TTD's Chance16(a, b). */
    chance(a, b) { return this.int(b) < a; }

    pick(list) { return list.length ? list[this.int(list.length)] : undefined; }

    shuffle(list) {
        for (let i = list.length - 1; i > 0; i--) {
            const j = this.int(i + 1);
            const t = list[i]; list[i] = list[j]; list[j] = t;
        }
        return list;
    }
}

/** @satisfies {Record<string, any>} */
const Dir = {
    NE: 0, SE: 1, SW: 2, NW: 3,
    DX: [-1, 0, 1, 0],
    DY: [0, 1, 0, -1],
    NAMES: ['NE', 'SE', 'SW', 'NW'],
    reverse(d) { return (d + 2) & 3; },
    /** Axis of a direction: 0 — X (NE/SW), 1 — Y (SE/NW). */
    axis(d) { return d & 1; },
    /** Heading on the map (rad, atan2(vy, vx)) of a move in direction d. */
    heading(d) { return Math.atan2(Dir.DY[d], Dir.DX[d]); },
    /** Direction from one tile to an adjacent one; -1 — not adjacent. */
    between(ax, ay, bx, by) {
        for (let d = 0; d < 4; d++) if (ax + Dir.DX[d] === bx && ay + Dir.DY[d] === by) return d;
        return -1;
    },
};

/** Calendar: a date is a whole number of days since 1 Jan 1900 (UTC). */
/** @satisfies {Record<string, any>} */
const Calendar = {
    EPOCH: Date.UTC(1900, 0, 1),
    DAY_MS: 86400000,
    MONTHS: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],

    fromYMD(y, m, d) { return Math.round((Date.UTC(y, m, d) - Calendar.EPOCH) / Calendar.DAY_MS); },

    /** @returns {{ y: number, m: number, d: number }} m — 0..11, d — 1..31 */
    toYMD(days) {
        const t = new Date(Calendar.EPOCH + days * Calendar.DAY_MS);
        return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
    },

    /** "12th Mar 1950" (long) or "Mar 1950". */
    format(days, long) {
        const { y, m, d } = Calendar.toYMD(days);
        if (!long) return Calendar.MONTHS[m] + ' ' + y;
        const suf = (d % 10 === 1 && d !== 11) ? 'st' : (d % 10 === 2 && d !== 12) ? 'nd' : (d % 10 === 3 && d !== 13) ? 'rd' : 'th';
        return d + suf + ' ' + Calendar.MONTHS[m] + ' ' + y;
    },

    /** Year as a fraction: 1950.5 — the middle of 1950. */
    yearFloat(days) {
        const { y } = Calendar.toYMD(days);
        const a = Calendar.fromYMD(y, 0, 1), b = Calendar.fromYMD(y + 1, 0, 1);
        return y + (days - a) / (b - a);
    },
};

/** Money: kept in pounds sterling like TTD, shown in the chosen currency. */
/** @satisfies {Record<string, any>} */
const Money = {
    // TTD's currencies: rate against the pound and the sign.
    CURRENCIES: [
        { id: 'GBP', rate: 1, prefix: '£', suffix: '' },
        { id: 'USD', rate: 2, prefix: '$', suffix: '' },
        { id: 'EUR', rate: 2, prefix: '€', suffix: '' },
        { id: 'RUR', rate: 50, prefix: '', suffix: ' rub' },
    ],
    currency: 1,

    /** Pounds -> "$1,234,567" in the current currency (negative with a minus). */
    format(pounds) {
        const c = Money.CURRENCIES[Money.currency] || Money.CURRENCIES[0];
        const v = Math.round((Number(pounds) || 0) * c.rate);
        const s = Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (v < 0 ? '-' : '') + c.prefix + s + c.suffix;
    },

    /** A speed in km/h as the game shows it (metric units). */
    speed(kmh) { return Math.round(kmh) + ' km/h'; },
};

/** Integer helpers. */
/** @satisfies {Record<string, any>} */
const IMath = {
    clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
    /** Number of set bits. */
    bits(n) { let c = 0; while (n) { c += n & 1; n >>>= 1; } return c; },
    /** Manhattan distance between two tiles — TTD's DistanceManhattan. */
    manhattan(ax, ay, bx, by) { return Math.abs(ax - bx) + Math.abs(ay - by); },
    /** TTD's DistanceMax (Chebyshev). */
    distMax(ax, ay, bx, by) { return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); },
    /** Binary heap for A*: push(item, priority), pop() -> item with the lowest priority. */
    heap() {
        const items = [], pri = [];
        return {
            get size() { return items.length; },
            push(item, p) {
                let i = items.length;
                items.push(item); pri.push(p);
                while (i > 0) {
                    const up = (i - 1) >> 1;
                    if (pri[up] <= p) break;
                    items[i] = items[up]; pri[i] = pri[up];
                    i = up;
                }
                items[i] = item; pri[i] = p;
            },
            pop() {
                const top = items[0];
                const last = items.pop(), lp = pri.pop();
                if (items.length) {
                    let i = 0;
                    const n = items.length;
                    for (;;) {
                        let c = 2 * i + 1;
                        if (c >= n) break;
                        if (c + 1 < n && pri[c + 1] < pri[c]) c++;
                        if (pri[c] >= lp) break;
                        items[i] = items[c]; pri[i] = pri[c];
                        i = c;
                    }
                    items[i] = last; pri[i] = lp;
                }
                return top;
            },
        };
    },
};
