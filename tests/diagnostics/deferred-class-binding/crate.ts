export class Crate {
  readonly label: string;
  contents: unknown;
  constructor(label: string) {
    this.label = label;
    this.contents = undefined;
  }
}
