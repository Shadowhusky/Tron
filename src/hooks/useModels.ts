import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AIModel } from "../types";
import { aiService } from "../services/ai";

/** Fetch the model list from a single provider. */
export function useModels(baseUrl?: string, provider?: string, apiKey?: string) {
  return useQuery<AIModel[]>({
    queryKey: ["models", baseUrl, provider, apiKey],
    queryFn: () => aiService.getModels(baseUrl, provider, apiKey),
    staleTime: 30_000,
    retry: 0,
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
export function useModelsWithCaps(baseUrl?: string, enabled: boolean = true, provider?: string, apiKey?: string) {
  const queryClient = useQueryClient();

  return useQuery<AIModel[]>({
    queryKey: ["modelsWithCaps", baseUrl, provider, apiKey],
    enabled,
    queryFn: async () => {
      const list = await aiService.getModels(baseUrl, provider, apiKey);
      const ollamaModels = list.filter((m) => m.provider === "ollama");

      // Fetch capabilities sequentially to avoid 400 spam from Ollama
      for (const m of ollamaModels) {
        m.capabilities = await aiService.getModelCapabilities(m.name, baseUrl, provider, apiKey);
        // Seed the individual capability cache
        queryClient.setQueryData(
          ["modelCapabilities", m.name, baseUrl],
          m.capabilities,
        );
      }

      return list;
    },
    staleTime: 30_000,
    retry: 0,
  });
}

/**
 * Fetch models from ALL configured providers (for ContextBar model popover).
 * Reads provider configs from localStorage to find all set-up providers.
 * Only refetches on explicit invalidateModels() (e.g. Settings Save).
 */
export function useAllConfiguredModels() {
  return useQuery<AIModel[]>({
    queryKey: ["allConfiguredModels"],
    queryFn: () => aiService.getAllConfiguredModels(),
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: 0,
  });
}

/** Invalidate only the current provider's model queries (for confirm/refresh buttons). */
export function useInvalidateProviderModels() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["modelsWithCaps"] });
  };
}

/** Invalidate ALL model queries including cross-provider allConfiguredModels (for save). */
export function useInvalidateModels() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["models"] });
    queryClient.invalidateQueries({ queryKey: ["modelsWithCaps"] });
    queryClient.invalidateQueries({ queryKey: ["allConfiguredModels"] });
  };
}
