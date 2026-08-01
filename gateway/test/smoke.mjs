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

const gatewayDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverPath = join(gatewayDir, "server.mjs");
const testRoot = mkdtempSync(join(tmpdir(), "codex-mobile-smoke-"));
const dataDir = join(testRoot, "data");
const workspaceOne = join(testRoot, "workspace-one");
const workspaceTwo = join(testRoot, "workspace-two");
mkdirSync(dataDir);
mkdirSync(workspaceOne);
mkdirSync(workspaceTwo);

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
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
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

  console.log(JSON.stringify({
    ok: true,
    hostCount: publicConfig.hosts.length,
    workspaceCount: initial.workspaces.length,
    activeWorkspace: switched.workspaceId,
    activePath: basename(switched.workspace),
    codexConnected: true,
    threadCreated: true,
  }, null, 2));
} catch (error) {
  console.error(gatewayOutput.trim());
  throw error;
} finally {
  await stopGateway();
  rmSync(testRoot, { recursive: true, force: true });
}
