
export interface AIModel {
    name: string;
    provider: 'ollama' | 'openai' | 'anthropic' | 'gemini';
}

export interface AIConfig {
    provider: 'ollama' | 'openai' | 'anthropic' | 'gemini';
    model: string;
    apiKey?: string;
    baseUrl?: string;
}

class AIService {
    private config: AIConfig = {
        provider: 'ollama',
        model: 'llama3',
        baseUrl: 'http://localhost:11434'
    };

    constructor() {
        this.loadConfig();
    }

    private loadConfig() {
        const stored = localStorage.getItem('tron_ai_config');
        if (stored) {
            this.config = { ...this.config, ...JSON.parse(stored) };
        }
    }

    saveConfig(config: Partial<AIConfig>) {
        this.config = { ...this.config, ...config };
        localStorage.setItem('tron_ai_config', JSON.stringify(this.config));
    }

    getConfig() {
        return this.config;
    }

    async getModels(): Promise<AIModel[]> {
        // For now, mostly support Ollama auto-discovery
        const models: AIModel[] = [];

        // 1. Ollama
        try {
            const response = await fetch(`${this.config.baseUrl || 'http://localhost:11434'}/api/tags`);
            if (response.ok) {
                const data = await response.json();
                data.models?.forEach((m: any) => {
                    models.push({ name: m.name, provider: 'ollama' });
                });
            }
        } catch (e) {
            console.warn('Failed to fetch Ollama models', e);
        }

        // 2. Add standard cloud models (static list for now)
        models.push({ name: 'gpt-4o', provider: 'openai' });
        models.push({ name: 'gpt-3.5-turbo', provider: 'openai' });
        models.push({ name: 'claude-3-opus', provider: 'anthropic' });
        models.push({ name: 'claude-3-sonnet', provider: 'anthropic' });
        models.push({ name: 'gemini-pro', provider: 'gemini' });

        return models;
    }

    async generateCommand(prompt: string): Promise<string> {
        const { provider, model, apiKey, baseUrl } = this.config;

        const systemPrompt = `You are a terminal assistant. The user wants to perform a task. Output ONLY the exact command to run. No markdown, no explanation. If multiple commands are needed, join them with &&. User OS: ${navigator.platform}.`;

        try {
            if (provider === 'ollama') {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout check

                try {
                    const response = await fetch(`${baseUrl || 'http://localhost:11434'}/api/generate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: model,
                            prompt: `${systemPrompt}\n\nUser request: ${prompt}\nCommand:`,
                            stream: false
                        }),
                        signal: controller.signal
                    });
                    clearTimeout(timeout);

                    if (!response.ok) {
                        throw new Error(`Ollama Error: ${response.status} ${response.statusText}`);
                    }

                    const data = await response.json();
                    if (!data || typeof data.response !== 'string') {
                        console.error('Invalid Ollama response:', data);
                        throw new Error('Invalid response format from Ollama');
                    }
                    return data.response.trim();
                } catch (fetchError: any) {
                    clearTimeout(timeout);
                    if (fetchError.name === 'AbortError') throw new Error('Ollama connection timed out. Is it running?');
                    throw fetchError;
                }
            }

            if (provider === 'openai') {
                if (!apiKey) throw new Error('OpenAI API Key required');
                const response = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: prompt }
                        ]
                    })
                });
                const data = await response.json();
                return data.choices[0].message.content.trim();
            }

            if (provider === 'anthropic') {
                if (!apiKey) throw new Error('Anthropic API Key required');
                // checking anthropic format (messages API)
                const response = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01',
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: model,
                        max_tokens: 100,
                        system: systemPrompt,
                        messages: [{ role: 'user', content: prompt }]
                    })
                });
                // Note: Anthropic might require proxy due to CORS in browser
                const data = await response.json();
                return data.content[0].text.trim();
            }

            throw new Error(`Provider ${provider} not supported for command generation.`);
        } catch (e: any) {
            console.error(`Error generating command with ${provider}:`, e);
            throw e;
        }
    }

    // --- Agent Mode ---
    async runAgent(
        prompt: string,
        executeCommand: (cmd: string) => Promise<string>,
        onUpdate: (step: string, output: string) => void
    ): Promise<string> {
        const { provider, model, baseUrl } = this.config;

        // Initial system prompt
        const history: any[] = [
            {
                role: 'system', content: `You are an autonomous terminal agent.
You can execute commands on the user's machine to achieve the goal.
User OS: ${navigator.platform}.

TOOLS:
1. execute_command: Run a shell command.
   Format: {"tool": "execute_command", "command": "YOUR COMMAND HERE"}

RESPONSE FORMAT:
You must respond with valid JSON only.
If you want to run a command:
{"tool": "execute_command", "command": "ls -la"}

If you have completed the task or need to answer the user:
{"tool": "final_answer", "content": "I have listed the files."}

Think step-by-step.
`}
        ];

        history.push({ role: 'user', content: prompt });

        const maxSteps = 10;
        const executedCommands = new Set<string>();

        // System prompt update to be more strict
        history[0].content += `
CRITICAL RULES:
1. DO NOT run the same command twice.
2. If a command runs successfully but has no output (like 'mkdir' or 'cp'), assume it worked and proceed.
3. If you are stuck, ask the user for help.
`;

        for (let i = 0; i < maxSteps; i++) {
            onUpdate('thinking', 'Agent is thinking...');

            let responseText = '';

            // 1. Get LLM Response
            try {
                if (provider === 'ollama') {
                    const response = await fetch(`${baseUrl || 'http://localhost:11434'}/api/chat`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: model,
                            messages: history,
                            stream: false,
                            format: "json" // Force JSON mode for Ollama
                        })
                    });
                    if (!response.ok) throw new Error(`Ollama Error: ${response.status}`);
                    const data = await response.json();
                    responseText = data.message.content;
                }
                // Implement OpenAI/Anthropic similarly (simplified for now)
                else {
                    throw new Error('Agent Mode currently only supports Ollama (beta). Switch provider to Ollama.');
                }
            } catch (e: any) {
                throw new Error(`Agent LLM Error: ${e.message}`);
            }

            // 2. Parse Tool Call
            let action: any;
            try {
                action = JSON.parse(responseText);
            } catch (e) {
                // Try to repair valid JSON from markdown block
                const match = responseText.match(/```json([\s\S]*?)```/);
                if (match) {
                    try { action = JSON.parse(match[1]); } catch { }
                }
            }

            if (!action || !action.tool) {
                onUpdate('error', `Failed to parse agent response. Retrying...`);
                history.push({ role: 'assistant', content: responseText });
                history.push({ role: 'user', content: "Error: Invalid JSON format. Please respond with valid JSON." });
                continue;
            }

            history.push({ role: 'assistant', content: JSON.stringify(action) });

            // 3. Execute Tool
            if (action.tool === 'final_answer') {
                return action.content;
            }

            if (action.tool === 'execute_command') {
                // Loop Prevention
                if (executedCommands.has(action.command)) {
                    const errorMsg = `Error: You have already executed this command: "${action.command}". Do not repeat commands. Check previous output or try a different approach.`;
                    history.push({ role: 'user', content: errorMsg });
                    continue;
                }
                executedCommands.add(action.command);

                onUpdate('executing', `Running: ${action.command}`);
                try {
                    let output = await executeCommand(action.command);
                    if (!output || output.trim() === '') {
                        output = "(Command executed successfully with no output)";
                    }
                    history.push({ role: 'user', content: `Command Output:\n${output}` });
                } catch (err: any) {
                    history.push({ role: 'user', content: `Command Failed:\n${err.message}` });
                }
            }
        }

        return "Agent reached maximum steps without completion.";
    }
}

export const aiService = new AIService();
