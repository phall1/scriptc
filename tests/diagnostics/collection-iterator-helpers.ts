// Stored collection cursors support next/iteration, but helper methods are
// refused explicitly instead of dispatching to array helpers at runtime.
const map = new Map<string, number>();
const values = map.values();
values.map(value => value + 1);
map.keys().toArray();
const set = new Set<number>();
set.values().filter(value => value > 0);
set.entries().take(1);
// Each helper call must produce a diagnostic.
