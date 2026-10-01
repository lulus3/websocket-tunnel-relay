import crypto from "node:crypto";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const config = {
  host: process.env.HOST || "127.0.0.1",
  port: positiveInteger("PORT", 8787),
  expectedAgentId: required("TUNNEL_AGENT_ID"),
  clientToken: required("CLIENT_BEARER_TOKEN"),
  agentToken: required("AGENT_BEARER_TOKEN"),
  maxRequestBytes: positiveInteger("MAX_REQUEST_BYTES", 10 * 1024 * 1024),
  requestTimeoutMs: positiveInteger("REQUEST_TIMEOUT_MS", 120_000),
};

const agents = new Map();
const pending = new Map();
const server = http.createServer(handleHttpRequest);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: config.maxRequestBytes });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== "/agent" || !hasBearerToken(request.headers.authorization, config.agentToken)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});

wss.on("connection", (ws) => {
  let agentId;
  const registerTimer = setTimeout(() => ws.close(1008, "registration timeout"), 10_000);

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return ws.close(1003, "JSON messages only");
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      return ws.close(1007, "invalid JSON");
    }

    if (!agentId) {
      if (message.type !== "register" || message.agentId !== config.expectedAgentId) {
        return ws.close(1008, "unexpected agent");
      }
      clearTimeout(registerTimer);
      agentId = message.agentId;
      const previous = agents.get(agentId);
      if (previous && previous !== ws) previous.close(1012, "replaced by a newer connection");
      agents.set(agentId, ws);
      send(ws, { type: "registered", agentId });
      console.log(`Agent ${agentId} connected.`);
      return;
    }

    handleAgentMessage(agentId, message);
  });

  ws.on("close", () => {
    clearTimeout(registerTimer);
    if (agentId && agents.get(agentId) === ws) {
      agents.delete(agentId);
      failRequestsForAgent(agentId, "The private MCP agent disconnected.");
      console.log(`Agent ${agentId} disconnected.`);
    }
  });
});

function handleHttpRequest(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, agentConnected: agents.has(config.expectedAgentId) }));
    return;
  }
  const service = getServiceName(url.pathname);
  if (!service) {
    response.writeHead(404).end();
    return;
  }
  if (!hasBearerToken(request.headers.authorization, config.clientToken)) {
    response.writeHead(401, { "www-authenticate": "Bearer", "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const agent = agents.get(config.expectedAgentId);
  if (!agent || agent.readyState !== WebSocket.OPEN) {
    response.writeHead(503, { "content-type": "application/json", "retry-after": "5" });
    response.end(JSON.stringify({ error: "Private MCP agent is offline" }));
    return;
  }

  readBody(request, config.maxRequestBytes)
    .then((body) => forwardToAgent(request, response, agent, body, service, pathAfterService(url)))
    .catch((error) => {
      const status = error.message === "request body too large" ? 413 : 400;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    });
}

function forwardToAgent(request, response, agent, body, service, pathAndQuery) {
  const requestId = crypto.randomUUID();
  const timeout = setTimeout(() => finishWithError(requestId, 504, "The private MCP agent timed out."), config.requestTimeoutMs);
  pending.set(requestId, { response, timeout, agentId: config.expectedAgentId, started: false });
  response.on("close", () => {
    if (!pending.has(requestId)) return;
    clearPending(requestId);
    send(agent, { type: "cancel", requestId });
  });

  send(agent, {
    type: "proxy_request",
    requestId,
    request: {
      method: request.method || "POST",
      service,
      pathAndQuery,
      headers: filterHeaders(request.headers),
      bodyBase64: body.toString("base64"),
    },
  });
}

function getServiceName(pathname) {
  const match = /^\/tunnel\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(pathname);
  return match?.[1];
}

function pathAfterService(url) {
  const match = /^\/tunnel\/[a-zA-Z0-9_-]+(\/.*)?$/.exec(url.pathname);
  return `${match?.[1] || "/"}${url.search}`;
}

function handleAgentMessage(agentId, message) {
  const state = pending.get(message.requestId);
  if (!state || state.agentId !== agentId) return;

  if (message.type === "proxy_response_start") {
    if (state.started) return;
    state.started = true;
    state.response.writeHead(Number(message.status) || 502, filterHeaders(message.headers || {}));
    return;
  }
  if (message.type === "proxy_response_chunk") {
    if (!state.started) return finishWithError(message.requestId, 502, "Agent sent a response chunk before response headers.");
    state.response.write(Buffer.from(message.chunkBase64 || "", "base64"));
    return;
  }
  if (message.type === "proxy_response_end") {
    const active = clearPending(message.requestId);
    if (!active) return;
    if (!active.started) active.response.writeHead(204);
    active.response.end();
    return;
  }
  if (message.type === "proxy_error") {
    finishWithError(message.requestId, 502, message.message || "The local MCP server returned an error.");
  }
}

function finishWithError(requestId, status, message) {
  const state = clearPending(requestId);
  if (!state || state.response.writableEnded) return;
  if (!state.started) {
    state.response.writeHead(status, { "content-type": "application/json" });
    state.response.end(JSON.stringify({ error: message }));
  } else {
    state.response.destroy(new Error(message));
  }
}

function failRequestsForAgent(agentId, message) {
  for (const [requestId, state] of pending) {
    if (state.agentId === agentId) finishWithError(requestId, 503, message);
  }
}

function clearPending(requestId) {
  const state = pending.get(requestId);
  if (state) {
    pending.delete(requestId);
    clearTimeout(state.timeout);
  }
  return state;
}

function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        request.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function filterHeaders(headers) {
  const blocked = new Set(["authorization", "connection", "host", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => !blocked.has(name.toLowerCase()) && value !== undefined));
}

function hasBearerToken(header, expected) {
  const value = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  const given = Buffer.from(value);
  const target = Buffer.from(expected);
  return given.length === target.length && crypto.timingSafeEqual(given, target);
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
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

server.listen(config.port, config.host, () => {
  console.log(`Relay listening on http://${config.host}:${config.port}`);
});
