export interface HistoryAppOptions {
  readonly host?: string;
  readonly port?: number;
  readonly name?: string;
  readonly variant?: "default" | "moved";
  readonly embedScriptPath?: string;
  readonly dapOrigin?: string;
  readonly dapKey?: string;
  readonly csp?: boolean;
}
export interface HistoryApp {
  readonly origin: string;
  readonly port: number;
  variant(): string;
  setVariant(value: string): void;
  requestHosts(): string[];
  requestPaths(): string[];
  policy(): string | null;
  close(): Promise<void>;
}
export function startHistoryApp(options?: HistoryAppOptions): Promise<HistoryApp>;
