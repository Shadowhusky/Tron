import type { AIConfig, AIModel, AgentResult } from "../../types";
import { STORAGE_KEYS } from "../../constants/storage";
export type { AIConfig, AIModel, AgentResult };

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
    const stored = localStorage.getItem(STORAGE_KEYS.AI_CONFIG);
    if (stored) {
      this.config = { ...this.config, ...JSON.parse(stored) };
    }
  }

  saveConfig(config: Partial<AIConfig>) {
    this.config = { ...this.config, ...config };
    localStorage.setItem(STORAGE_KEYS.AI_CONFIG, JSON.stringify(this.config));
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

  /** Stream an Ollama /api/generate response, calling onToken for each chunk. Returns full text. */
  private async streamOllamaGenerate(
    baseUrl: string,
    model: string,
    prompt: string,
    onToken?: (token: string, thinking?: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await fetch(
      `${baseUrl}/api/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, stream: true, think: true }),
        signal,
      },
    );
    if (!response.ok) throw new Error(`Ollama Error: ${response.status}`);
    if (!response.body) throw new Error("No response body for streaming");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.thinking && onToken) onToken("", chunk.thinking);
          if (chunk.response) {
            fullText += chunk.response;
            if (onToken) onToken(chunk.response);
          }
        } catch { /* skip malformed lines */ }
      }
    }
    return fullText;
  }

  /** Stream an Ollama /api/chat response. Returns content and thinking text. */
  private async streamOllamaChat(
    baseUrl: string,
    model: string,
    messages: any[],
    onToken?: (token: string, thinking?: string) => void,
    signal?: AbortSignal,
    format?: string,
    think: boolean = true,
  ): Promise<{ content: string; thinking: string }> {
    const body: any = { model, messages, stream: true, think };
    if (format) body.format = format;

    const response = await fetch(
      `${baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.ok) throw new Error(`Ollama Error: ${response.status}`);
    if (!response.body) throw new Error("No response body for streaming");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let thinkingText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          const msg = chunk.message;
          if (msg?.thinking) {
            thinkingText += msg.thinking;
            if (onToken) onToken("", msg.thinking);
          }
          if (msg?.content) {
            fullText += msg.content;
            if (onToken) onToken(msg.content);
          }
        } catch { /* skip malformed lines */ }
      }
    }
    return { content: fullText, thinking: thinkingText };
  }

  async generateCommand(prompt: string, onToken?: (token: string) => void): Promise<string> {
    const { provider, model, apiKey, baseUrl } = this.config;

    const systemPrompt = `You are a terminal assistant. The user wants to perform a task. Output ONLY the exact command to run. No markdown, no explanation. If the task is simple, output a single command. If it requires multiple steps, output only the FIRST step. User OS: ${navigator.platform}.`;

    try {
      if (provider === "ollama") {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        try {
          const result = await this.streamOllamaGenerate(
            baseUrl || "http://localhost:11434",
            model,
            `${systemPrompt}\n\nUser request: ${prompt}\nCommand:`,
            onToken ? (token) => onToken(token) : undefined,
            controller.signal,
          );
          clearTimeout(timeout);
          return result.trim();
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

  async generatePlaceholder(context: string): Promise<string> {
    const { provider, model, apiKey, baseUrl } = this.config;
    if (!model) return "";

    const systemPrompt = `You predict what the user will type next in a terminal. Based on the recent terminal output, suggest a short one-line command or action. Output ONLY the suggestion text, nothing else. Keep it under 60 characters. If unsure, output an empty string.`;

    try {
      if (provider === "ollama") {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const response = await fetch(
            `${baseUrl || "http://localhost:11434"}/api/generate`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model,
                prompt: `${systemPrompt}\n\nRecent terminal output:\n${context.slice(-500)}\n\nSuggestion:`,
                stream: false,
              }),
              signal: controller.signal,
            },
          );
          clearTimeout(timeout);
          if (!response.ok) return "";
          const data = await response.json();
          const result = (data.response || "").trim();
          return result.length <= 80 ? result : "";
        } catch {
          clearTimeout(timeout);
          return "";
        }
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
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Recent terminal output:\n${context.slice(-500)}` },
              ],
              max_tokens: 30,
            }),
          },
        );
        const data = await response.json();
        const result = (data.choices?.[0]?.message?.content || "").trim();
        return result.length <= 80 ? result : "";
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
            max_tokens: 30,
            system: systemPrompt,
            messages: [
              { role: "user", content: `Recent terminal output:\n${context.slice(-500)}` },
            ],
          }),
        });
        const data = await response.json();
        const result = (data.content?.[0]?.text || "").trim();
        return result.length <= 80 ? result : "";
      }
    } catch {
      // Silently fail — placeholder is non-critical
    }
    return "";
  }

  async runAgent(
    prompt: string,
    executeCommand: (cmd: string) => Promise<string>,
    writeToTerminal: (cmd: string) => void,
    onUpdate: (step: string, output: string) => void,
    sessionConfig?: AIConfig,
    signal?: AbortSignal,
    thinkingEnabled: boolean = true,
  ): Promise<AgentResult> {
    const { provider, model, baseUrl } = sessionConfig || this.config;

    const history: any[] = [
      {
        role: "system",
        content: `You are an autonomous terminal agent.
You can execute commands on the user's machine to achieve the goal.
User OS: ${navigator.platform}.

TOOLS:
1. execute_command: Run a shell command in the background and get output (e.g. ls, cat, grep, writing files).
   Format: {"tool": "execute_command", "command": "ls -la"}
   Use this when you need to SEE the output or CREATE/EDIT files.
   This runs in a non-interactive shell — heredocs, pipes, and multiline commands all work.

2. run_in_terminal: Run a command in the user's visible terminal (e.g. npm start, cd, vi).
   Format: {"tool": "run_in_terminal", "command": "npm run dev"}
   Use this ONLY for:
   - Interactive commands (editors, REPLs)
   - Long-running processes (servers, watchers)
   - Changing directory (cd)
   - Opening files (open, xdg-open)
   NOTE: You will NOT see the output. It is "fire and forget".
   NEVER use this for writing files — no cat heredoc, no echo redirection, no tee.

RESPONSE FORMAT:
You must respond with valid JSON only.
Example:
{"tool": "execute_command", "command": "cat file.txt"}

If you have completed the task or need to answer the user:
{"tool": "final_answer", "content": "I have started the server."}

If you CANNOT complete the task:
{"tool": "final_answer", "content": "I cannot do this because..."}

Be concise and direct.
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
5. For creating/editing files, ALWAYS use 'execute_command' with cat heredoc or printf. NEVER use 'run_in_terminal' for file operations.
6. Break complex tasks into small, sequential steps. Execute ONE command at a time.
7. NEVER chain many commands with && for complex operations. Use separate tool calls instead.
`;

    let parseFailures = 0;
    for (let i = 0; i < maxSteps; i++) {
      if (signal?.aborted) {
        throw new Error("Agent aborted by user.");
      }
      onUpdate("thinking", "Agent is thinking...");

      let responseText = "";

      // 1. Get LLM Response (streaming for Ollama)
      let thinkingText = "";
      try {
        if (provider === "ollama") {
          let thinkingAccumulated = "";
          const result = await this.streamOllamaChat(
            baseUrl || "http://localhost:11434",
            model,
            history,
            thinkingEnabled ? (_token, thinking) => {
              if (thinking) {
                thinkingAccumulated += thinking;
                onUpdate("streaming_thinking", thinkingAccumulated);
              }
            } : undefined,
            signal,
            "json",
            thinkingEnabled,
          );
          responseText = result.content;
          thinkingText = result.thinking;
          if (thinkingAccumulated) {
            onUpdate("thinking_complete", thinkingAccumulated);
          }
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

      // 2. Parse Tool Call — try content first, then extract from thinking
      let action: any;
      const tryParseJson = (text: string): any => {
        if (!text.trim()) return null;
        // Direct parse
        try { return JSON.parse(text); } catch {}
        // Extract from markdown code block
        const mdMatch = text.match(/```json\s*([\s\S]*?)```/);
        if (mdMatch) { try { return JSON.parse(mdMatch[1]); } catch {} }
        // Extract first JSON object containing "tool"
        const jsonMatch = text.match(/\{[^{}]*"tool"\s*:\s*"[^"]+?"[^{}]*\}/);
        if (jsonMatch) { try { return JSON.parse(jsonMatch[0]); } catch {} }
        return null;
      };

      action = tryParseJson(responseText);
      // Fallback: model may put JSON in thinking instead of content
      if (!action?.tool && thinkingText) {
        action = tryParseJson(thinkingText);
      }

      if (!action || !action.tool) {
        parseFailures++;
        if (parseFailures >= 3) {
          return {
            success: false,
            message: "Agent stopped: model failed to produce valid tool calls after multiple attempts.",
          };
        }
        onUpdate("error", `Failed to parse agent response. Retrying...`);
        history.push({ role: "assistant", content: responseText || "(empty)" });
        history.push({
          role: "user",
          content:
            "Error: Invalid JSON format. You MUST respond with valid JSON containing a \"tool\" field. Example: {\"tool\": \"final_answer\", \"content\": \"Done.\"}",
        });
        continue;
      }
      parseFailures = 0; // Reset on successful parse

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
