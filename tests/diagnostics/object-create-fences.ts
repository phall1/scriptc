// Statically shaped records cannot serve as live checked-dynamic prototypes.
const base = { indent: 2 };
const viaRecord = Object.create(base);
base.indent = 4;
