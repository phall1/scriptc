export class Shelf {
  readonly name: string;
  private readonly notes = new WeakMap<object, string>();
  constructor(name: string) {
    this.name = name;
  }
  describe(): string {
    return `shelf ${this.name}`;
  }
}
