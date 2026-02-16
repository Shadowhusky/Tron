import React, { createContext, useContext, useState, useEffect } from 'react';

interface HistoryContextType {
    history: string[];
    addToHistory: (command: string) => void;
    clearHistory: () => void;
}

const HistoryContext = createContext<HistoryContextType | null>(null);

export const useHistory = () => {
    const context = useContext(HistoryContext);
    if (!context) throw new Error('useHistory must be used within HistoryProvider');
    return context;
};

export const HistoryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [history, setHistory] = useState<string[]>(() => {
        try {
            const stored = localStorage.getItem('tron_global_history');
            return stored ? JSON.parse(stored) : [];
        } catch {
            return [];
        }
    });

    useEffect(() => {
        localStorage.setItem('tron_global_history', JSON.stringify(history));
    }, [history]);

    const addToHistory = (command: string) => {
        if (!command.trim()) return;
        // Avoid consecutive duplicates
        setHistory(prev => {
            if (prev.length > 0 && prev[prev.length - 1] === command) return prev;
            return [...prev, command].slice(-1000); // Keep last 1000
        });
    };

    const clearHistory = () => setHistory([]);

    return (
        <HistoryContext.Provider value={{ history, addToHistory, clearHistory }}>
            {children}
        </HistoryContext.Provider>
    );
};
