import type { Route } from "./router.js";
import type { ProfileState } from "./profile-state.js";
export interface AppState { readonly route: Route; readonly profile: ProfileState; readonly advancedOpen: boolean }
