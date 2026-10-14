function has(): boolean {
  return key in [1];
}
try {
  console.log("membership", has());
} catch {
  console.log("caught");
}
const key = "0";
console.log(has());
