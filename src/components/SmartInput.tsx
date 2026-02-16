import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { KeyboardEvent } from 'react';
import { isCommand } from '../utils/commandClassifier';
import { aiService } from '../services/ai';
import { useHistory } from '../contexts/HistoryContext';
import {
    Terminal,
    Sparkles,
    Bot,
    ChevronRight,
} from 'lucide-react';


interface SmartInputProps {
    onEnter: (value: string) => void;
    onAgentRun: (prompt: string) => Promise<void>;
    isAgentRunning: boolean;
    pendingCommand: string | null;
}

const SmartInput: React.FC<SmartInputProps> = ({
    onEnter,
    onAgentRun,
    isAgentRunning,
    pendingCommand,
}) => {
    const { history, addToHistory } = useHistory();
    const [value, setValue] = useState('');
    const [mode, setMode] = useState<'command' | 'advice' | 'agent'>('command');

    // Permission & Agent state removed (lifted to SplitPane)

    const [isLoading, setIsLoading] = useState(false);
    const [suggestedCommand, setSuggestedCommand] = useState<string | null>(null);
    const [ghostText, setGhostText] = useState('');

    // Autocomplete & History State
    const [completions, setCompletions] = useState<string[]>([]);
    const [showCompletions, setShowCompletions] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [savedInput, setSavedInput] = useState('');

    const inputRef = useRef<HTMLInputElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // handleAgentExecution removed
    // handlePermission removed


    // Auto-detect mode
    useEffect(() => {
        if (value.trim() === '') {
            setMode('command');
            setCompletions([]);
            setShowCompletions(false);
            return;
        }
        const firstWord = value.trim().split(' ')[0];
        if (isCommand(value)) {
            setMode('command');
        } else if (window.electron?.ipcRenderer?.checkCommand) {
            window.electron.ipcRenderer.checkCommand(firstWord).then((exists: boolean) => {
                // Only auto-switch if we are in command mode and it LOOKS like a natural language query
                // For now, let's trust the user or simple heuristics
                if (!exists && value.split(' ').length > 2) {
                    setMode('advice');
                } else {
                    setMode(exists ? 'command' : 'advice');
                }
            });
        } else {
            // fallback
        }
    }, [value]);

    // Fetch completions
    const fetchCompletions = useCallback((input: string) => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (!input.trim() || !window.electron?.ipcRenderer?.getCompletions || mode !== 'command') {
            setCompletions([]);
            setShowCompletions(false);
            setGhostText('');
            return;
        }

        debounceRef.current = setTimeout(async () => {
            try {
                const results = await window.electron.ipcRenderer.getCompletions(input.trim());
                setCompletions(results);
                setShowCompletions(results.length > 0);
                setSelectedIndex(0);

                // Ghost text logic (only from first result)
                if (results.length > 0) {
                    const best = results[0];
                    const parts = input.trimEnd().split(/\s+/);
                    const lastWord = parts[parts.length - 1];
                    if (best && best.toLowerCase().startsWith(lastWord.toLowerCase()) && best.length > lastWord.length) {
                        setGhostText(best.slice(lastWord.length));
                    } else {
                        setGhostText('');
                    }
                } else {
                    setGhostText('');
                }
            } catch {
                setCompletions([]);
                setShowCompletions(false);
                setGhostText('');
            }
        }, 150);
    }, [mode]); // Re-run if mode changes


    useEffect(() => {
        fetchCompletions(value);
        return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }, [value, fetchCompletions]);

    const acceptCompletion = (completion: string) => {
        const parts = value.trimEnd().split(/\s+/);
        parts.pop(); // Remove partial word
        parts.push(completion); // Add completion
        const newValue = parts.join(' ') + ' ';
        setValue(newValue);
        setCompletions([]);
        setShowCompletions(false);
        setGhostText('');
        setSelectedIndex(0);
    };

    const handleKeyDown = async (e: KeyboardEvent<HTMLInputElement>) => {
        // Tab / Right Arrow: Accept Ghost Text OR Selected Completion
        if ((e.key === 'Tab' || e.key === 'ArrowRight') && (ghostText || (showCompletions && completions.length > 0))) {
            e.preventDefault();
            if (showCompletions && completions[selectedIndex]) {
                acceptCompletion(completions[selectedIndex]);
            } else if (ghostText) {
                setValue(prev => prev + ghostText);
                setGhostText('');
            }
            return;
        }

        // Escape: Dismiss
        if (e.key === 'Escape') {
            setCompletions([]);
            setShowCompletions(false);
            setGhostText('');
            setSuggestedCommand(null);
            return;
        }

        // Mode Switching Hotkeys
        if (e.metaKey && e.key === '1') {
            e.preventDefault();
            setMode('command');
            return;
        }
        if (e.metaKey && e.key === '2') {
            e.preventDefault();
            setMode('advice');
            return;
        }
        if (e.metaKey && e.key === '3') {
            e.preventDefault();
            setMode('agent');
            return;
        }

        // Up/Down: Priority to Dropdown, then History
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (showCompletions && completions.length > 0) {
                // Navigate Dropdown
                const newIndex = selectedIndex <= 0 ? completions.length - 1 : selectedIndex - 1;
                setSelectedIndex(newIndex);
            } else {
                // Navigate History
                if (history.length === 0) return;
                if (historyIndex === -1) {
                    setSavedInput(value);
                    const newIndex = history.length - 1;
                    setHistoryIndex(newIndex);
                    setValue(history[newIndex]);
                } else if (historyIndex > 0) {
                    const newIndex = historyIndex - 1;
                    setHistoryIndex(newIndex);
                    setValue(history[newIndex]);
                }
                setTimeout(() => {
                    // Move cursor to end
                    if (inputRef.current) inputRef.current.setSelectionRange(inputRef.current.value.length, inputRef.current.value.length);
                }, 0);
            }
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (showCompletions && completions.length > 0) {
                // Navigate Dropdown
                const newIndex = selectedIndex >= completions.length - 1 ? 0 : selectedIndex + 1;
                setSelectedIndex(newIndex);
            } else {
                // Navigate History
                if (historyIndex === -1) return;
                if (historyIndex < history.length - 1) {
                    const newIndex = historyIndex + 1;
                    setHistoryIndex(newIndex);
                    setValue(history[newIndex]);
                } else {
                    setHistoryIndex(-1);
                    setValue(savedInput);
                }
            }
            return;
        }


        // Enter
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();

            // If autocomplete item selected, accept it
            if (showCompletions && completions[selectedIndex]) {
                acceptCompletion(completions[selectedIndex]);
                return;
            }

            if (value.trim() === '') return;

            if (suggestedCommand) {
                const cmd = suggestedCommand;
                setSuggestedCommand(null);
                addToHistory(cmd);
                onEnter(cmd);
                setValue('');
                setGhostText('');
                setCompletions([]);
                setShowCompletions(false);
                return;
            }

            if (mode === 'command') {
                addToHistory(value);
                onEnter(value);
                setValue('');
                setGhostText('');
                setCompletions([]);
                setShowCompletions(false);
                setHistoryIndex(-1);
            } else if (mode === 'agent') {
                onAgentRun(value);
                setValue('');
            } else if (mode === 'advice') {
                // AI Mode (Advice)
                setIsLoading(true);
                setShowCompletions(false);
                setCompletions([]); // Hide dropdown during AI
                try {
                    const cmd = await aiService.generateCommand(value);
                    setSuggestedCommand(cmd);
                    // Don't auto-set value, just show suggestion
                    // setValue(cmd); 
                    setMode('command');
                } catch (err) {
                    console.error(err);
                } finally {
                    setIsLoading(false);
                }
            }
        }
    };

    // Explicit suggestion check or variable
    const suggestion = suggestedCommand;
    const currentCompletion = (showCompletions && completions.length > 0) ? completions[selectedIndex] : null;

    return (
        <div className="w-full flex flex-col relative gap-2">
            {/* Agent Status/Overlay handled by parent SplitPane now */}

            <div className={`relative w-full transition-all duration-300 rounded-lg border px-3 py-2 flex flex-col gap-1 backdrop-blur-xl z-10 ${mode === 'advice' || mode === 'agent' ? 'bg-purple-900/20 border-purple-500/30' : 'bg-gray-900/40 border-white/10'}`}>

                {/* Input Row */}
                <div className="flex items-center gap-2">
                    <div className="relative group/mode">
                        <button
                            className={`flex items-center justify-center w-6 h-6 rounded-md transition-colors ${mode === 'agent' ? 'bg-purple-500/20 text-purple-400' :
                                mode === 'advice' ? 'bg-blue-500/20 text-blue-400' :
                                    'bg-green-500/20 text-green-400'
                                }`}
                            onClick={() => {
                                // Cycle modes or open dropdown
                                setMode(prev => prev === 'command' ? 'advice' : prev === 'advice' ? 'agent' : 'command');
                            }}
                        >
                            {mode === 'agent' ? <Bot className="w-4 h-4" /> : mode === 'advice' ? <Sparkles className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>

                        {/* Mode Dropdown */}
                        <div className="absolute bottom-full left-0 mb-2 w-32 bg-[#1e1e1e] border border-white/10 rounded-lg shadow-xl overflow-hidden hidden group-hover/mode:block z-50">
                            {[
                                { id: 'command', label: 'Command', icon: <ChevronRight className="w-3 h-3" /> },
                                { id: 'advice', label: 'Advice', icon: <Sparkles className="w-3 h-3" /> },
                                { id: 'agent', label: 'Agent', icon: <Bot className="w-3 h-3" /> },
                            ].map(m => (
                                <button
                                    key={m.id}
                                    onClick={() => setMode(m.id as 'command' | 'advice' | 'agent')}
                                    className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-white/5 ${mode === m.id ? 'text-white bg-white/5' : 'text-gray-400'}`}
                                >
                                    <span className="w-4 text-center flex justify-center">{m.icon}</span>
                                    <span>{m.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="relative flex-1">
                        {/* Ghost Text */}
                        <div className="absolute inset-0 flex items-center pointer-events-none font-mono text-sm whitespace-pre overflow-hidden">
                            <span className="invisible">{value}</span>
                            <span className="text-gray-600 opacity-50">
                                {ghostText || (currentCompletion && currentCompletion.startsWith(value) ? currentCompletion.slice(value.length) : '')}
                            </span>
                        </div>

                        <input
                            ref={inputRef}
                            type="text"
                            className="w-full bg-transparent text-gray-100 font-mono text-sm outline-none placeholder-gray-600"
                            placeholder={mode === 'command' ? "Type a command... (Cmd+1)" : mode === 'agent' ? "Ask Agent to do something... (Cmd+3)" : "Ask AI for advice... (Cmd+2)"}
                            value={value}
                            onChange={e => {
                                setValue(e.target.value);
                                setHistoryIndex(-1);
                                setSuggestedCommand(null);
                            }}
                            onKeyDown={handleKeyDown}
                            autoFocus
                            disabled={isLoading || (isAgentRunning && pendingCommand !== null)}
                            spellCheck={false}
                            autoComplete="off"
                        />
                    </div>
                </div>

                {/* Dropdown */}
                {showCompletions && completions.length > 0 && mode === 'command' && (
                    <div className="absolute bottom-full left-8 mb-2 w-64 bg-gray-900 border border-white/10 rounded-lg shadow-xl overflow-hidden z-20">
                        {completions.map((item, idx) => (
                            <div
                                key={idx}
                                className={`px-3 py-1.5 text-xs font-mono cursor-pointer ${idx === selectedIndex ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-white/5'}`}
                                onClick={() => {
                                    acceptCompletion(item);
                                    inputRef.current?.focus();
                                }}
                            >
                                {item}
                            </div>
                        ))}
                    </div>
                )}
                {/* Submit Logic Visual (Optional) */}
            </div>

            {/* Completions Dropdown */}
            {showCompletions && completions.length > 0 && (
                <div className="absolute bottom-full left-0 mb-1 w-full max-w-md bg-[#1a1a1a] border border-white/10 rounded-lg shadow-xl overflow-hidden z-20">
                    {completions.map((comp, i) => (
                        <div
                            key={i}
                            className={`px-3 py-2 text-xs font-mono cursor-pointer flex items-center gap-2 ${i === selectedIndex ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-white/5'
                                }`}
                            onClick={() => {
                                acceptCompletion(comp);
                                inputRef.current?.focus();
                            }}
                        >
                            <Terminal className="w-3 h-3 opacity-50" />
                            {comp}
                        </div>
                    ))}
                </div>
            )}

            {/* Advice/Command Suggestion Output */}
            {suggestion && mode !== 'agent' && (
                <div className="absolute bottom-full left-0 mb-2 w-full bg-[#1a1a1a]/90 backdrop-blur border border-purple-500/20 rounded-lg p-3 shadow-xl z-10 animate-in fade-in slide-in-from-bottom-1">
                    <div className="flex items-start gap-3">
                        <Sparkles className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" />
                        <div className="flex-1">
                            <div className="text-purple-200 text-sm font-medium mb-1">AI Suggestion</div>
                            <div className="text-gray-300 text-xs leading-relaxed">{suggestion}</div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
export default SmartInput;

