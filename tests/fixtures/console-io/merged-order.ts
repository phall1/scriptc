// stdout and stderr redirected to ONE descriptor (2>&1): every console and
// process stream write must land in source order, as Node submits each chunk
// before returning. Covers single-string and multi-argument lines, raw writes
// without newlines, lines larger than the runtime's on-stack buffer and the
// 64 KiB stdio buffer, and writes from a later event-loop turn.
function repeat(unit: string, count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) out += unit;
  return out;
}

console.log("out 1");
console.error("err 1");
console.log("out", 2, true, -0);
console.warn("warn", 3, false);
process.stdout.write("raw-out|");
process.stderr.write("raw-err|");
console.log("after raws");
for (let i = 0; i < 50; i++) {
  if (i % 3 === 0) console.error("loop err", i);
  else console.log(`loop out ${i}`);
}
console.log(repeat("o", 5000));
console.error(repeat("e", 5000));
console.log("big", repeat("O", 70000), 1);
console.error(repeat("E", 70000));
process.stdout.write(repeat("w", 3000));
process.stderr.write(repeat("v", 3000) + "\n");
console.log("|end of sync");
setTimeout(() => {
  console.error("timer err");
  console.log("timer out");
  process.stdout.write("timer raw\n");
}, 1);
