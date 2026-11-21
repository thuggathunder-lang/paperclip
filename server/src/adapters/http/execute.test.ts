import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTION_INTENT_AGENT_GUIDANCE } from "@paperclipai/shared";
import { execute } from "./execute.js";

const guardedFetchMock = vi.hoisted(() => vi.fn());

vi.mock("./remote-fetch.js", () => ({
  guardedHttpAdapterFetch: guardedFetchMock,
}));

afterEach(() => {
  guardedFetchMock.mockReset();
});

describe("http adapter execute", () => {
  it("delivers the complete runtime connection descriptor and shared guidance", async () => {
    const onDispatch = vi.fn();
    guardedFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      expect(onDispatch).toHaveBeenCalledOnce();
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.paperclipRuntimeTools).toEqual({
        version: 1,
        guidance: CONNECTION_INTENT_AGENT_GUIDANCE,
        mcpEndpoint: "https://paperclip.test/mcp/runtime-tools",
        rest: {
          connectionsSearch: "https://paperclip.test/runtime-tools/connections/search",
          connectionRequest: "https://paperclip.test/runtime-tools/connections/request",
        },
        bearerToken: "run-token",
        expiresAt: "2026-08-26T15:00:00.000Z",
        tools: ["connections_search", "connection_request"],
      });
      return new Response(null, { status: 204 });
    });

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent",
        adapterType: "http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { url: "https://example.test/webhook" },
      context: {},
      runtimeTools: {
        version: 1,
        guidance: CONNECTION_INTENT_AGENT_GUIDANCE,
        mcpEndpoint: "https://paperclip.test/mcp/runtime-tools",
        rest: {
          connectionsSearch: "https://paperclip.test/runtime-tools/connections/search",
          connectionRequest: "https://paperclip.test/runtime-tools/connections/request",
        },
        bearerToken: "run-token",
        expiresAt: "2026-08-26T15:00:00.000Z",
        tools: ["connections_search", "connection_request"],
      },
      onLog: async () => {},
      onDispatch,
    });

    expect(guardedFetchMock).toHaveBeenCalledOnce();
    expect(onDispatch).toHaveBeenCalledOnce();
  });

  it("sends the server snapshot instead of a configured payload instruction block", async () => {
    const snapshot = { text: "Use the release handbook.", digest: "server-digest" };
    guardedFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).connectionInstructions).toEqual(snapshot);
      return new Response(null, { status: 204 });
    });
    await execute({ runId: "run-1", agent: { id: "agent-1", companyId: "company-1", name: "Agent", adapterType: "http", adapterConfig: {} }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { url: "https://example.test/webhook", payloadTemplate: { connectionInstructions: { text: "forged" } } }, context: { connectionInstructions: snapshot }, onLog: async () => {},
    });
    expect(guardedFetchMock).toHaveBeenCalledOnce();
  });

  it("returns JSON webhook response data and a concise answer summary", async () => {
    guardedFetchMock.mockResolvedValue(new Response(JSON.stringify({ answer: "Task completed. Verified output.", status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const result = await execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Agent", adapterType: "http", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { url: "https://example.test/webhook" },
      context: {},
      onLog: async () => {},
    });
    expect(result.summary).toBe("Task completed. Verified output.");
    expect(result.resultJson).toEqual({ answer: "Task completed. Verified output.", status: "ok" });
  });

  it("returns plain-text webhook response in the result payload", async () => {
    guardedFetchMock.mockResolvedValue(new Response("Plain-text result", { status: 200 }));
    const result = await execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Agent", adapterType: "http", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { url: "https://example.test/webhook" },
      context: {},
      onLog: async () => {},
    });
    expect(result.summary).toBe("Plain-text result");
    expect(result.resultJson).toEqual({ response: "Plain-text result" });
  });

  it("reports configured request timeout as timed_out", async () => {
    guardedFetchMock.mockImplementation(
      (_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }),
    );

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent",
        adapterType: "http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        url: "https://example.test/webhook",
        timeoutMs: 1,
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("timed out after 1ms");
  });
});


describe("bounded HTTP response", () => {
  it("limits oversized response bodies and flags truncation", async () => {
    guardedFetchMock.mockResolvedValue(new Response("x".repeat(25_000), { status: 200 }));
    const result = await execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Agent", adapterType: "http", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { url: "https://example.test/webhook" },
      context: {},
      onLog: async () => {},
    });
    expect(result.resultJson).toEqual({ response: "x".repeat(16_000), responseTruncated: true });
    expect(result.summary).toContain("response truncated");
  });
});


describe("HTTP error response diagnostics", () => {
  it("includes a bounded response body in non-2xx errors", async () => {
    guardedFetchMock.mockResolvedValue(new Response("Gateway unavailable", { status: 502 }));
    await expect(execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Agent", adapterType: "http", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { url: "https://example.test/webhook" },
      context: {},
      onLog: async () => {},
    })).rejects.toThrow("HTTP invoke failed with status 502: Gateway unavailable");
  });

  it("caps diagnostic text from oversized non-2xx response bodies", async () => {
    guardedFetchMock.mockResolvedValue(new Response("x".repeat(25_000), { status: 500 }));
    await expect(execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Agent", adapterType: "http", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { url: "https://example.test/webhook" },
      context: {},
      onLog: async () => {},
    })).rejects.toThrow("HTTP invoke failed with status 500: " + "x".repeat(500) + " (error body truncated)");
  });
});
