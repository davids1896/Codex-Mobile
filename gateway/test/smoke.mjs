import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeImageUrl } from "../public/markdown.js";

const gatewayDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverPath = join(gatewayDir, "server.mjs");
const testRoot = mkdtempSync(join(tmpdir(), "codex-mobile-smoke-"));
const dataDir = join(testRoot, "data");
const historyDir = join(testRoot, "sessions");
const workspaceOne = join(testRoot, "workspace-one");
const workspaceTwo = join(testRoot, "workspace-two");
mkdirSync(dataDir);
mkdirSync(historyDir);
mkdirSync(workspaceOne);
mkdirSync(workspaceTwo);
const imagePath = join(workspaceTwo, "sample.png");
const textPath = join(workspaceTwo, "sample.txt");
const outsideImagePath = join(testRoot, "outside.png");
const fakeCodexLog = join(testRoot, "fake-codex.log");
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
writeFileSync(imagePath, tinyPng);
writeFileSync(outsideImagePath, tinyPng);
writeFileSync(textPath, "not an image");

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitFor(check, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${body.error || response.status}`);
  return { response, body };
}

const fakeCodexScript = join(testRoot, "fake-codex.mjs");
writeFileSync(fakeCodexScript, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const threads = new Map();
let nextThread = 1;
let nextTurn = 1;
let nextItem = 1;

function output(message) {
  process.stdout.write(\`\${JSON.stringify(message)}\\n\`);
}

function record(message) {
  if (process.env.FAKE_CODEX_LOG) {
    appendFileSync(process.env.FAKE_CODEX_LOG, \`\${JSON.stringify(message)}\\n\`);
  }
}

function serializeThread(thread, includeTurns = true) {
  return {
    id: thread.id,
    name: thread.name,
    preview: thread.preview,
    cwd: thread.cwd,
    updatedAt: thread.updatedAt,
    status: { type: thread.turn ? "active" : "idle" },
    turns: includeTurns && thread.turn ? [{
      id: thread.turn.id,
      status: "inProgress",
      items: [],
    }] : [],
  };
}

function completeTurn(thread, status = "completed") {
  if (!thread.turn) return;
  const turn = { id: thread.turn.id, status, items: [] };
  thread.turn = null;
  thread.updatedAt = Math.floor(Date.now() / 1000);
  output({ method: "turn/completed", params: { threadId: thread.id, turn } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const params = message.params || {};
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    output({ id: message.id, result: { serverInfo: { name: "fake-codex", version: "1" } } });
    return;
  }
  if (message.method === "thread/start") {
    const id = \`00000000-0000-4000-8000-\${String(nextThread++).padStart(12, "0")}\`;
    const thread = {
      id,
      name: \`Task \${id}\`,
      preview: \`Task \${id}\`,
      cwd: params.cwd,
      updatedAt: Math.floor(Date.now() / 1000),
      turn: null,
    };
    threads.set(id, thread);
    record({ method: message.method, threadId: id });
    output({ id: message.id, result: { thread: serializeThread(thread) } });
    return;
  }
  if (message.method === "thread/read" || message.method === "thread/resume") {
    const thread = threads.get(params.threadId);
    output({ id: message.id, result: { thread: serializeThread(thread, true) } });
    return;
  }
  if (message.method === "thread/list") {
    const data = [...threads.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .filter((thread) => !params.cwd || thread.cwd === params.cwd)
      .map((thread) => serializeThread(thread, false));
    output({ id: message.id, result: { data, nextCursor: null } });
    return;
  }
  if (message.method === "turn/start") {
    const thread = threads.get(params.threadId);
    thread.turn = { id: \`turn-\${nextTurn++}\` };
    thread.updatedAt = Math.floor(Date.now() / 1000);
    record({ method: message.method, threadId: thread.id, turnId: thread.turn.id });
    output({
      id: message.id,
      result: { turn: { id: thread.turn.id, status: "inProgress", items: [] } },
    });
    output({
      method: "turn/started",
      params: {
        threadId: thread.id,
        turn: { id: thread.turn.id, status: "inProgress", items: [] },
      },
    });
    return;
  }
  if (message.method === "turn/steer") {
    const thread = threads.get(params.threadId);
    const text = (params.input || [])
      .filter((entry) => entry.type === "text")
      .map((entry) => entry.text)
      .join("\\n");
    if (!thread.turn || thread.turn.id !== params.expectedTurnId) {
      output({ id: message.id, error: { message: "active turn mismatch" } });
      return;
    }
    record({
      method: message.method,
      threadId: thread.id,
      expectedTurnId: params.expectedTurnId,
      text,
    });
    output({ id: message.id, result: { turnId: thread.turn.id } });
    if (text.includes("COMPLETE_BACKGROUND")) {
      const itemId = \`agent-\${nextItem++}\`;
      setTimeout(() => {
        output({
          method: "item/completed",
          params: {
            threadId: thread.id,
            turnId: thread.turn?.id,
            completedAtMs: Date.now(),
            item: { id: itemId, type: "agentMessage", text: "Steering accepted" },
          },
        });
        completeTurn(thread);
      }, 250);
    }
    return;
  }
  if (message.method === "turn/interrupt") {
    const thread = threads.get(params.threadId);
    output({ id: message.id, result: {} });
    completeTurn(thread, "interrupted");
    return;
  }
  output({ id: message.id, error: { message: \`unsupported method: \${message.method}\` } });
});
`);
chmodSync(fakeCodexScript, 0o755);
const fakeCodexCommand = process.platform === "win32"
  ? join(testRoot, "fake-codex.cmd")
  : fakeCodexScript;
if (process.platform === "win32") {
  writeFileSync(
    fakeCodexCommand,
    `@echo off\r\n"${process.execPath}" "${fakeCodexScript}" %*\r\n`,
  );
}

const port = await availablePort();
const configPath = join(testRoot, "config.json");
const codexPath = process.env.CODEX_MOBILE_SMOKE_CODEX_PATH || fakeCodexCommand;
writeFileSync(configPath, JSON.stringify({
  port,
  workspace: workspaceOne,
  workspaces: [
    { id: "one", name: "Workspace One", path: workspaceOne },
    { id: "two", name: "Workspace Two", path: workspaceTwo },
  ],
  host: {
    id: "local",
    name: "Local Test",
    url: `http://127.0.0.1:${port}`,
    editorUrl: "https://local.example.ts.net:8443",
  },
  hosts: [
    {
      id: "local",
      name: "Local Test",
      url: `http://127.0.0.1:${port}`,
      editorUrl: "https://local.example.ts.net:8443",
    },
    {
      id: "other",
      name: "Other Test",
      url: "https://other.example.ts.net",
      editorUrl: "https://other.example.ts.net:8443",
    },
  ],
  codexPath,
  defaultPermissionMode: "full",
  maxUploadBytes: 1024 * 1024,
  maxAttachments: 2,
}, null, 2));

let gateway;
let gatewayOutput = "";

function startGateway() {
  gateway = spawn(process.execPath, [serverPath], {
    cwd: gatewayDir,
    env: {
      ...process.env,
      CODEX_MOBILE_CONFIG: configPath,
      CODEX_MOBILE_DATA_DIR: dataDir,
      CODEX_MOBILE_HISTORY_DIR: historyDir,
      CODEX_PATH: codexPath,
      FAKE_CODEX_LOG: fakeCodexLog,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  gateway.stdout.on("data", (chunk) => {
    gatewayOutput += chunk;
  });
  gateway.stderr.on("data", (chunk) => {
    gatewayOutput += chunk;
  });
}

async function stopGateway() {
  if (!gateway || gateway.exitCode !== null) return;
  gateway.kill();
  await Promise.race([
    new Promise((resolveExit) => gateway.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  if (gateway.exitCode === null) {
    gateway.kill("SIGKILL");
    await Promise.race([
      new Promise((resolveExit) => gateway.once("exit", resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
  }
}

try {
  startGateway();
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${baseUrl}/`)).ok, "gateway startup");
  const homepageResponse = await fetch(`${baseUrl}/`);
  const homepage = await homepageResponse.text();
  if (homepageResponse.headers.get("cache-control") !== "no-cache") {
    throw new Error("homepage must revalidate instead of serving stale UI");
  }
  if (!homepage.includes('id="editor-button"')) {
    throw new Error("homepage omitted the code-server navigation button");
  }
  if (
    !homepage.includes('id="notification-button"') ||
    !homepage.includes('id="scroll-bottom-button"')
  ) {
    throw new Error("homepage omitted notification or scroll controls");
  }
  const serviceWorker = await (await fetch(`${baseUrl}/sw.js`)).text();
  if (!serviceWorker.includes('addEventListener("push"')) {
    throw new Error("service worker omitted Web Push handling");
  }

  const publicConfig = (await request(baseUrl, "/api/public-config")).body;
  if (publicConfig.host.id !== "local" || publicConfig.hosts.length !== 2) {
    throw new Error("public host directory is incorrect");
  }
  if (publicConfig.host.editorUrl !== "https://local.example.ts.net:8443") {
    throw new Error("public editor URL is incorrect");
  }

  const pairingCode = readFileSync(join(dataDir, "pairing-code.txt"), "utf8").trim();
  const login = await request(baseUrl, "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: pairingCode }),
  });
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("login did not return a session cookie");
  const authenticatedHeaders = {
    Cookie: cookie,
    "Content-Type": "application/json",
  };

  const initial = (await request(baseUrl, "/api/state", {
    headers: authenticatedHeaders,
  })).body;
  if (initial.workspaceId !== "one") throw new Error("initial workspace is incorrect");
  if (initial.permissionMode !== "full") {
    throw new Error("initial permission mode did not default to full access");
  }

  const workspacePermission = (await request(baseUrl, "/api/permission", {
    method: "POST",
    headers: authenticatedHeaders,
    body: JSON.stringify({ mode: "workspace" }),
  })).body;
  if (workspacePermission.permissionMode !== "workspace") {
    throw new Error("permission mode switch failed");
  }

  const switched = (await request(baseUrl, "/api/workspace", {
    method: "POST",
    headers: authenticatedHeaders,
    body: JSON.stringify({ workspaceId: "two" }),
  })).body;
  if (switched.workspaceId !== "two" || switched.workspace !== workspaceTwo) {
    throw new Error("workspace switch did not update state");
  }
  if (switched.permissionMode !== "full") {
    throw new Error("workspace switch did not restore the default full access mode");
  }
  if (readFileSync(join(dataDir, "active-workspace.txt"), "utf8").trim() !== "two") {
    throw new Error("workspace selection was not persisted");
  }

  const unauthenticatedImage = await fetch(
    `${baseUrl}/api/local-file?path=${encodeURIComponent(imagePath)}`,
  );
  if (unauthenticatedImage.status !== 401) {
    throw new Error("local image route did not require authentication");
  }
  const validImage = await fetch(
    `${baseUrl}/api/local-file?path=${encodeURIComponent(imagePath)}`,
    { headers: authenticatedHeaders },
  );
  if (!validImage.ok || validImage.headers.get("content-type") !== "image/png") {
    throw new Error("allowed local image was not served");
  }
  const textResponse = await fetch(
    `${baseUrl}/api/local-file?path=${encodeURIComponent(textPath)}`,
    { headers: authenticatedHeaders },
  );
  if (textResponse.status !== 415) throw new Error("non-image local file was not rejected");
  const outsideResponse = await fetch(
    `${baseUrl}/api/local-file?path=${encodeURIComponent(outsideImagePath)}`,
    { headers: authenticatedHeaders },
  );
  if (outsideResponse.status !== 403) throw new Error("outside-root image was not rejected");

  const notifications = (await request(baseUrl, "/api/notifications", {
    headers: authenticatedHeaders,
  })).body;
  if (!notifications.publicKey || notifications.subscriptionCount !== 0) {
    throw new Error("notification configuration is invalid");
  }
  const fakeSubscription = {
    endpoint: "https://push.example.test/codex-mobile-smoke",
    expirationTime: null,
    keys: {
      p256dh: "test-p256dh",
      auth: "test-auth",
    },
  };
  await request(baseUrl, "/api/notifications/subscribe", {
    method: "POST",
    headers: authenticatedHeaders,
    body: JSON.stringify({ subscription: fakeSubscription }),
  });
  const subscribed = (await request(baseUrl, "/api/notifications", {
    headers: authenticatedHeaders,
  })).body;
  if (subscribed.subscriptionCount !== 1) {
    throw new Error("push subscription was not persisted");
  }
  await request(baseUrl, "/api/notifications/subscribe", {
    method: "DELETE",
    headers: authenticatedHeaders,
    body: JSON.stringify({ endpoint: fakeSubscription.endpoint }),
  });
  const unsubscribed = (await request(baseUrl, "/api/notifications", {
    headers: authenticatedHeaders,
  })).body;
  if (unsubscribed.subscriptionCount !== 0) {
    throw new Error("push subscription was not removed");
  }

  await waitFor(async () => {
    const state = (await request(baseUrl, "/api/state", {
      headers: authenticatedHeaders,
    })).body;
    if (state.lastError) throw new Error(state.lastError);
    return state.connected && state;
  }, "Codex app-server connection", 30_000);

  const thread = (await request(baseUrl, "/api/thread/new", {
    method: "POST",
    headers: authenticatedHeaders,
    body: "{}",
  })).body;
  if (!thread.threadId || thread.workspaceId !== "two") {
    throw new Error("new thread did not use the active workspace");
  }
  const firstThreadId = thread.threadId;
  await request(baseUrl, "/api/send", {
    method: "POST",
    headers: authenticatedHeaders,
    body: JSON.stringify({ text: "FIRST_HOLD", attachments: [] }),
  });
  await waitFor(async () => {
    const current = (await request(baseUrl, "/api/state", {
      headers: authenticatedHeaders,
    })).body;
    return current.threadId === firstThreadId &&
      current.busy &&
      current.turnId &&
      current.runningTaskCount === 1 &&
      current;
  }, "first task start");

  const secondThread = (await request(baseUrl, "/api/thread/new", {
    method: "POST",
    headers: authenticatedHeaders,
    body: "{}",
  })).body;
  if (secondThread.threadId === firstThreadId || secondThread.busy) {
    throw new Error("new task did not open independently of the running task");
  }
  if (secondThread.runningTaskCount !== 1) {
    throw new Error("background task count was lost while creating another task");
  }
  const secondThreadId = secondThread.threadId;
  await request(baseUrl, "/api/send", {
    method: "POST",
    headers: authenticatedHeaders,
    body: JSON.stringify({ text: "SECOND_HOLD", attachments: [] }),
  });
  await waitFor(async () => {
    const current = (await request(baseUrl, "/api/state", {
      headers: authenticatedHeaders,
    })).body;
    return current.threadId === secondThreadId &&
      current.busy &&
      current.runningTaskCount === 2 &&
      current;
  }, "second task start");

  const resumedFirst = (await request(baseUrl, "/api/thread/resume", {
    method: "POST",
    headers: authenticatedHeaders,
    body: JSON.stringify({ threadId: firstThreadId }),
  })).body;
  if (!resumedFirst.busy || resumedFirst.runningTaskCount !== 2) {
    throw new Error("switching tasks interrupted a running turn");
  }
  await request(baseUrl, "/api/send", {
    method: "POST",
    headers: authenticatedHeaders,
    body: JSON.stringify({ text: "COMPLETE_BACKGROUND", attachments: [] }),
  });
  const switchedToSecond = (await request(baseUrl, "/api/thread/resume", {
    method: "POST",
    headers: authenticatedHeaders,
    body: JSON.stringify({ threadId: secondThreadId }),
  })).body;
  if (!switchedToSecond.busy || switchedToSecond.runningTaskCount !== 2) {
    throw new Error("running task switch did not preserve both active turns");
  }
  let backgroundCompletionState;
  try {
    await waitFor(async () => {
      const current = (await request(baseUrl, "/api/state", {
        headers: authenticatedHeaders,
      })).body;
      backgroundCompletionState = current;
      return current.threadId === secondThreadId &&
        current.busy &&
        current.runningTaskCount === 1 &&
        current;
    }, "background task completion");
  } catch (error) {
    throw new Error(`${error.message}; last state: ${JSON.stringify(backgroundCompletionState)}`);
  }

  const fakeCodexCalls = readFileSync(fakeCodexLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const steeringCall = fakeCodexCalls.find((entry) =>
    entry.method === "turn/steer" && entry.threadId === firstThreadId);
  if (!steeringCall?.expectedTurnId || !steeringCall.text.includes("COMPLETE_BACKGROUND")) {
    throw new Error("running task guidance did not use turn/steer");
  }

  const directories = (await request(baseUrl, "/api/directories", {
    headers: authenticatedHeaders,
  })).body;
  if (!directories.workspaces.some((entry) => entry.path === workspaceTwo)) {
    throw new Error("thread directory discovery omitted the active workspace");
  }
  const listed = (await request(baseUrl, "/api/threads", {
    headers: authenticatedHeaders,
  })).body;
  if (!Array.isArray(listed.threads) || !Array.isArray(listed.workspaces)) {
    throw new Error("global task listing shape is incorrect");
  }
  if (listed.threads.some((entry) => !entry.cwd)) {
    throw new Error("task listing omitted cwd metadata");
  }
  if (!listed.threads.some((entry) =>
    entry.id === secondThreadId && entry.gatewayBusy === true)) {
    throw new Error("task listing did not identify the running background-capable task");
  }
  const searchableThread = listed.threads[0];
  if (!searchableThread) throw new Error("task listing was empty");
  writeFileSync(
    join(historyDir, `rollout-test-${searchableThread.id}.jsonl`),
    `${JSON.stringify({
      type: "session_meta",
      payload: { id: searchableThread.id, cwd: searchableThread.cwd },
    })}\n${JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "DEPTH-CAMERA-ONLY-IN-BODY" }],
      },
    })}\n`,
  );
  const searched = (await request(baseUrl, "/api/threads?query=depth-camera-only-in-body", {
    headers: authenticatedHeaders,
  })).body;
  if (!searched.threads.some((entry) => entry.id === searchableThread.id)) {
    throw new Error("full-text task search omitted a message-body match");
  }

  if (!safeImageUrl("/home/example/image.png").startsWith("/api/local-file?path=")) {
    throw new Error("Linux Markdown image path was not rewritten");
  }
  if (safeImageUrl("javascript:alert(1)") !== "") {
    throw new Error("unsafe Markdown image protocol was accepted");
  }

  await request(baseUrl, "/api/interrupt", {
    method: "POST",
    headers: authenticatedHeaders,
    body: "{}",
  });
  await waitFor(async () => {
    const current = (await request(baseUrl, "/api/state", {
      headers: authenticatedHeaders,
    })).body;
    return current.runningTaskCount === 0 && current;
  }, "test task cleanup");

  console.log(JSON.stringify({
    ok: true,
    hostCount: publicConfig.hosts.length,
    workspaceCount: initial.workspaces.length,
    activeWorkspace: switched.workspaceId,
    activePath: basename(switched.workspace),
    codexConnected: true,
    threadCreated: true,
    concurrentTasks: true,
    backgroundCompletion: true,
    turnSteering: true,
    fullTextSearch: true,
    editorNavigation: true,
    defaultFullAccess: true,
    webPushSubscriptions: true,
    scrollToBottomControl: true,
    localImageProtected: true,
    discoveredWorkspaceCount: directories.workspaces.length,
    listedThreadCount: listed.threads.length,
  }, null, 2));
} catch (error) {
  console.error(gatewayOutput.trim());
  throw error;
} finally {
  await stopGateway();
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
