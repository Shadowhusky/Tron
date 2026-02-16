export interface TerminalSession {
    id: string; // PTY Session ID
    title: string;
    cwd?: string;
}

export type SplitDirection = 'horizontal' | 'vertical';

export type LayoutNode =
    | { type: 'leaf'; sessionId: string }
    | { type: 'split'; direction: SplitDirection; children: LayoutNode[]; sizes: number[] };

export interface Tab {
    id: string;
    title: string;
    root: LayoutNode;
    activeSessionId: string | null; // Which session is active in this tab
}

export interface TerminalState {
    tabs: Tab[];
    activeTabId: string;
    sessions: Map<string, TerminalSession>;
}
