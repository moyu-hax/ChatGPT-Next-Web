import {
  getClientApi,
  getBearerToken,
  LLMModel,
  RequestMessage,
} from "../client/api";
import {
  ACCESS_CODE_PREFIX,
  ApiPath,
  OpenaiPath,
  ServiceProvider,
} from "../constant";
import { useAccessStore } from "../store";
import { fetch } from "./stream";

export type ModelCheckResult = {
  available: boolean;
  latency: number;
  error?: string;
};

const CHECK_MESSAGES: RequestMessage[] = [
  {
    role: "user",
    content: "请回复“你好”，不要添加其他内容。",
  },
];

function getAccessCodeHeaders() {
  const accessCode = useAccessStore.getState().accessCode;
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: getBearerToken(ACCESS_CODE_PREFIX + accessCode),
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

function getAssistantText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";

  const data = payload as {
    choices?: Array<{
      text?: string;
      message?: {
        content?: string | Array<{ text?: string }>;
      };
    }>;
  };
  const choice = data.choices?.[0];
  const content = choice?.message?.content;

  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => item.text || "")
      .join("")
      .trim();
  }
  return choice?.text?.trim() || "";
}

async function checkOpenAIModel(
  model: string,
  timeoutMs: number,
): Promise<ModelCheckResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  const isReasoningModel =
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4") ||
    model.startsWith("gpt-5");

  try {
    const response = await fetch(`${ApiPath.OpenAI}/${OpenaiPath.ChatPath}`, {
      method: "POST",
      headers: getAccessCodeHeaders(),
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: CHECK_MESSAGES,
        stream: false,
        ...(isReasoningModel
          ? { max_completion_tokens: 64 }
          : { max_tokens: 16, temperature: 0 }),
      }),
    });
    const payload = await response.json().catch(() => undefined);

    if (response.ok) {
      const assistantText = getAssistantText(payload);
      return assistantText
        ? { available: true, latency: Date.now() - startedAt }
        : {
            available: false,
            latency: Date.now() - startedAt,
            error: "no_text_response",
          };
    }

    const detail = getErrorDetail(payload);
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
): Promise<LLMModel[]> {
  const models = await getClientApi(provider).llm.models({
    includeAll: true,
    headers: getAccessCodeHeaders(),
    baseUrl: ApiPath.OpenAI,
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
): Promise<ModelCheckResult> {
  const api = getClientApi(provider);
  if (provider === ServiceProvider.OpenAI) {
    return checkOpenAIModel(model, timeoutMs);
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
          providerName: provider,
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
) {
  let cursor = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), models.length);

  const worker = async () => {
    while (cursor < models.length) {
      const index = cursor++;
      const model = models[index];
      const result = await checkProviderModel(provider, model);
      onResult(model, result);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
}
