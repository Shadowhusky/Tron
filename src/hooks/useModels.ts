import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AIModel } from "../types";
import { aiService } from "../services/ai";

/** Fetch the model list from all configured providers. */
export function useModels(baseUrl?: string) {
  return useQuery<AIModel[]>({
    queryKey: ["models", baseUrl],
    queryFn: () => aiService.getModels(baseUrl),
    staleTime: 30_000,
  });
}

/** Fetch capabilities for a single model. */
export function useModelCapabilities(modelName: string, baseUrl?: string) {
  return useQuery<string[]>({
    queryKey: ["modelCapabilities", modelName, baseUrl],
    queryFn: () => aiService.getModelCapabilities(modelName, baseUrl),
    staleTime: 5 * 60_000,
    enabled: !!modelName,
  });
}

/**
 * Fetch all models, then enrich each Ollama model with its capabilities.
 * Returns a flat list with `.capabilities` populated.
 */
export function useModelsWithCaps(baseUrl?: string, enabled: boolean = true) {
  const queryClient = useQueryClient();

  return useQuery<AIModel[]>({
    queryKey: ["modelsWithCaps", baseUrl],
    enabled,
    queryFn: async () => {
      const list = await aiService.getModels(baseUrl);
      const ollamaModels = list.filter((m) => m.provider === "ollama");

      // Fetch capabilities sequentially to avoid 400 spam from Ollama
      for (const m of ollamaModels) {
        m.capabilities = await aiService.getModelCapabilities(m.name, baseUrl);
        // Seed the individual capability cache
        queryClient.setQueryData(
          ["modelCapabilities", m.name, baseUrl],
          m.capabilities,
        );
      }

      return list;
    },
    staleTime: 30_000,
  });
}

/** Hook to get the invalidation helper for model queries. */
export function useInvalidateModels() {
  const queryClient = useQueryClient();
  return (baseUrl?: string) => {
    queryClient.invalidateQueries({ queryKey: ["models", baseUrl] });
    queryClient.invalidateQueries({ queryKey: ["modelsWithCaps", baseUrl] });
  };
}
