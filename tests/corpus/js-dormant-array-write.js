// @deferred-fences: 1
// The incompatible string write is intentionally fenced; toArray stays uncalled.
class Coordinates {
  constructor() { this.value = 3; }
  /** @param {number[]} values */
  toArray(values = []) {
    values[0] = this.value;
    values[1] = "label";
    return values;
  }
}
const coordinates = new Coordinates();
const reader = { read(source, key) { return source[key]; } };
console.log(reader.read(coordinates, "value"), coordinates.value);
