import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";
import { guardedHttpAdapterFetch } from "./remote-fetch.js";

const MAX_RESPONSE_BYTES = 16_000;
const MAX_SUMMARY_CHARS = 1_200;

async function readBoundedResponse(res: Response): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_RESPONSE_BYTES - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    if (!truncated && total === MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (!done && value?.byteLength) truncated = true;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

function summarizeResponse(status: number, text: string, parsed: unknown, truncated: boolean): string {
  const answer =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).answer === "string"
      ? (parsed as Record<string, unknown>).answer as string
      : text;
  const summary = answer.trim();
  const suffix = truncated ? " (response truncated)" : "";
  return (summary ? summary.slice(0, MAX_SUMMARY_CHARS) : `HTTP response ${status}`) + suffix;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const headers = parseObject(config.headers) as Record<string, string>;
  const payloadTemplate = parseObject(config.payloadTemplate);
  const body = {
    ...payloadTemplate,
    agentId: agent.id,
    runId,
    context,
    connectionInstructions: context.connectionInstructions ?? null,
    ...(ctx.runtimeTools ? { paperclipRuntimeTools: ctx.runtimeTools } : {}),
  };

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    ctx.onDispatch?.();
    const res = await guardedHttpAdapterFetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      ...(timer ? { signal: controller.signal } : {}),
    });

    if (!res.ok) {
      throw new Error(`HTTP invoke failed with status ${res.status}`);
    }

    const { text: responseText, truncated } = await readBoundedResponse(res);
    let parsed: unknown = null;
    if (responseText && !truncated) {
      try {
        parsed = JSON.parse(responseText);
      } catch {
        parsed = null;
      }
    }
    const resultJson =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : responseText
          ? { response: responseText, ...(truncated ? { responseTruncated: true } : {}) }
          : truncated
            ? { responseTruncated: true }
            : null;

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: summarizeResponse(res.status, responseText, parsed, truncated),
      resultJson,
    };
  } catch (err) {
    if (timer && err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `HTTP ${method} ${url} timed out after ${timeoutMs}ms`,
        errorCode: "timeout",
      };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
