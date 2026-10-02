import { WebSocket } from "ws";

const config = {
  relayUrl: required("RELAY_URL"),
  agentId: required("AGENT_ID"),
  agentToken: required("AGENT_BEARER_TOKEN"),
  services: configuredServices(required("SERVICES_JSON")),
  reconnectMaxMs: positiveInteger("RECONNECT_MAX_MS", 30_000),
};

const activeRequests = new Map();
let reconnectDelay = 1_000;
connect();

function connect() {
  const endpoint = toWebSocketUrl(config.relayUrl);
  const socket = new WebSocket(`${endpoint}/agent`, {
    headers: { Authorization: `Bearer ${config.agentToken}` },
    perMessageDeflate: false,
  });

  socket.on("open", () => {
    reconnectDelay = 1_000;
    send(socket, { type: "register", agentId: config.agentId });
  });

  socket.on("message", (raw, isBinary) => {
    if (isBinary) return;
    try {
      handleMessage(socket, JSON.parse(raw.toString("utf8")));
    } catch (error) {
      console.error("Invalid relay message:", error instanceof Error ? error.message : error);
    }
  });

  socket.on("close", (code, reason) => {
    console.warn(`Relay disconnected (${code}: ${reason.toString() || "no reason"}). Retrying in ${reconnectDelay}ms.`);
    for (const controller of activeRequests.values()) controller.abort();
    activeRequests.clear();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, config.reconnectMaxMs);
  });

  socket.on("error", (error) => console.warn(`Relay socket error: ${error.message}`));
}

async function handleMessage(socket, message) {
  if (message.type === "registered") {
    console.log(`Registered as ${message.agentId}; available services: ${Object.keys(config.services).join(", ")}`);
    return;
  }
  if (message.type === "cancel") {
    activeRequests.get(message.requestId)?.abort();
    return;
  }
  if (message.type !== "proxy_request") return;

  const controller = new AbortController();
  activeRequests.set(message.requestId, controller);
  try {
    const outbound = message.request || {};
    const targetUrl = serviceUrl(outbound.service, outbound.pathAndQuery);
    console.log(`[${message.requestId}] Forwarding ${outbound.method || "POST"} to ${targetUrl}`);
    const response = await fetch(targetUrl, {
      method: outbound.method || "POST",
      headers: filterHeaders(outbound.headers || {}),
      body: outbound.bodyBase64 ? Buffer.from(outbound.bodyBase64, "base64") : undefined,
      signal: controller.signal,
      redirect: "manual",
    });
    console.log(`[${message.requestId}] Local service responded with ${response.status}`);

    send(socket, {
      type: "proxy_response_start",
      requestId: message.requestId,
      status: response.status,
      headers: filterHeaders(Object.fromEntries(response.headers.entries())),
    });

    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        send(socket, { type: "proxy_response_chunk", requestId: message.requestId, chunkBase64: Buffer.from(value).toString("base64") });
      }
    }
    send(socket, { type: "proxy_response_end", requestId: message.requestId });
  } catch (error) {
    console.error(`[${message.requestId}] Local service request failed:`, error);
    send(socket, {
      type: "proxy_error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : "Unknown local MCP error",
    });
  } finally {
    activeRequests.delete(message.requestId);
  }
}

function filterHeaders(headers) {
  const blocked = new Set(["authorization", "connection", "host", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "accept-encoding"]);
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => !blocked.has(name.toLowerCase()) && value !== undefined));
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function toWebSocketUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  else if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else throw new Error("RELAY_URL must start with http:// or https://");
  return parsed.toString().replace(/\/$/, "");
}

function configuredServices(value) {
  let services;
  try {
    services = JSON.parse(value);
  } catch {
    throw new Error("SERVICES_JSON must be a JSON object mapping service names to HTTP URLs");
  }
  if (!services || Array.isArray(services) || typeof services !== "object") {
    throw new Error("SERVICES_JSON must be a JSON object mapping service names to HTTP URLs");
  }
  for (const [name, url] of Object.entries(services)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || typeof url !== "string") {
      throw new Error("SERVICES_JSON contains an invalid service name or URL");
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Service ${name} must use http:// or https://`);
    }
  }
  return services;
}

function serviceUrl(service, pathAndQuery = "/") {
  if (typeof service !== "string" || !config.services[service]) {
    throw new Error("Requested service is not configured on this agent");
  }
  const base = new URL(config.services[service]);
  const requested = new URL(pathAndQuery, "http://tunnel.invalid");
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  const requestedPath = requested.pathname === "/" ? "" : requested.pathname;
  base.pathname = `${basePath}${requestedPath}` || "/";
  base.search = requested.search;
  return base;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
