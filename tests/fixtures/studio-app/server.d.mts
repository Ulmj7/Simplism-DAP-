export interface FixtureAppOptions {
  readonly host?: string;
  readonly port?: number;
  readonly name?: string;
  readonly leaveOrigin?: string;
  readonly redirectDelayMs?: number;
  readonly embedScriptPath?: string;
  readonly dapOrigin?: string;
  readonly extras?: boolean;
}
export interface FixtureApp {
  readonly origin: string;
  readonly port: number;
  requestHosts(): string[];
  close(): Promise<void>;
}
export function startFixtureApp(options?: FixtureAppOptions): Promise<FixtureApp>;
