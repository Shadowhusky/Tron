import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { KeyboardEvent } from 'react';
import { isCommand } from '../utils/commandClassifier';
import { aiService } from '../services/ai';
import { useHistory } from '../contexts/HistoryContext';

interface SmartInputProps {
    onExecute: (command: string) => void;
}

const SmartInput: React.FC<SmartInputProps> = ({ onExecute }) => {
    const { history, addToHistory } = useHistory();
    const [value, setValue] = useState('');
    const [mode, setMode] = useState<'command' | 'ai'>('command');
    const [isLoading, setIsLoading] = useState(false);
    const [suggestedCommand, setSuggestedCommand] = useState<string | null>(null);
    const [ghostText, setGhostText] = useState('');

    // Autocomplete & History State
    const [completions, setCompletions] = useState<string[]>([]);
    const [completionIndex, setCompletionIndex] = useState(-1);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [savedInput, setSavedInput] = useState('');

    const inputRef = useRef<HTMLInputElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Auto-detect mode
    useEffect(() => {
        if (value.trim() === '') {
            setMode('command');
            setCompletions([]);
            return;
        }
        const firstWord = value.trim().split(' ')[0];
        if (isCommand(value)) {
            setMode('command');
        }
        if (window.electron?.ipcRenderer?.checkCommand) {
            window.electron.ipcRenderer.checkCommand(firstWord).then((exists: boolean) => {
                setMode(exists ? 'command' : 'ai');
            });
        }
    }, [value]);

    // Fetch completions
    const fetchCompletions = useCallback((input: string) => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (!input.trim() || !window.electron?.ipcRenderer?.getCompletions) {
            setCompletions([]);
            setGhostText('');
            return;
        }

        debounceRef.current = setTimeout(async () => {
            try {
                const results = await window.electron.ipcRenderer.getCompletions(input.trim());
                setCompletions(results);
                setCompletionIndex(-1);

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
                setGhostText('');
            }
        }, 150);
    }, []);

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
        setGhostText('');
        setCompletionIndex(-1);
    };

    const handleKeyDown = async (e: KeyboardEvent<HTMLInputElement>) => {
        // Tab / Right Arrow: Accept Ghost Text OR Selected Completion
        if ((e.key === 'Tab' || e.key === 'ArrowRight') && (ghostText || completionIndex >= 0)) {
            e.preventDefault();
            if (completionIndex >= 0 && completions[completionIndex]) {
                acceptCompletion(completions[completionIndex]);
            } else if (ghostText) {
                setValue(prev => prev + ghostText);
                setGhostText('');
            }
            return;
        }

        // Escape: Dismiss
        if (e.key === 'Escape') {
            setCompletions([]);
            setGhostText('');
            setSuggestedCommand(null);
            return;
        }

        // Up/Down: Priority to Dropdown, then History
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (completions.length > 0) {
                // Navigate Dropdown
                const newIndex = completionIndex <= 0 ? completions.length - 1 : completionIndex - 1;
                setCompletionIndex(newIndex);
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
            if (completions.length > 0) {
                // Navigate Dropdown
                const newIndex = completionIndex >= completions.length - 1 ? 0 : completionIndex + 1;
                setCompletionIndex(newIndex);
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
            if (completionIndex >= 0 && completions[completionIndex]) {
                acceptCompletion(completions[completionIndex]);
                return;
            }

            if (value.trim() === '') return;

            if (suggestedCommand) {
                const cmd = suggestedCommand;
                setSuggestedCommand(null);
                addToHistory(cmd);
                onExecute(cmd);
                setValue('');
                setGhostText('');
                setCompletions([]);
                return;
            }

            if (mode === 'command') {
                addToHistory(value);
                onExecute(value);
                setValue('');
                setGhostText('');
                setCompletions([]);
                setHistoryIndex(-1);
            } else {
                // AI Mode
                setIsLoading(true);
                setCompletions([]); // Hide dropdown during AI
                try {
                    const cmd = await aiService.generateCommand(value);
                    setSuggestedCommand(cmd);
                    setValue(cmd);
                    setMode('command');
                } catch (err) {
                    console.error(err);
                } finally {
                    setIsLoading(false);
                }
            }
        }
    };

    return (
        <div className={`relative w-full transition-all duration-300 rounded-lg border px-3 py-2 flex flex-col gap-1 backdrop-blur-xl ${mode === 'ai' ? 'bg-purple-900/20 border-purple-500/30' : 'bg-gray-900/40 border-white/10'}`}>

            {/* Input Row */}
            <div className="flex items-center gap-2">
                <div className={`flex items-center justify-center w-5 h-5 rounded-full shrink-0 ${mode === 'ai' ? 'bg-purple-500/20 text-purple-400' : 'bg-green-500/20 text-green-400'}`}>
                    {isLoading ? <div className="spinner" /> : <span className="text-[10px] font-bold">{mode === 'ai' ? 'AI' : '>'}</span>}
                </div>

                <div className="relative flex-1">
                    {/* Ghost Text */}
                    <div className="absolute inset-0 flex items-center pointer-events-none font-mono text-sm whitespace-pre overflow-hidden">
                        <span className="invisible">{value}</span>
                        <span className="text-gray-600 opacity-50">{ghostText}</span>
                    </div>

                    <input
                        ref={inputRef}
                        type="text"
                        className="w-full bg-transparent text-gray-100 font-mono text-sm outline-none placeholder-gray-600"
                        placeholder={mode === 'command' ? "Type a command..." : "Ask AI..."}
                        value={value}
                        onChange={e => {
                            setValue(e.target.value);
                            setHistoryIndex(-1);
                            setSuggestedCommand(null);
                        }}
                        onKeyDown={handleKeyDown}
                        autoFocus
                        disabled={isLoading}
                        spellCheck={false}
                        autoComplete="off"
                    />
                </div>
            </div>

            {/* Dropdown (Dropup if needed, simple absolute positioning for now) */}
            {completions.length > 0 && (
                <div className="absolute bottom-full left-0 mb-2 w-64 bg-gray-900 border border-white/10 rounded-lg shadow-xl overflow-hidden z-20">
                    {completions.map((item, idx) => (
                        <div
                            key={idx}
                            className={`px-3 py-1.5 text-xs font-mono cursor-pointer ${idx === completionIndex ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-white/5'}`}
                            onClick={() => acceptCompletion(item)}
                        >
                            {item}
                        </div>
                    ))}
                </div>
            )}

            {/* AI Suggestion */}
            {suggestedCommand && (
                <div className="pl-7 mt-1">
                    <div className="font-mono text-xs text-green-300 bg-black/30 px-2 py-1 rounded border border-green-500/20 cursor-pointer" onClick={() => {
                        addToHistory(suggestedCommand);
                        onExecute(suggestedCommand);
                        setValue('');
                        setSuggestedCommand(null);
                    }}>
                        {suggestedCommand} <span className="opacity-50 ml-2">↵ Run</span>
                    </div>
                </div>
            )}
        </div>
    );
};

export default SmartInput;
