function append(values) { values.push(3); return values; }
function pair(first, second) { console.log('same', first === second); first.push(4); }
function variadic(...values) { values[0].push(5); return values[0]; }
function fromArguments() { arguments[0].push(6); return arguments[0]; }
const values = [1, 2];
console.log('call', append(values) === values, values.join(','));
pair(values, values);
console.log('pair', values.join(','));
console.log('rest', variadic(values) === values, values.join(','));
console.log('arguments', fromArguments(values) === values, values.join(','));
function wrap() { return values; }
console.log('return', wrap() === values);
const object = { values };
object.values.push(7);
console.log('property', object.values === values, values.join(','));
class Empty { visit() {} }
class Collector extends Empty { visit(target) { target.push(8); } }
function dispatch(object, target) { return object.visit(target); }
const result = dispatch(new Collector(), values);
console.log('void', result === undefined, values.join(','));
