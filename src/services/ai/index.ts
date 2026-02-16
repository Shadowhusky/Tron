
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
                const response = await fetch(`${baseUrl || 'http://localhost:11434'}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: model,
                        prompt: `${systemPrompt}\n\nUser request: ${prompt}\nCommand:`,
                        stream: false
                    })
                });
                const data = await response.json();
                return data.response.trim();
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

            // Fallback
            throw new Error(`Provider ${provider} not implemented completely yet`);

        } catch (error) {
            console.error('AI Generation failed:', error);
            throw error;
        }
    }
}

export const aiService = new AIService();
