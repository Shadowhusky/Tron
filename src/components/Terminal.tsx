import React, { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
    className?: string;
    sessionId: string;
}

const Terminal: React.FC<TerminalProps> = ({ className, sessionId }) => {
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Xterm | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);

    useEffect(() => {
        if (!terminalRef.current) return;

        // Initialize xterm.js
        const term = new Xterm({
            cursorBlink: true,
            fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
            fontSize: 14,
            theme: {
                background: '#00000000', // Transparent
                foreground: '#e5e7eb',
            },
            allowProposedApi: true,
        });

        const fitAddon = new FitAddon();
        const webLinksAddon = new WebLinksAddon();

        term.loadAddon(fitAddon);
        term.loadAddon(webLinksAddon);

        term.open(terminalRef.current);
        fitAddon.fit();

        xtermRef.current = term;
        fitAddonRef.current = fitAddon;

        term.focus();

        // Restore History
        if (window.electron) {
            window.electron.ipcRenderer.getHistory(sessionId).then((history: string) => {
                if (history && xtermRef.current) {
                    xtermRef.current.write(history);
                }
            });
        }

        // Handle Resize
        const handleResize = () => {
            if (!fitAddonRef.current || !xtermRef.current) return;
            fitAddonRef.current.fit();
            const { cols, rows } = xtermRef.current;
            if (window.electron) {
                window.electron.ipcRenderer.send('terminal.resize', { id: sessionId, cols, rows });
            }
        };

        window.addEventListener('resize', handleResize);

        // Send Input
        const disposableOnData = term.onData((data) => {
            if (window.electron) {
                window.electron.ipcRenderer.send('terminal.write', { id: sessionId, data });
            }
        });

        // Receive Output
        let removeListener: (() => void) | undefined;
        if (window.electron) {
            removeListener = window.electron.ipcRenderer.on('terminal.incomingData', ({ id, data }: { id: string, data: string }) => {
                if (id === sessionId) {
                    term.write(data);
                }
            });

            // Initial Resize to sync backend PTY size
            handleResize();
        } else {
            term.write('\r\n\x1b[33m[Mock Mode] Electron not detected.\x1b[0m\r\n');
        }

        return () => {
            term.dispose();
            window.removeEventListener('resize', handleResize);
            if (removeListener) removeListener();
            disposableOnData.dispose();
        };
    }, [sessionId]); // Re-init if sessionId changes (should be stable though)

    return <div className={className} ref={terminalRef} />;
};

export default Terminal;
