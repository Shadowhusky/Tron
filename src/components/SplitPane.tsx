import React, { useState } from 'react';
import type { LayoutNode } from '../types';
import Terminal from './Terminal';
import { useLayout } from '../contexts/LayoutContext';
import { aiService } from '../services/ai';
import SmartInput from './SmartInput';
import AgentOverlay from './AgentOverlay';

const SplitPane: React.FC<{ node: LayoutNode }> = ({ node }) => {
    const { activeSessionId } = useLayout();

    // --- Agent State (Lifted from SmartInput) ---
    const [agentThread, setAgentThread] = useState<{ step: string, output: string }[]>([]);
    const [isAgentRunning, setIsAgentRunning] = useState(false);
    const [isThinking, setIsThinking] = useState(false);
    const [pendingCommand, setPendingCommand] = useState<string | null>(null);
    const [permissionResolve, setPermissionResolve] = useState<((allowed: boolean) => void) | null>(null);
    const [alwaysAllowSession, setAlwaysAllowSession] = useState(false);

    if (node.type === 'leaf') {
        const isActive = node.sessionId === activeSessionId;

        const handleExecute = (command: string) => {
            if (window.electron) {
                window.electron.ipcRenderer.send('terminal.write', { id: node.sessionId, data: command + '\r' });
            }
        };

        const handleAgentRun = async (prompt: string) => {
            setIsAgentRunning(true);
            setIsThinking(true); // Immediate feedback
            setAgentThread([]);

            try {
                const finalAnswer = await aiService.runAgent(
                    prompt,
                    async (cmd) => {
                        // Check Permissions
                        if (!alwaysAllowSession) {
                            setPendingCommand(cmd);
                            const allowed = await new Promise<boolean>((resolve) => {
                                setPermissionResolve(() => resolve);
                            });
                            setPendingCommand(null);
                            setPermissionResolve(null);

                            if (!allowed) {
                                throw new Error("User denied command execution.");
                            }
                        }

                        // Execute command via IPC
                        // Ensure we use the specific session ID of this pane
                        if (!node.sessionId) {
                            throw new Error("No terminal session found.");
                        }

                        const result = await window.electron.ipcRenderer.exec(node.sessionId, cmd);
                        if (result.exitCode !== 0) {
                            throw new Error(`Exit Code ${result.exitCode}: ${result.stderr}`);
                        }
                        return result.stdout;
                    },
                    (step, output) => {
                        setAgentThread(prev => [...prev, { step, output }]);
                        setIsThinking(step === 'thinking');
                    }
                );
                setAgentThread(prev => [...prev, { step: 'done', output: finalAnswer }]);
            } catch (e: any) {
                setAgentThread(prev => [...prev, { step: 'error', output: e.message }]);
            } finally {
                setIsAgentRunning(false);
                setIsThinking(false);
            }
        };

        const handlePermission = (choice: 'allow' | 'always' | 'deny') => {
            if (!permissionResolve) return;
            if (choice === 'always') {
                setAlwaysAllowSession(true);
                permissionResolve(true);
            } else if (choice === 'allow') {
                permissionResolve(true);
            } else {
                permissionResolve(false);
            }
        };

        return (
            <div
                className={`w-full h-full relative flex flex-col border border-transparent ${isActive ? 'ring-1 ring-purple-500/50 z-10' : 'opacity-80 hover:opacity-100'}`}
            >
                <div className="flex-1 overflow-hidden relative">
                    <Terminal sessionId={node.sessionId} className="h-full w-full" />

                    {/* Agent Overlay (Visible when agent is active) */}
                    <AgentOverlay
                        isThinking={isThinking}
                        isAgentRunning={isAgentRunning}
                        agentThread={agentThread}
                        pendingCommand={pendingCommand}
                        onClose={() => setAgentThread([])}
                        onPermission={handlePermission}
                    />
                </div>
                <div className="p-2 bg-black/40 border-t border-white/5">
                    <SmartInput
                        onEnter={handleExecute}
                        onAgentRun={handleAgentRun}
                        isAgentRunning={isAgentRunning}
                        pendingCommand={pendingCommand}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className={`flex w-full h-full ${node.direction === 'horizontal' ? 'flex-row' : 'flex-col'}`}>
            {node.children.map((child, index) => (
                <div
                    key={index}
                    style={{ flex: node.sizes ? node.sizes[index] : 1 }}
                    className="relative border-r border-b border-white/5 last:border-0 overflow-hidden"
                >
                    <SplitPane node={child} />
                </div>
            ))}
        </div>
    );
};

export default SplitPane;
