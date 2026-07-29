import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const configPath = process.env.CODEX_MOBILE_CONFIG || join(root, "config.json");
const config = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
if (!config.workspace || !isAbsolute(config.workspace)) {
  throw new Error(`config.workspace must be an absolute path (${configPath})`);
}
if (!existsSync(config.workspace)) {
  throw new Error(`Configured workspace does not exist: ${config.workspace}`);
}
const defaultDataDir =
  process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || process.env.ProgramData || "C:\\ProgramData", "CodexMobilePwa", "data")
    : join(homedir(), ".config", "codex-mobile-pwa");
const dataDir =
  process.env.CODEX_MOBILE_DATA_DIR ||
  defaultDataDir;
const logFile = join(dataDir, "gateway.log");
const uploadDir = join(dataDir, "uploads");
const maxUploadBytes = Number(config.maxUploadBytes) || 25 * 1024 * 1024;
const maxAttachments = Number(config.maxAttachments) || 8;
mkdirSync(dataDir, { recursive: true });
mkdirSync(uploadDir, { recursive: true });

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function ensureFile(name, create) {
  const file = join(dataDir, name);
  if (!existsSync(file)) writeFileSync(file, create(), { encoding: "utf8", mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

const pairingCode = ensureFile("pairing-code.txt", () =>
  randomBytes(9).toString("base64url").toUpperCase(),
);
const cookieSecret = ensureFile("cookie-secret.txt", () => randomBytes(32).toString("hex"));

function log(message) {
  appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

async function bodyJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 256_000) throw new HttpError(413, "Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

async function bodyBuffer(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `File exceeds ${Math.floor(limit / 1024 / 1024)} MB`);
    chunks.push(chunk);
  }
  if (!size) throw new HttpError(400, "File is empty");
  return Buffer.concat(chunks, size);
}

function safeOriginalName(value) {
  const cleaned = basename(String(value || "attachment"))
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .trim()
    .slice(0, 160);
  return cleaned || "attachment";
}

function safeExtension(name) {
  const extension = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
}

const imageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const imageTypeByExtension = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function saveUpload(name, contentType, data) {
  const originalName = safeOriginalName(name);
  const extension = safeExtension(originalName);
  const id = randomBytes(16).toString("hex");
  const storedName = `${id}${extension}`;
  const normalizedType = String(contentType || "").split(";")[0].trim().toLowerCase();
  const type = normalizedType || imageTypeByExtension[extension] || "application/octet-stream";
  const metadata = {
    id,
    name: originalName,
    storedName,
    size: data.length,
    type,
    isImage: imageTypes.has(type) || Boolean(imageTypeByExtension[extension]),
    createdAt: Date.now(),
  };
  writeFileSync(join(uploadDir, storedName), data, { mode: 0o600 });
  writeFileSync(join(uploadDir, `${id}.meta.json`), JSON.stringify(metadata), {
    encoding: "utf8",
    mode: 0o600,
  });
  return metadata;
}

function getUpload(id) {
  const normalizedId = String(id || "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalizedId)) {
    throw new HttpError(400, "Invalid attachment id");
  }
  const metadataPath = join(uploadDir, `${normalizedId}.meta.json`);
  if (!existsSync(metadataPath)) throw new HttpError(404, "Attachment not found");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const file = resolve(uploadDir, metadata.storedName);
  const fromUploadDir = relative(uploadDir, file);
  if (fromUploadDir.startsWith("..") || isAbsolute(fromUploadDir) || !existsSync(file)) {
    throw new HttpError(404, "Attachment file is unavailable");
  }
  return { ...metadata, file, url: `/api/uploads/${metadata.id}` };
}

function sign(value) {
  return createHmac("sha256", cookieSecret).update(value).digest("base64url");
}

function makeSession() {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function authenticated(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)codex_mobile_session=([^;]+)/);
  if (!match) return false;
  const [payload, signature] = decodeURIComponent(match[1]).split(".");
  if (!payload || !signature) return false;
  const expected = sign(payload);
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) return false;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp > Date.now();
  } catch {
    return false;
  }
}

class CodexBridge {
  constructor() {
    this.child = null;
    this.ready = null;
    this.nextId = 1;
    this.pendingRpc = new Map();
    this.pendingActions = new Map();
    this.clients = new Set();
    this.state = {
      connected: false,
      workspace: config.workspace,
      limits: { maxAttachments, maxUploadBytes },
      permissionMode: "workspace",
      threadId: null,
      threadTitle: "New task",
      busy: false,
      turnId: null,
      messages: [],
      pendingActions: [],
      lastError: null,
    };
  }

  snapshot() {
    return { ...this.state, pendingActions: [...this.pendingActions.values()] };
  }

  publish() {
    const payload = `event: state\ndata: ${JSON.stringify(this.snapshot())}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  send(message) {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server is unavailable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pendingRpc.set(id, { resolve, reject, timer });
      this.send({ method, id, params });
    });
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const codexPath =
        process.env.CODEX_PATH ||
        config.codexPath ||
        (process.platform === "win32"
          ? "codex.cmd"
          : "codex");
      this.child =
        process.platform === "win32"
          ? spawn(`"${codexPath}" app-server --stdio`, {
              cwd: root,
              shell: true,
              windowsHide: true,
              stdio: ["pipe", "pipe", "pipe"],
            })
          : spawn(codexPath, ["app-server", "--stdio"], {
              cwd: root,
              stdio: ["pipe", "pipe", "pipe"],
            });
      this.child.once("error", reject);
      this.child.once("exit", (code) => {
        for (const pending of this.pendingRpc.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Codex app-server exited (${code})`));
        }
        this.pendingRpc.clear();
        this.state.connected = false;
        this.state.busy = false;
        this.state.turnId = null;
        this.state.lastError = `Codex app-server exited (${code})`;
        this.ready = null;
        this.publish();
      });
      readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
        if (!line.trim()) return;
        try {
          this.handle(JSON.parse(line));
        } catch (error) {
          log(`invalid app-server output: ${error.message}`);
        }
      });
      this.child.stderr.on("data", (chunk) => log(chunk.toString().trim()));
      this.request("initialize", {
        clientInfo: {
          name: "codex-mobile-pwa",
          title: "Codex Mobile",
          version: "0.2.0",
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }).then((result) => {
        this.send({ method: "initialized" });
        this.state.connected = true;
        this.state.lastError = null;
        this.publish();
        resolve(result);
      }, (error) => {
        this.ready = null;
        reject(error);
      });
    });
    return this.ready;
  }

  handle(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pendingRpc.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRpc.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "RPC error"));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      const action = {
        requestId: message.id,
        method: message.method,
        params: message.params,
      };
      this.pendingActions.set(String(message.id), action);
      this.publish();
      return;
    }

    const params = message.params || {};
    if (message.method === "turn/started") {
      this.state.busy = true;
      this.state.turnId = params.turn?.id || null;
    } else if (message.method === "item/agentMessage/delta") {
      let item = this.state.messages.find((entry) => entry.id === params.itemId);
      if (!item) {
        item = { id: params.itemId, role: "assistant", text: "" };
        this.state.messages.push(item);
      }
      item.text += params.delta;
    } else if (message.method === "item/started") {
      const item = params.item;
      if (item?.type === "commandExecution") {
        this.state.messages.push({
          id: item.id,
          role: "activity",
          text: `$ ${item.command}`,
          status: item.status,
        });
      }
    } else if (message.method === "item/completed") {
      const item = params.item;
      if (item?.type === "agentMessage") {
        const existing = this.state.messages.find((entry) => entry.id === item.id);
        if (existing) existing.text = item.text;
        else this.state.messages.push({ id: item.id, role: "assistant", text: item.text });
      } else if (item?.type === "commandExecution") {
        const existing = this.state.messages.find((entry) => entry.id === item.id);
        if (existing) {
          existing.status = item.status;
          if (item.aggregatedOutput) existing.output = item.aggregatedOutput.slice(-4000);
        }
      } else if (item?.type === "fileChange") {
        this.state.messages.push({
          id: item.id,
          role: "activity",
          text: `File changes: ${item.changes.length}`,
          status: item.status,
        });
      }
    } else if (message.method === "turn/completed") {
      this.state.busy = false;
      this.state.turnId = null;
    } else if (message.method === "error") {
      this.state.lastError = params.error?.message || "Codex turn failed";
      this.state.busy = Boolean(params.willRetry);
    } else if (message.method === "warning") {
      this.state.lastError = params.message || "Codex warning";
    }
    this.publish();
  }

  loadMessages(thread) {
    const messages = [];
    for (const turn of thread.turns || []) {
      for (const item of turn.items || []) {
        if (item.type === "userMessage") {
          const text = item.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          const images = item.content
            .filter((part) => part.type === "localImage" || part.type === "image")
            .map((part, index) => ({
              id: `${item.id}-image-${index}`,
              name: `图片 ${index + 1}`,
              isImage: true,
              url: part.path || part.url || "",
            }));
          if (text || images.length) {
            messages.push({ id: item.id, role: "user", text, attachments: images });
          }
        } else if (item.type === "agentMessage") {
          messages.push({ id: item.id, role: "assistant", text: item.text });
        } else if (item.type === "commandExecution") {
          messages.push({
            id: item.id,
            role: "activity",
            text: `$ ${item.command}`,
            status: item.status,
            output: item.aggregatedOutput?.slice(-4000),
          });
        } else if (item.type === "fileChange") {
          messages.push({
            id: item.id,
            role: "activity",
            text: `File changes: ${item.changes.length}`,
            status: item.status,
          });
        }
      }
    }
    return messages;
  }

  permissionParams(forTurn = false) {
    if (this.state.permissionMode === "full") {
      return forTurn
        ? {
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "dangerFullAccess" },
          }
        : {
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: "danger-full-access",
          };
    }
    return forTurn
      ? {
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [config.workspace],
            networkAccess: false,
          },
        }
      : {
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
        };
  }

  setPermissionMode(mode) {
    if (!["workspace", "full"].includes(mode)) {
      throw new HttpError(400, "Unknown permission mode");
    }
    if (this.state.busy) {
      throw new HttpError(409, "Wait for the current turn to finish before changing permissions");
    }
    this.state.permissionMode = mode;
    this.state.lastError = null;
    this.publish();
    return this.snapshot();
  }

  async newThread() {
    await this.start();
    const result = await this.request("thread/start", {
      cwd: config.workspace,
      ...this.permissionParams(),
      ephemeral: false,
    });
    this.state.threadId = result.thread.id;
    this.state.threadTitle = "New task";
    this.state.messages = [];
    this.state.busy = false;
    this.state.lastError = null;
    this.publish();
    return this.snapshot();
  }

  async resume(threadId) {
    await this.start();
    const result = await this.request("thread/resume", {
      threadId,
      cwd: config.workspace,
      ...this.permissionParams(),
    });
    this.state.threadId = result.thread.id;
    this.state.threadTitle = result.thread.name || result.thread.preview || "Codex task";
    this.state.messages = this.loadMessages(result.thread);
    this.state.busy = result.thread.status?.type === "active";
    this.state.lastError = null;
    this.publish();
    return this.snapshot();
  }

  async listThreads() {
    await this.start();
    const result = await this.request("thread/list", {
      limit: 30,
      cwd: config.workspace,
      archived: false,
    });
    return result.data.map((thread) => ({
      id: thread.id,
      title: thread.name || thread.preview || "Untitled task",
      updatedAt: thread.updatedAt,
      status: thread.status,
    }));
  }

  async sendMessage(text, attachmentIds = []) {
    await this.start();
    if (!this.state.threadId) await this.newThread();
    if (this.state.busy) throw new Error("A turn is already running");
    if (!Array.isArray(attachmentIds) || attachmentIds.length > maxAttachments) {
      throw new HttpError(400, `A message can include up to ${maxAttachments} attachments`);
    }
    const attachments = attachmentIds.map((id) => getUpload(id));
    const displayText = String(text || "").trim();
    if (!displayText && !attachments.length) throw new HttpError(400, "Message is empty");

    const context = attachments.map((attachment) =>
      attachment.isImage
        ? `- 已附图片 "${attachment.name}"`
        : `- 附件 "${attachment.name}" 位于本机路径：${attachment.file}`,
    );
    const promptText = [
      displayText || "请查看并处理这些附件。",
      context.length
        ? `\n附件信息：\n${context.join("\n")}\n请按需读取附件；不要修改或删除上传原件。`
        : "",
    ].join("");
    const input = [{ type: "text", text: promptText, text_elements: [] }];
    for (const attachment of attachments) {
      if (attachment.isImage) {
        input.push({ type: "localImage", path: attachment.file, detail: "auto" });
      }
    }

    this.state.messages.push({
      id: `user-${Date.now()}`,
      role: "user",
      text: displayText || `已发送 ${attachments.length} 个附件`,
      attachments: attachments.map(({ file, storedName, ...attachment }) => attachment),
    });
    this.state.busy = true;
    this.publish();
    const result = await this.request("turn/start", {
      threadId: this.state.threadId,
      input,
      ...this.permissionParams(true),
    });
    this.state.turnId = result.turn.id;
    this.publish();
  }

  async interrupt() {
    if (!this.state.threadId || !this.state.turnId) return;
    await this.request("turn/interrupt", {
      threadId: this.state.threadId,
      turnId: this.state.turnId,
    });
  }

  answerAction(requestId, body) {
    const action = this.pendingActions.get(String(requestId));
    if (!action) throw new Error("Approval request is no longer active");
    let result;
    if (
      action.method === "item/commandExecution/requestApproval" ||
      action.method === "item/fileChange/requestApproval"
    ) {
      result = { decision: body.decision };
    } else if (action.method === "item/tool/requestUserInput") {
      result = { answers: body.answers || {} };
    } else {
      throw new Error(`Unsupported request: ${action.method}`);
    }
    this.send({ id: action.requestId, result });
    this.pendingActions.delete(String(requestId));
    this.publish();
  }
}

const bridge = new CodexBridge();
bridge.start().catch((error) => {
  bridge.state.lastError = error.message;
  bridge.publish();
  log(error.stack || error.message);
});

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await bodyJson(req);
      if (String(body.code || "").toUpperCase() !== pairingCode) {
        return json(res, 401, { error: "Pairing code is incorrect" });
      }
      res.setHeader(
        "Set-Cookie",
        `codex_mobile_session=${encodeURIComponent(makeSession())}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
      );
      return json(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/api/") && !authenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, 200, bridge.snapshot());
    }
    if (req.method === "POST" && url.pathname === "/api/uploads") {
      const name = url.searchParams.get("name") || "attachment";
      const data = await bodyBuffer(req, maxUploadBytes);
      const metadata = saveUpload(name, req.headers["content-type"], data);
      return json(res, 201, {
        attachment: {
          ...metadata,
          url: `/api/uploads/${metadata.id}`,
        },
      });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/uploads/")) {
      const attachment = getUpload(url.pathname.slice("/api/uploads/".length));
      const disposition = attachment.isImage ? "inline" : "attachment";
      res.writeHead(200, {
        "Content-Type": attachment.isImage ? attachment.type : "application/octet-stream",
        "Content-Length": statSync(attachment.file).size,
        "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
        "Cache-Control": "private, max-age=300",
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
      });
      createReadStream(attachment.file).pipe(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/threads") {
      return json(res, 200, { threads: await bridge.listThreads() });
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      bridge.clients.add(res);
      res.write(`event: state\ndata: ${JSON.stringify(bridge.snapshot())}\n\n`);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        bridge.clients.delete(res);
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/thread/new") {
      return json(res, 200, await bridge.newThread());
    }
    if (req.method === "POST" && url.pathname === "/api/thread/resume") {
      const body = await bodyJson(req);
      return json(res, 200, await bridge.resume(body.threadId));
    }
    if (req.method === "POST" && url.pathname === "/api/permission") {
      const body = await bodyJson(req);
      return json(res, 200, bridge.setPermissionMode(String(body.mode || "")));
    }
    if (req.method === "POST" && url.pathname === "/api/send") {
      const body = await bodyJson(req);
      const text = String(body.text || "").trim();
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      await bridge.sendMessage(text, attachments.map((attachment) => attachment.id));
      return json(res, 202, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/interrupt") {
      await bridge.interrupt();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/action") {
      const body = await bodyJson(req);
      bridge.answerAction(body.requestId, body);
      return json(res, 200, { ok: true });
    }

    const requestedPath = decodeURIComponent(url.pathname);
    const assetPath = requestedPath === "/" ? "index.html" : requestedPath.replace(/^\/+/, "");
    const file = resolve(publicDir, assetPath);
    const pathFromPublic = relative(publicDir, file);
    const isOutsidePublic =
      pathFromPublic.startsWith("..") || isAbsolute(pathFromPublic);
    if (isOutsidePublic || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const data = readFileSync(file);
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] || "application/octet-stream",
      "Cache-Control": assetPath === "sw.js" ? "no-cache" : "public, max-age=300",
      "Content-Length": data.length,
    });
    res.end(data);
  } catch (error) {
    log(error.stack || error.message);
    json(res, error.statusCode || 500, { error: error.message });
  }
});

server.listen(config.port, "127.0.0.1", () => {
  log(`gateway listening on 127.0.0.1:${config.port}`);
  console.log(`Codex Mobile gateway: http://127.0.0.1:${config.port}`);
});
