import * as Hash from "effect/Hash";
console.log(Hash.hash([1, 2, 3]) === Hash.hash([1, 2, 3]));
console.log(Hash.hash(["a", "b"]) === Hash.hash(["a", "b"]));
console.log(Hash.hash([[1, 2], [3]]) === Hash.hash([[1, 2], [3]]));
