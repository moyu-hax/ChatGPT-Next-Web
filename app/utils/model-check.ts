import {
  getClientApi,
  getBearerToken,
  LLMModel,
  RequestMessage,
} from "../client/api";
import { ACCESS_CODE_PREFIX, OpenaiPath, ServiceProvider } from "../constant";
import { ChatGPTApi } from "../client/platforms/openai";
import { useAccessStore } from "../store";
import type { CustomModelGroup } from "../store/config";
import { fetch } from "./stream";

export type ModelCheckResult = {
  available: boolean;
  latency: number;
  error?: string;
};

const CHECK_MESSAGES: RequestMessage[] = [
  {
    role: "system",
    content: "test",
  },
  {
    role: "user",
    content: "hi",
  },
];

function getModelRequestHeaders(group?: CustomModelGroup) {
  const accessStore = useAccessStore.getState();
  let authorization = "";
  if (group?.source === "custom") {
    authorization = getBearerToken(group.openaiApiKey?.trim() ?? "");
  } else if (group?.source === "access-code") {
    authorization = getBearerToken(
      ACCESS_CODE_PREFIX + (group.accessCode ?? ""),
    );
  } else if (accessStore.useCustomConfig) {
    authorization = getBearerToken(accessStore.openaiApiKey.trim());
  } else {
    authorization = getBearerToken(ACCESS_CODE_PREFIX + accessStore.accessCode);
  }

  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: authorization,
  };
}

function getErrorDetail(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";

  const data = payload as {
    error?: string | { message?: string };
    message?: string;
    msg?: string;
  };
  if (typeof data.error === "string") return data.error;
  return data.error?.message || data.message || data.msg || "";
}

function hasCompletionChoice(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;

  const choice = choices[0];
  return (
    !!choice &&
    typeof choice === "object" &&
    ("message" in choice || "text" in choice)
  );
}

async function checkOpenAIModel(
  api: ChatGPTApi,
  model: string,
  timeoutMs: number,
  group?: CustomModelGroup,
): Promise<ModelCheckResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(api.path(OpenaiPath.ChatPath, group), {
      method: "POST",
      headers: getModelRequestHeaders(group),
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: CHECK_MESSAGES,
        stream: false,
      }),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        available: false,
        latency: Date.now() - startedAt,
        error: "invalid_response",
      };
    }

    const detail = getErrorDetail(payload);

    if (response.ok) {
      if (detail) {
        return {
          available: false,
          latency: Date.now() - startedAt,
          error: detail,
        };
      }

      return hasCompletionChoice(payload)
        ? { available: true, latency: Date.now() - startedAt }
        : {
            available: false,
            latency: Date.now() - startedAt,
            error: "invalid_response",
          };
    }

    return {
      available: false,
      latency: Date.now() - startedAt,
      error: detail
        ? `HTTP ${response.status}: ${detail}`
        : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      available: false,
      latency: Date.now() - startedAt,
      error: controller.signal.aborted
        ? "timeout"
        : error instanceof Error
        ? error.message
        : String(error),
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchProviderModels(
  provider: ServiceProvider,
  group?: CustomModelGroup,
): Promise<LLMModel[]> {
  const models = await getClientApi(provider).llm.models({
    includeAll: true,
    headers: getModelRequestHeaders(group),
    group,
  });
  const uniqueModels = new Map<string, LLMModel>();

  for (const model of models) {
    if (model.name) {
      uniqueModels.set(model.name, model);
    }
  }

  return Array.from(uniqueModels.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export async function checkProviderModel(
  provider: ServiceProvider,
  model: string,
  timeoutMs = 30000,
  group?: CustomModelGroup,
): Promise<ModelCheckResult> {
  const api = getClientApi(provider);
  if (provider === ServiceProvider.OpenAI && api.llm instanceof ChatGPTApi) {
    return checkOpenAIModel(api.llm, model, timeoutMs, group);
  }

  const startedAt = Date.now();

  return new Promise<ModelCheckResult>((resolve) => {
    let controller: AbortController | undefined;
    let settled = false;

    const finish = (result: Omit<ModelCheckResult, "latency">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve({ ...result, latency: Date.now() - startedAt });
    };

    const timeoutId = window.setTimeout(() => {
      controller?.abort();
      finish({ available: false, error: "timeout" });
    }, timeoutMs);

    void api.llm
      .chat({
        messages: CHECK_MESSAGES,
        config: {
          model,
          providerName: group?.name ?? provider,
          stream: false,
          temperature: 0,
        },
        onController(nextController) {
          controller = nextController;
        },
        onFinish(message, response) {
          if (response.ok) {
            finish({ available: true });
            return;
          }

          const detail =
            typeof message === "string" && message.trim().length > 0
              ? message.trim()
              : response.statusText;
          finish({
            available: false,
            error: detail
              ? `HTTP ${response.status}: ${detail}`
              : `HTTP ${response.status}`,
          });
        },
        onError(error) {
          finish({ available: false, error: error.message });
        },
      })
      .catch((error) => {
        finish({
          available: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
}

export async function checkProviderModels(
  provider: ServiceProvider,
  models: string[],
  onResult: (model: string, result: ModelCheckResult) => void,
  concurrency = 3,
  group?: CustomModelGroup,
) {
  let cursor = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), models.length);

  const worker = async () => {
    while (cursor < models.length) {
      const index = cursor++;
      const model = models[index];
      const result = await checkProviderModel(provider, model, 30000, group);
      onResult(model, result);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
}
