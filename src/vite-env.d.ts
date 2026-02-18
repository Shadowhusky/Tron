/// <reference types="vite/client" />

interface Window {
  electron: {
    ipcRenderer: {
      invoke: (channel: string, data?: any) => Promise<any>;
      send: (channel: string, data: any) => void;
      on: (channel: string, func: (...args: any[]) => void) => () => void;
      once: (channel: string, func: (...args: any[]) => void) => void;
      removeListener: (channel: string, func: (...args: any[]) => void) => void;
      checkCommand: (command: string) => Promise<boolean>;
      getCwd: (sessionId: string) => Promise<string | null>;
      getCompletions: (prefix: string, cwd?: string, sessionId?: string) => Promise<string[]>;
      getHistory: (sessionId: string) => Promise<string>;
      scanCommands: () => Promise<string[]>;
      exec: (
        sessionId: string,
        command: string,
      ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
      execInTerminal: (
        sessionId: string,
        command: string,
      ) => Promise<{ stdout: string; exitCode: number }>;
      testAIConnection: (config: {
        provider: string;
        model: string;
        apiKey?: string;
        baseUrl?: string;
      }) => Promise<boolean>;
      selectFolder: (defaultPath?: string) => Promise<string | null>;
    };
  };
}
