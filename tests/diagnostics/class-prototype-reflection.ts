class Vector {
  x = 0;
  length(): number { return this.x; }
}
// Prototype data is represented; compiled method descriptors are not.
const prototype = Vector.prototype;
const method = Vector.prototype.length;
Vector.prototype.length = () => 1;
Object.getOwnPropertyDescriptors(Vector.prototype);
// End of the prototype reflection diagnostic fixture.
