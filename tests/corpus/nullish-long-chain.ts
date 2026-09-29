// Compiler dispatchers often use long left-associated chains. Keep every
// operand observable so compilation must preserve order and short-circuiting.
function dispatch(winner: number): number {
  const calls: number[] = [];
  function candidate(index: number): number | null | undefined {
    calls.push(index);
    return index === winner ? 0 : index % 2 === 0 ? null : undefined;
  }
  const result =
    candidate(0) ?? candidate(1) ?? candidate(2) ?? candidate(3) ??
    candidate(4) ?? candidate(5) ?? candidate(6) ?? candidate(7) ??
    candidate(8) ?? candidate(9) ?? candidate(10) ?? candidate(11) ??
    candidate(12) ?? candidate(13) ?? candidate(14) ?? candidate(15) ??
    candidate(16) ?? candidate(17) ?? candidate(18) ?? candidate(19) ??
    candidate(20) ?? candidate(21) ?? candidate(22) ?? candidate(23) ??
    candidate(24) ?? candidate(25) ?? candidate(26) ?? candidate(27) ??
    candidate(28) ?? candidate(29) ?? candidate(30) ?? candidate(31) ??
    candidate(32) ?? candidate(33) ?? candidate(34) ?? candidate(35) ??
    candidate(36) ?? candidate(37) ?? candidate(38) ?? candidate(39) ??
    candidate(40) ?? candidate(41) ?? candidate(42) ?? candidate(43) ??
    candidate(44) ?? candidate(45) ?? candidate(46) ?? candidate(47) ??
    candidate(48) ?? candidate(49) ?? candidate(50) ?? candidate(51) ??
    candidate(52) ?? candidate(53) ?? candidate(54) ?? candidate(55) ??
    candidate(56) ?? candidate(57) ?? candidate(58) ?? candidate(59) ??
    candidate(60) ?? candidate(61) ?? candidate(62) ?? candidate(63) ??
    candidate(64) ?? candidate(65) ?? candidate(66) ?? candidate(67) ??
    candidate(68) ?? candidate(69) ?? candidate(70) ?? candidate(71) ??
    candidate(72) ?? candidate(73) ?? candidate(74) ?? candidate(75) ??
    candidate(76) ?? candidate(77) ?? candidate(78) ?? candidate(79) ??
    candidate(80) ?? candidate(81) ?? candidate(82) ?? candidate(83) ??
    candidate(84) ?? candidate(85) ?? candidate(86) ?? candidate(87) ??
    candidate(88) ?? candidate(89) ?? candidate(90) ?? candidate(91) ??
    candidate(92) ?? candidate(93) ?? candidate(94) ?? candidate(95) ?? -1;
  console.log(winner, result, calls.join(","));
  return result;
}
dispatch(0);
dispatch(47);
dispatch(95);
dispatch(96);

let sequence = "";
function text(label: string, value: string | null | undefined): string | null | undefined {
  sequence += label;
  return value;
}
console.log(text("a", null) ?? (text("b", undefined) ?? text("c", "")) ?? text("d", "unused"));
console.log(sequence);
sequence = "";
console.log((text("a", undefined) ?? text("b", null)) ?? text("c", "end") ?? text("d", "unused"));
console.log(sequence);
