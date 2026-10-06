Object.setPrototypeOf(Array.prototype, null);
console.log("constructor" in ([] as number[]));
console.log(Object.prototype.hasOwnProperty.call(Array.prototype, "constructor"));
console.log(Array.prototype.constructor.name);
