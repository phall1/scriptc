class Value {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

const collect = (...values: (Value | undefined | null)[]): Value[] =>
  values.filter((value) => value !== undefined && value !== null);
const first = new Value(1);
const second = new Value(2);
const result = collect(undefined, first, null, second);
console.log(result.map((value) => value.value).join(","), result[0] === first, result[1] === second);
console.log(collect().length);
