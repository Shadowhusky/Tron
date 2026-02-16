import React from 'react';
import type { LayoutNode } from '../types';
import Terminal from './Terminal';
import { useLayout } from '../contexts/LayoutContext';

import SmartInput from './SmartInput';

const SplitPane: React.FC<{ node: LayoutNode }> = ({ node }) => {
    const { activeSessionId } = useLayout(); // Access active session from context

    if (node.type === 'leaf') {
        const isActive = node.sessionId === activeSessionId;

        const handleExecute = (command: string) => {
            if (window.electron) {
                // Send Ctrl+U (\u0015) to clear line before executing command
                window.electron.ipcRenderer.send('terminal.write', { id: node.sessionId, data: '\u0015' + command + '\r' });
            }
        };

        return (
            <div
                className={`w-full h-full relative flex flex-col border border-transparent ${isActive ? 'ring-1 ring-purple-500/50 z-10' : 'opacity-80 hover:opacity-100'}`}
            >
                <div className="flex-1 overflow-hidden relative">
                    <Terminal sessionId={node.sessionId} className="h-full w-full" />
                </div>
                <div className="p-2 bg-black/40 border-t border-white/5">
                    <SmartInput onExecute={handleExecute} />
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
