export const REQUIRED_SUITES: readonly string[];
export const PROJECT_PATHS: Readonly<Record<string, string>>;
export const REFERENCE_HOST_GROUPS: readonly string[];
export const REFERENCE_HOST_CASES: readonly (readonly string[])[];
export interface GateReport { readonly success?: boolean; readonly numFailedTests?: number; readonly numFailedTestSuites?: number; readonly testResults: readonly { readonly name: string; readonly assertionResults: readonly { readonly ancestorTitles: readonly string[]; readonly title: string; readonly status: string }[] }[] }
export function checkReport(report: unknown, options?: { readonly suites?: readonly string[]; readonly root?: string; readonly groups?: readonly string[] }): string[];
