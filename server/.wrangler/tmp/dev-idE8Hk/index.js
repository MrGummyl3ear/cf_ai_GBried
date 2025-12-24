var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
import { DurableObject } from "cloudflare:workers";

// src/workflow.ts
import { WorkflowEntrypoint } from "cloudflare:workers";
function localAnalyze(transcript) {
  const texts = transcript.map((t) => t.text.trim()).filter(Boolean);
  const joined = texts.join(" ");
  const sentences = joined.split(/\.\s+/).filter(Boolean);
  const summary = sentences.slice(0, 2).join(". ") || joined.slice(0, 200) || "No content";
  const actionCandidates = texts.flatMap((t) => t.split(/\.|\n/)).map((s) => s.trim()).filter(Boolean);
  const action_items = actionCandidates.filter((s) => /^(do|please|action|follow|assign|create|update|add)\b/i.test(s)).slice(0, 5);
  while (action_items.length < 3 && actionCandidates.length) {
    const next = actionCandidates.shift();
    if (next && !action_items.includes(next)) action_items.push(next);
  }
  return { action_items, summary };
}
__name(localAnalyze, "localAnalyze");
var MeetingWorkflow = class extends WorkflowEntrypoint {
  static {
    __name(this, "MeetingWorkflow");
  }
  async run(event, step) {
    const { transcript, roomId, hostName } = event.params;
    const summaryResponse = await step.do("analyze-transcript", async () => {
      if (this.env.AI && typeof this.env.AI.run === "function") {
        const messages = [
          {
            role: "system",
            content: 'You are a helpful assistant. Analyze the following meeting transcript. Return a JSON object with two keys: "action_items" (an array of strings) and "summary" (a short paragraph). Do not include markdown formatting.'
          },
          {
            role: "user",
            content: JSON.stringify(transcript)
          }
        ];
        const response = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
          messages,
          response_format: { type: "json_object" }
        });
        return response;
      }
      return localAnalyze(transcript);
    });
    await step.do("save-to-db", async () => {
      if (this.env.DB && typeof this.env.DB.prepare === "function") {
        await this.env.DB.prepare(
          "INSERT INTO meetings (id, host_name, summary) VALUES (?, ?, ?)"
        ).bind(roomId, hostName, JSON.stringify(summaryResponse)).run();
      } else {
        console.log("Meeting saved (local fallback):", { id: roomId, hostName, summary: summaryResponse });
      }
    });
    return summaryResponse;
  }
};

// src/index.ts
var MeetingRoom = class extends DurableObject {
  static {
    __name(this, "MeetingRoom");
  }
  state;
  env;
  sessions;
  transcript;
  password;
  hostName;
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.sessions = /* @__PURE__ */ new Map();
    this.transcript = [];
    this.password = "";
    this.hostName = "";
    this.state.blockConcurrencyWhile(async () => {
      const storedMeta = await this.state.storage.get("meta");
      if (storedMeta) {
        this.password = storedMeta.password;
        this.hostName = storedMeta.hostName;
      }
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/init" && request.method === "POST") {
      const body = await request.json();
      this.password = body.password;
      this.hostName = body.hostName;
      await this.state.storage.put("meta", body);
      return new Response("Initialized");
    }
    if (url.pathname === "/check-auth" && request.method === "POST") {
      const body = await request.json();
      if (body.password === this.password) {
        return new Response("OK", { status: 200 });
      }
      return new Response("Unauthorized", { status: 401 });
    }
    if (request.headers.get("Upgrade") === "websocket") {
      const tokenStr = url.searchParams.get("token");
      if (!tokenStr) return new Response("Missing token", { status: 400 });
      const user = JSON.parse(tokenStr);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      this.sessions.set(server, { name: user.name, role: user.role });
      this.broadcast({
        type: "USER_JOINED",
        data: { name: user.name, totalUsers: this.sessions.size }
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not Found", { status: 404 });
  }
  async webSocketMessage(ws, message) {
    const data = JSON.parse(message);
    const user = this.sessions.get(ws);
    if (!user) return;
    if (data.type === "SEND_TRANSCRIPT") {
      const entry = {
        sender: user.name,
        text: data.payload.text,
        timestamp: Date.now()
      };
      this.transcript.push(entry);
      this.broadcast({
        type: "NEW_MESSAGE",
        data: entry
      });
    }
    if (data.type === "END_SESSION" && user.role === "HOST") {
      this.broadcast({ type: "MEETING_ENDED" });
      await this.env.PROCESS_MEETING_WORKFLOW.create({
        params: {
          transcript: this.transcript,
          roomId: this.state.id.toString(),
          hostName: this.hostName
        }
      });
    }
  }
  async webSocketClose(ws, code, reason, wasClean) {
    const user = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (user) {
      this.broadcast({
        type: "USER_LEFT",
        data: { name: user.name, totalUsers: this.sessions.size }
      });
    }
  }
  broadcast(message) {
    const msg = JSON.stringify(message);
    for (const session of this.sessions.keys()) {
      try {
        session.send(msg);
      } catch (err) {
        this.sessions.delete(session);
      }
    }
  }
};
var src_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/api/create-room" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const password = body.password || "";
      const hostName = body.hostName || "";
      const roomId = globalThis.crypto && typeof globalThis.crypto.randomUUID === "function" ? globalThis.crypto.randomUUID().split("-")[0] : Math.random().toString(36).slice(2, 9);
      const id = env.MEETING_ROOM.idFromName(roomId);
      const obj = env.MEETING_ROOM.get(id);
      const initReq = new Request(`https://init.local/room/${roomId}/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, hostName })
      });
      await obj.fetch(initReq);
      return new Response(JSON.stringify({ roomId }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.pathname === "/api/join-room" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { roomId, name, password } = body;
      if (!roomId || !name) {
        return new Response(JSON.stringify({ error: "missing parameters" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const id = env.MEETING_ROOM.idFromName(roomId);
      const obj = env.MEETING_ROOM.get(id);
      if (password !== void 0) {
        const authReq = new Request(`https://check.local/room/${roomId}/check-auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password })
        });
        const authRes = await obj.fetch(authReq);
        if (authRes.status !== 200) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
        }
      }
      const token = encodeURIComponent(JSON.stringify({ name, role }));
      const wsUrl = `ws://127.0.0.1:8787/room/${roomId}?token=${token}`;
      return new Response(JSON.stringify({ token, wsUrl }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (parts[0] === "room" && parts[1]) {
      const roomId = parts[1];
      const remaining = parts.slice(2);
      url.pathname = remaining.length ? `/${remaining.join("/")}` : "/";
      const forward = new Request(url.toString(), request);
      const id = env.MEETING_ROOM.idFromName(roomId);
      const obj = env.MEETING_ROOM.get(id);
      return obj.fetch(forward);
    }
    return new Response("Not Found", { status: 404 });
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-4WS3FX/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-4WS3FX/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  MeetingRoom,
  MeetingWorkflow,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
