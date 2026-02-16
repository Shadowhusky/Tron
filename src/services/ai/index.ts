export interface AIModel {
  name: string;
  provider: "ollama" | "openai" | "anthropic" | "gemini";
}

export interface AIConfig {
  provider: "ollama" | "openai" | "anthropic" | "gemini";
  model: string;
  apiKey?: string;
  baseUrl?: string;
  contextWindow?: number;
}

export interface AgentResult {
  success: boolean;
  message: string;
}

class AIService {
  private config: AIConfig = {
    provider: "ollama",
    model: "llama3",
    baseUrl: "http://localhost:11434",
  };

  constructor() {
    this.loadConfig();
  }

  private loadConfig() {
    const stored = localStorage.getItem("tron_ai_config");
    if (stored) {
      this.config = { ...this.config, ...JSON.parse(stored) };
    }
  }

  saveConfig(config: Partial<AIConfig>) {
    this.config = { ...this.config, ...config };
    localStorage.setItem("tron_ai_config", JSON.stringify(this.config));
  }

  getConfig() {
    return this.config;
  }

  async getModels(): Promise<AIModel[]> {
    const models: AIModel[] = [];

    // 1. Ollama — only if reachable
    try {
      const response = await fetch(
        `${this.config.baseUrl || "http://localhost:11434"}/api/tags`,
      );
      if (response.ok) {
        const data = await response.json();
        data.models?.forEach((m: any) => {
          models.push({ name: m.name, provider: "ollama" });
        });
      }
    } catch (e) {
      console.warn("Failed to fetch Ollama models", e);
    }

    // 2. Cloud models — only show if API key is configured
    if (this.config.apiKey && this.config.provider === "openai") {
      models.push({ name: "gpt-4o", provider: "openai" });
      models.push({ name: "gpt-3.5-turbo", provider: "openai" });
    }
    if (this.config.apiKey && this.config.provider === "anthropic") {
      models.push({ name: "claude-3-opus", provider: "anthropic" });
      models.push({ name: "claude-3-sonnet", provider: "anthropic" });
    }

    return models;
  }

  async summarizeContext(history: string): Promise<string> {
    const { provider, model, apiKey, baseUrl } = this.config;
    const prompt = `Summarize the following terminal session history. Retain key actions, file changes, errors, and state changes. Be concise.\n\n${history}`;

    try {
      if (provider === "ollama") {
        const response = await fetch(
          `${baseUrl || "http://localhost:11434"}/api/generate`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, prompt, stream: false }),
          },
        );
        if (!response.ok) throw new Error(`Ollama: ${response.status}`);
        const data = await response.json();
        return data.response?.trim() || history;
      }

      if (provider === "openai" && apiKey) {
        const response = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: prompt }],
              max_tokens: 500,
            }),
          },
        );
        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim() || history;
      }

      if (provider === "anthropic" && apiKey) {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 500,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const data = await response.json();
        return data.content?.[0]?.text?.trim() || history;
      }
    } catch (e) {
      console.warn("Context compression failed, using raw history", e);
    }
    return history;
  }

  async generateCommand(prompt: string): Promise<string> {
    const { provider, model, apiKey, baseUrl } = this.config;

    const systemPrompt = `You are a terminal assistant. The user wants to perform a task. Output ONLY the exact command to run. No markdown, no explanation. If multiple commands are needed, join them with &&. User OS: ${navigator.platform}.`;

    try {
      if (provider === "ollama") {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout check

        try {
          const response = await fetch(
            `${baseUrl || "http://localhost:11434"}/api/generate`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: model,
                prompt: `${systemPrompt}\n\nUser request: ${prompt}\nCommand:`,
                stream: false,
              }),
              signal: controller.signal,
            },
          );
          clearTimeout(timeout);

          if (!response.ok) {
            throw new Error(
              `Ollama Error: ${response.status} ${response.statusText}`,
            );
          }

          const data = await response.json();
          if (!data || typeof data.response !== "string") {
            console.error("Invalid Ollama response:", data);
            throw new Error("Invalid response format from Ollama");
          }
          return data.response.trim();
        } catch (fetchError: any) {
          clearTimeout(timeout);
          if (fetchError.name === "AbortError")
            throw new Error("Ollama connection timed out. Is it running?");
          throw fetchError;
        }
      }

      if (provider === "openai") {
        if (!apiKey) throw new Error("OpenAI API Key required");
        const response = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: model,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt },
              ],
            }),
          },
        );
        const data = await response.json();
        return data.choices[0].message.content.trim();
      }

      if (provider === "anthropic") {
        if (!apiKey) throw new Error("Anthropic API Key required");
        // checking anthropic format (messages API)
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: model,
            max_tokens: 100,
            system: systemPrompt,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        // Note: Anthropic might require proxy due to CORS in browser
        const data = await response.json();
        return data.content[0].text.trim();
      }

      throw new Error(
        `Provider ${provider} not supported for command generation.`,
      );
    } catch (e: any) {
      console.error(`Error generating command with ${provider}:`, e);
      throw e;
    }
  }

  async runAgent(
    prompt: string,
    executeCommand: (cmd: string) => Promise<string>,
    writeToTerminal: (cmd: string) => void,
    onUpdate: (step: string, output: string) => void,
    sessionConfig?: AIConfig,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    const { provider, model, baseUrl } = sessionConfig || this.config;

    // ... (history setup same as before) ...
    // Initial system prompt
    const history: any[] = [
      {
        role: "system",
        content: `You are an autonomous terminal agent.
You can execute commands on the user's machine to achieve the goal.
User OS: ${navigator.platform}.

TOOLS:
1. execute_command: Run a shell command in the background to inspect output (e.g. ls, cat, grep).
   Format: {"tool": "execute_command", "command": "ls -la"}
   Use this when you need to SEE the output to decide what to do next.

2. run_in_terminal: Run a command in the user's actual terminal (e.g. npm start, cd, nano, vi).
   Format: {"tool": "run_in_terminal", "command": "npm run dev"}
   Use this for:
   - Interactive commands
   - Long-running processes (servers, watchers)
   - Changing directory (cd)
   - Opening editors
   NOTE: You will NOT see the output of this command immediately. It is "fire and forget".

RESPONSE FORMAT:
You must respond with valid JSON only.
Example:
{"tool": "run_in_terminal", "command": "cd ./src"}

If you have completed the task or need to answer the user:
{"tool": "final_answer", "content": "I have started the server."}

If you CANNOT complete the task:
{"tool": "final_answer", "content": "I cannot do this because..."}

Think step-by-step.
`,
      },
    ];

    history.push({ role: "user", content: prompt });

    const maxSteps = 15;
    const executedCommands = new Set<string>();

    history[0].content += `
CRITICAL RULES:
1. DO NOT run the same command twice.
2. If a command runs successfully but has no output (like 'mkdir' or 'cp'), assume it worked and proceed.
3. If you are stuck, ask the user for help.
4. Always use 'run_in_terminal' for 'cd' or starting servers.
`;

    for (let i = 0; i < maxSteps; i++) {
      if (signal?.aborted) {
        throw new Error("Agent aborted by user.");
      }
      onUpdate("thinking", "Agent is thinking...");

      let responseText = "";

      // 1. Get LLM Response
      try {
        if (provider === "ollama") {
          const response = await fetch(
            `${baseUrl || "http://localhost:11434"}/api/chat`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: model,
                messages: history,
                stream: false,
                format: "json",
              }),
              signal,
            },
          );
          if (!response.ok) throw new Error(`Ollama Error: ${response.status}`);
          const data = await response.json();
          responseText = data.message.content;
        } else {
          // ... (fallback same as before)
          await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify({
              model: model,
              messages: history,
            }),
          });
          throw new Error(
            "Agent Mode currently only supports Ollama (beta). Switch provider to Ollama.",
          );
        }
      } catch (e: any) {
        if (signal?.aborted || e.name === "AbortError") {
          throw new Error("Agent aborted by user.");
        }
        onUpdate("error", `LLM Error: ${e.message}`);
        return {
          success: false,
          message: `Agent stopped due to LLM error: ${e.message}`,
        };
      }

      // 2. Parse Tool Call
      let action: any;
      try {
        action = JSON.parse(responseText);
      } catch (e) {
        const match = responseText.match(/```json([\s\S]*?)```/);
        if (match) {
          try {
            action = JSON.parse(match[1]);
          } catch {}
        }
      }

      if (!action || !action.tool) {
        onUpdate("error", `Failed to parse agent response. Retrying...`);
        history.push({ role: "assistant", content: responseText });
        history.push({
          role: "user",
          content:
            "Error: Invalid JSON format. Please respond with valid JSON.",
        });
        continue;
      }

      history.push({ role: "assistant", content: JSON.stringify(action) });

      // 3. Execute Tool
      if (action.tool === "final_answer") {
        return { success: true, message: action.content };
      }

      if (action.tool === "run_in_terminal") {
        writeToTerminal(action.command + "\n");
        onUpdate("executed", action.command);
        history.push({
          role: "user",
          content: `(Command sent to terminal. Assume success.)`,
        });
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      if (action.tool === "execute_command") {
        if (executedCommands.has(action.command)) {
          const errorMsg = `Error: You have already executed this command: "${action.command}". Do not repeat commands. Check previous output or try a different approach.`;
          history.push({ role: "user", content: errorMsg });
          continue;
        }
        executedCommands.add(action.command);

        onUpdate("executing", action.command);
        try {
          let output = await executeCommand(action.command);
          if (!output || output.trim() === "") {
            output = "(Command executed successfully with no output)";
          }
          onUpdate("executed", action.command);
          history.push({ role: "user", content: `Command Output:\n${output}` });
        } catch (err: any) {
          onUpdate("failed", `${action.command}\n${err.message}`);
          history.push({
            role: "user",
            content: `Command Failed:\n${err.message}`,
          });
        }
      }
    }

    return {
      success: false,
      message: "Agent reached maximum steps without completion.",
    };
  }
}

export const aiService = new AIService();
