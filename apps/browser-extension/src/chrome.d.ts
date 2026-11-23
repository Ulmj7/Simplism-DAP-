/** Narrow MV3 interface used by the extension. */
interface ExtensionTarget {
  tabId: number;
  frameIds?: number[];
  documentIds?: string[];
}

interface ExtensionTab { id?: number; url?: string; pendingUrl?: string }

interface ExtensionSender {
  id?: string;
  url?: string;
  origin?: string;
  tab?: ExtensionTab;
  frameId?: number;
  documentId?: string;
  documentLifecycle?: string;
}

interface ExtensionInjection<T> {
  documentId: string;
  frameId: number;
  result?: T;
}

declare const chrome: {
  runtime: {
    id: string;
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(listener: (message: unknown, sender: ExtensionSender, reply: (value: unknown) => void) => boolean | void): void;
    };
  };
  tabs: {
    query(query: { active?: boolean; currentWindow?: boolean; url?: string }): Promise<ExtensionTab[]>;
    sendMessage(tabId: number, message: unknown, target: { documentId: string }): Promise<unknown>;
    onRemoved: { addListener(listener: (tabId: number) => void): void };
  };
  permissions: {
    request(permissions: { origins: string[] }): Promise<boolean>;
    contains(permissions: { origins: string[] }): Promise<boolean>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
      setAccessLevel(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
    };
    session: {
      get(key: string): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    };
  };
  scripting: {
    executeScript<T, Args extends unknown[]>(
      injection: { target: ExtensionTarget; world?: "MAIN"; func: (...args: Args) => T | Promise<T>; args?: Args },
    ): Promise<ExtensionInjection<T>[]>;
    executeScript(injection: { target: ExtensionTarget; world?: "MAIN"; files: string[] }): Promise<ExtensionInjection<unknown>[]>;
    insertCSS(injection: { target: ExtensionTarget; files: string[] }): Promise<void>;
    removeCSS(injection: { target: ExtensionTarget; files: string[] }): Promise<void>;
    registerContentScripts(scripts: { id: string; matches: string[]; js: string[]; allFrames: false; persistAcrossSessions: true; runAt: "document_idle" }[]): Promise<void>;
    unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
    getRegisteredContentScripts(filter: { ids: string[] }): Promise<{ id: string }[]>;
  };
};
