import React from 'react';
import { useLayout } from '../contexts/LayoutContext';
import { aiService } from '../services/ai';
import { useTheme } from '../contexts/ThemeContext';

const ContextBar: React.FC = () => {
    const { activeSessionId, sessions } = useLayout();
    const { theme } = useTheme();

    // Derived state
    const session = activeSessionId ? sessions.get(activeSessionId) : null;
    const cwd = session?.cwd || '~/';

    // Simple poll for model updates (since we didn't add a context for AI config)
    const [model, setModel] = React.useState(aiService.getConfig().model);

    React.useEffect(() => {
        const interval = setInterval(() => {
            const current = aiService.getConfig().model;
            if (current !== model) setModel(current);
        }, 1000);
        return () => clearInterval(interval);
    }, [model]);

    return (
        <div className={`h-8 border-t flex items-center px-4 justify-between text-xs font-mono transition-colors duration-300 ${theme === 'dark' ? 'bg-black/90 border-white/10 text-gray-500' : 'bg-gray-100 border-gray-300 text-gray-600'
            }`}>
            <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                    <span className="text-purple-400">Context:</span>
                    <span className={theme === 'dark' ? 'text-gray-300' : 'text-gray-800'}>{cwd}</span>
                </div>
            </div>

            <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                    <span className="text-green-400">Model:</span>
                    <span className={theme === 'dark' ? 'text-gray-300' : 'text-gray-800'}>{model}</span>
                </div>
            </div>
        </div>
    );
};

export default ContextBar;
