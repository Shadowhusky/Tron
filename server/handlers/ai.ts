export async function testConnection({ provider, model, apiKey }: { provider: string; model: string; apiKey?: string }): Promise<boolean> {
  try {
    if (provider === "ollama") {
      const response = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model || "llama3",
          prompt: "hi",
          stream: false,
        }),
      });
      return response.ok;
    }

    if (provider === "openai") {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model || "gpt-3.5-turbo",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 5,
        }),
      });
      return response.ok;
    }

    if (provider === "anthropic") {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey || "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: model || "claude-3-opus-20240229",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 5,
        }),
      });
      return response.ok;
    }

    return false;
  } catch (e) {
    console.error("AI Connection Test Failed:", e);
    return false;
  }
}
