function receiver() {
  console.log("receiver");
  return [1];
}
function undefinedKey() {
  console.log("undefined-key");
  return undefined;
}
function nullKey() {
  console.log("null-key");
  return null;
}
function booleanKey() {
  console.log("boolean-key");
  return true;
}
console.log(undefinedKey() in receiver());
console.log(nullKey() in receiver());
console.log(booleanKey() in receiver());
