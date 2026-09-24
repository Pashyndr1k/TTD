// TTDCompany.js — the player's transport company: money, loan (TTD's £10,000 steps up to the
// difficulty's maximum), the yearly finance table with TTD's 13 categories, quarterly results
// (income, expenses, cargo delivered, performance score), company value and the bankruptcy
// counter.

class Company {
    constructor(id, name) {
        this.id = id;
        this.name = name;
        this.president = 'J. Smith';
        this.color = '#1d4f9a';
        this.money = 0;
        this.loan = 0;
        this.inaugurated = 0;
        /** Yearly finances: [this year, last year, the year before], each 13 categories (£). */
        this.finances = [Company.emptyYear(), Company.emptyYear(), Company.emptyYear()];
        /** Quarters, newest first: { income, expenses, delivered, value, score }. */
        this.quarters = [];
        this.cur = Company.emptyQuarter();
        this.bankruptcy = 0;
        this.hq = -1;
        this.unit = { train: 0, road: 0, ship: 0, air: 0 };
        this.score = 0;
    }

    static emptyYear() { return new Array(13).fill(0); }
    static emptyQuarter() { return { income: 0, expenses: 0, delivered: 0, cargoTypes: 0 }; }

    /** Pay (positive amount) into a category; income is a negative expense. */
    spend(amount, cat) {
        this.money -= amount;
        this.finances[0][cat] -= amount;
        if (amount > 0) this.cur.expenses += amount; else this.cur.income -= amount;
    }

    earn(amount, cat) { this.spend(-amount, cat); }

    canAfford(amount) { return amount <= 0 || this.money >= amount; }

    /** Next free unit number of a vehicle type (TTD numbers each kind from 1). */
    nextUnit(world, type) {
        const used = new Set(world.vehicles.filter(v => v && v.owner === this.id && v.type === type).map(v => v.unit));
        let n = 1;
        while (used.has(n)) n++;
        return n;
    }

    toJSON() { return Object.assign({}, this); }

    static fromJSON(o) {
        const c = new Company(o.id, o.name);
        Object.assign(c, o);
        return c;
    }
}

Company.CATS = ['Construction', 'New Vehicles', 'Train Running Costs', 'Road Vehicle Running Costs',
    'Aircraft Running Costs', 'Ship Running Costs', 'Property Maintenance', 'Train Income',
    'Road Vehicle Income', 'Aircraft Income', 'Ship Income', 'Loan Interest', 'Other'];
Company.C_CONSTRUCTION = 0;
Company.C_NEW_VEHICLES = 1;
Company.C_RUN = { train: 2, road: 3, air: 4, ship: 5 };
Company.C_PROPERTY = 6;
Company.C_INCOME = { train: 7, road: 8, air: 9, ship: 10 };
Company.C_INTEREST = 11;
Company.C_OTHER = 12;
Company.LOAN_STEP = 10000;

/** TTD's performance score parts: needed value and points (_score_info). */
Company.SCORE = [
    { name: 'Vehicles', needed: 120, points: 100 },
    { name: 'Stations', needed: 80, points: 100 },
    { name: 'Min. profit', needed: 10000, points: 100 },
    { name: 'Min. income', needed: 50000, points: 50 },
    { name: 'Max. income', needed: 100000, points: 100 },
    { name: 'Delivered', needed: 40000, points: 400 },
    { name: 'Cargo', needed: 8, points: 50 },
    { name: 'Money', needed: 10000000, points: 50 },
    { name: 'Loan', needed: 250000, points: 50 },
];
