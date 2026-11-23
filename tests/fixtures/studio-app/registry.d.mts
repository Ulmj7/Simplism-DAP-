export interface FixtureElement {
  readonly id: string;
  readonly route: string;
  readonly role: string;
  readonly label: string;
  readonly description: string;
  readonly operations: readonly string[];
  readonly privacy: "public";
}
export interface FixtureApplication {
  readonly id: "fixture-b";
  readonly label: string;
  readonly registry: {
    readonly routes: readonly string[];
    readonly elements: readonly FixtureElement[];
    readonly postconditionNames: readonly string[];
  };
  readonly browser: {
    readonly labels: readonly { readonly role: string; readonly name: string }[];
    readonly pages: Readonly<Record<string, string>>;
  };
}
export const fixtureB: FixtureApplication;
