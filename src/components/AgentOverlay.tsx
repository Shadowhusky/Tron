import { Command, Check, X } from 'lucide-react';

interface AgentStep {
    step: string;
    output: string;
}

interface AgentOverlayProps {
    isThinking: boolean;
    isAgentRunning: boolean;
    agentThread: AgentStep[];
    pendingCommand: string | null;
    onClose: () => void;
    onPermission: (choice: 'allow' | 'always' | 'deny') => void;
}

const AgentOverlay: React.FC<AgentOverlayProps> = ({
    isThinking,
    isAgentRunning,
    agentThread,
    pendingCommand,
    onClose,
    onPermission
}) => {
    if (!isAgentRunning && !isThinking && agentThread.length === 0) return null;

    return (
        <div className="absolute inset-x-0 bottom-0 max-h-[80%] overflow-hidden bg-black/90 backdrop-blur-md border-t border-purple-500/30 flex flex-col shadow-2xl z-20 transition-all animate-in slide-in-from-bottom-5">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-white/5">
                <div className="flex items-center gap-2">
                    {isThinking ? (
                        <div className="flex gap-1">
                            <div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                            <div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                            <div className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                    ) : (
                        <div className={`w-2 h-2 rounded-full ${isAgentRunning ? 'bg-green-400' : 'bg-gray-500'}`} />
                    )}
                    <span className="text-xs font-medium text-purple-200">
                        {isThinking ? 'Agent is thinking...' : isAgentRunning ? 'Agent working...' : 'Task Completed'}
                    </span>
                </div>
                <button
                    onClick={onClose}
                    className="text-[10px] text-gray-400 hover:text-white uppercase tracking-wider px-2 py-1 rounded hover:bg-white/10 transition-colors"
                >
                    Close
                </button>
            </div>

            {/* Thread Output */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2 font-mono text-xs scrollbar-thin scrollbar-thumb-gray-700">
                {agentThread.map((step, i) => (
                    <div key={i} className="border-l-2 border-white/10 pl-3 py-1">
                        <div className="flex items-baseline gap-2 mb-1">
                            <span className={`uppercase font-bold text-[10px] tracking-wider ${step.step === 'executing' ? 'text-yellow-500' :
                                step.step === 'error' ? 'text-red-500' :
                                    step.step === 'done' ? 'text-green-500' : 'text-blue-500'
                                }`}>
                                {step.step}
                            </span>
                        </div>

                        {step.step === 'executing' || step.output.length > 150 ? (
                            <details className="group">
                                <summary className="cursor-pointer text-gray-400 hover:text-white transition-colors truncate select-none list-none flex items-center gap-2">
                                    <span className="text-[10px] opacity-50 group-open:rotate-90 transition-transform">▶</span>
                                    {step.step === 'executing' ? 'Command Output' : step.output.slice(0, 50) + '...'}
                                </summary>
                                <div className="mt-2 p-3 bg-black/50 rounded border border-white/5 text-gray-300 whitespace-pre-wrap overflow-x-auto text-[11px] leading-relaxed">
                                    {step.output}
                                </div>
                            </details>
                        ) : (
                            <div className="text-gray-300 whitespace-pre-wrap leading-relaxed">
                                {step.output}
                            </div>
                        )}
                    </div>
                ))}
            </div>

            {/* Permission Request (Fixed at bottom of overlay) */}
            {pendingCommand && (
                <div className="p-4 bg-red-900/20 border-t border-red-500/20 animate-in fade-in slide-in-from-bottom-2">
                    <div className="text-red-200 text-sm mb-2 font-medium flex items-center gap-2">
                        <Command className="w-4 h-4" />
                        Allow command execution?
                    </div>
                    <code className="block bg-black/50 p-3 rounded text-xs text-red-100 font-mono mb-3 border border-red-500/10 break-all">
                        {pendingCommand}
                    </code>
                    <div className="flex gap-2 justify-end">
                        <button
                            onClick={() => onPermission('deny')}
                            className="px-4 py-2 bg-transparent hover:bg-white/5 text-white/60 text-xs rounded-md border border-white/10 transition-colors flex items-center gap-1.5"
                        >
                            <X className="w-3 h-3" /> Deny
                        </button>
                        <button
                            onClick={() => onPermission('always')}
                            className="px-4 py-2 bg-red-900/30 hover:bg-red-900/50 text-red-200 text-xs rounded-md border border-red-500/20 transition-colors"
                        >
                            Always Allow
                        </button>
                        <button
                            onClick={() => onPermission('allow')}
                            className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-xs rounded-md transition-colors flex items-center gap-1.5 shadow-lg shadow-red-900/20"
                        >
                            <Check className="w-3 h-3" /> Allow Once
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default AgentOverlay;
