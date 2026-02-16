import { useState, useEffect } from 'react';
import { LayoutProvider, useLayout } from './contexts/LayoutContext';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { HistoryProvider } from './contexts/HistoryContext';
import SettingsModal from './components/SettingsModal';
import ContextBar from './components/ContextBar';
import SplitPane from './components/SplitPane';

// Inner component to use contexts
const AppContent = () => {
    const { tabs, activeTabId, createTab, selectTab, closeTab } = useLayout();
    const { theme } = useTheme();
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    // Global Shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Cmd/Ctrl + , : Open Settings
            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                e.preventDefault();
                setIsSettingsOpen(true);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    const activeTab = tabs.find(t => t.id === activeTabId);

    return (
        <div className={`flex flex-col h-screen w-full overflow-hidden transition-colors duration-300 ${theme === 'dark' ? 'bg-black text-white' : 'bg-white text-black'}`}>
            {/* Header / Tabs */}
            <div className={`flex items-center h-10 px-2 gap-2 border-b select-none shrink-0 ${theme === 'dark' ? 'bg-gray-900/50 border-white/5' : 'bg-gray-100 border-gray-300'}`}>
                {/* Traffic Lights Spacer (Mac) */}
                <div className="w-16 drag-region" style={{ WebkitAppRegion: 'drag' } as any} />

                {/* Tabs */}
                <div className="flex items-center gap-1 flex-1 overflow-x-auto no-scrollbar">
                    {tabs.map(tab => (
                        <div
                            key={tab.id}
                            onClick={() => selectTab(tab.id)}
                            className={`group relative flex items-center gap-2 px-3 py-1.5 rounded-md text-xs cursor-pointer transition-all border max-w-[200px] min-w-[100px] ${tab.id === activeTabId
                                ? (theme === 'dark' ? 'bg-gray-800 text-white border-white/10 shadow-sm' : 'bg-white text-gray-900 border-gray-300 shadow-sm')
                                : 'border-transparent hover:bg-white/5 text-gray-500 hover:text-gray-300'
                                }`}
                        >
                            <span className="truncate flex-1">{tab.title}</span>
                            <button
                                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                                className={`opacity-0 group-hover:opacity-100 p-0.5 rounded-sm hover:bg-white/20 transition-opacity ${tab.id === activeTabId ? 'opacity-100' : ''}`}
                            >
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                    ))}
                    <button onClick={createTab} className="p-1.5 rounded-md hover:bg-white/10 text-gray-500 transition-colors">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                    </button>
                </div>

                {/* Settings Button */}
                <button onClick={() => setIsSettingsOpen(true)} className="p-2 rounded-md hover:bg-white/10 text-gray-500 transition-colors" title="Settings (Cmd+,)">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                </button>
            </div>

            {/* Main Workspace */}
            <div className="flex-1 relative overflow-hidden">
                {activeTab ? (
                    <SplitPane node={activeTab.root} />
                ) : (
                    <div className="flex items-center justify-center h-full text-gray-500 flex-col gap-4">
                        <div className="text-xl font-medium">No Open Tabs</div>
                        <button onClick={createTab} className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors shadow-lg shadow-purple-900/20">Create New Terminal</button>
                        <div className="text-xs opacity-50">Press Cmd+T to open a new tab</div>
                    </div>
                )}
            </div>

            {/* Context Bar */}
            <ContextBar />

            {/* Settings Modal */}
            <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
        </div>
    );
};

const App = () => {
    return (
        <ThemeProvider>
            <HistoryProvider>
                <LayoutProvider>
                    <AppContent />
                </LayoutProvider>
            </HistoryProvider>
        </ThemeProvider>
    );
};

export default App;
