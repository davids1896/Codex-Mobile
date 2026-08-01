import { spawn } from "node:child_process";
import {
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
const workspaceOne = join(testRoot, "workspace-one");
const workspaceTwo = join(testRoot, "workspace-two");
mkdirSync(dataDir);
mkdirSync(workspaceOne);
mkdirSync(workspaceTwo);
const imagePath = join(workspaceTwo, "sample.png");
const textPath = join(workspaceTwo, "sample.txt");
const outsideImagePath = join(testRoot, "outside.png");
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

const port = await availablePort();
const configPath = join(testRoot, "config.json");
const codexPath = process.env.CODEX_PATH || (process.platform === "win32" ? "codex.cmd" : "codex");
writeFileSync(configPath, JSON.stringify({
  port,
  workspace: workspaceOne,
  workspaces: [
    { id: "one", name: "Workspace One", path: workspaceOne },
    { id: "two", name: "Workspace Two", path: workspaceTwo },
  ],
  host: { id: "local", name: "Local Test", url: `http://127.0.0.1:${port}` },
  hosts: [
    { id: "local", name: "Local Test", url: `http://127.0.0.1:${port}` },
    { id: "other", name: "Other Test", url: "https://other.example.ts.net" },
  ],
  codexPath,
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

  const publicConfig = (await request(baseUrl, "/api/public-config")).body;
  if (publicConfig.host.id !== "local" || publicConfig.hosts.length !== 2) {
    throw new Error("public host directory is incorrect");
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

  const switched = (await request(baseUrl, "/api/workspace", {
    method: "POST",
    headers: authenticatedHeaders,
    body: JSON.stringify({ workspaceId: "two" }),
  })).body;
  if (switched.workspaceId !== "two" || switched.workspace !== workspaceTwo) {
    throw new Error("workspace switch did not update state");
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

  if (!safeImageUrl("/home/example/image.png").startsWith("/api/local-file?path=")) {
    throw new Error("Linux Markdown image path was not rewritten");
  }
  if (safeImageUrl("javascript:alert(1)") !== "") {
    throw new Error("unsafe Markdown image protocol was accepted");
  }

  console.log(JSON.stringify({
    ok: true,
    hostCount: publicConfig.hosts.length,
    workspaceCount: initial.workspaces.length,
    activeWorkspace: switched.workspaceId,
    activePath: basename(switched.workspace),
    codexConnected: true,
    threadCreated: true,
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
