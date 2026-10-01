const hash = Symbol.for("hash");
function cache(self, value) {
  Object.defineProperty(self, hash, { value() { return value; }, enumerable: false });
}
class Key {
  calls = 0;
  [hash]() {
    this.calls++;
    cache(this, 42);
    return 42;
  }
}
function read(value) { return value[hash](); }
function own(value) { return Object.hasOwn(value, hash); }
const key = new Key();
console.log(own(key), read(key), read(key), key.calls, own(key));
