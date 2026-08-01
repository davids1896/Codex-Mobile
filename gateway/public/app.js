import { renderMarkdown } from "./markdown.js";

const login = document.querySelector("#login");
const app = document.querySelector("#app");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const messages = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const input = document.querySelector("#message");
const sendButton = document.querySelector("#send-button");
const stopButton = document.querySelector("#stop-button");
const attachButton = document.querySelector("#attach-button");
const fileInput = document.querySelector("#file-input");
const attachmentList = document.querySelector("#attachment-list");
const uploadStatus = document.querySelector("#upload-status");
const statusDot = document.querySelector("#status-dot");
const threadTitle = document.querySelector("#thread-title");
const approval = document.querySelector("#approval");
const dialog = document.querySelector("#threads-dialog");
const threadsList = document.querySelector("#threads-list");
const threadSearch = document.querySelector("#thread-search");
const threadDirectory = document.querySelector("#thread-directory");
const threadsMore = document.querySelector("#threads-more");
const hostSelect = document.querySelector("#host-select");
const workspaceSelect = document.querySelector("#workspace-select");
const loginHostControl = document.querySelector("#login-host-control");
const loginHostSelect = document.querySelector("#login-host");
const permissionButtons = [...document.querySelectorAll("[data-permission]")];

let maxAttachments = 8;
let maxUploadBytes = 25 * 1024 * 1024;
let state = null;
let events = null;
let selectedFiles = [];
let uploading = false;
let publicConfig = null;
let threadsCursor = null;
let threadSearchTimer = null;

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fillSelect(select, entries, selectedId, label) {
  const previous = select.value;
  select.replaceChildren(...entries.map((entry) => {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.name || entry.id;
    option.title = entry.path || entry.url || "";
    if (label === "host" && !entry.url && entry.id !== selectedId) option.disabled = true;
    return option;
  }));
  select.value = selectedId || previous;
}

function renderHosts(host, hosts = []) {
  if (!host || !hosts.length) return;
  fillSelect(hostSelect, hosts, host.id, "host");
  fillSelect(loginHostSelect, hosts, host.id, "host");
  loginHostControl.hidden = hosts.length < 2;
}

function renderWorkspaces() {
  const workspaces = state?.workspaces || [];
  if (!workspaces.length) return;
  fillSelect(workspaceSelect, workspaces, state.workspaceId, "workspace");
}

function navigateToHost(select) {
  const config = state || publicConfig;
  const currentHost = config?.host;
  const target = config?.hosts?.find((entry) => entry.id === select.value);
  if (!target || target.id === currentHost?.id) {
    select.value = currentHost?.id || "";
    return;
  }
  if (!target.url) {
    alert("这台主机尚未配置可访问的 Tailnet HTTPS 地址");
    select.value = currentHost?.id || "";
    return;
  }
  if (state?.busy && !confirm("当前任务仍在运行。切换主机后任务会继续在原主机运行，确定离开吗？")) {
    select.value = currentHost?.id || "";
    return;
  }
  window.location.assign(target.url);
}

function localImageUrl(value) {
  const path = String(value || "");
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/")) {
    return `/api/local-file?path=${encodeURIComponent(path)}`;
  }
  return path;
}

function messageAttachments(items = []) {
  if (!items.length) return null;
  const container = document.createElement("div");
  container.className = "message-attachments";
  for (const item of items) {
    const attachment = document.createElement("div");
    attachment.className = "message-attachment";
    if (item.isImage && item.url) {
      const link = document.createElement("a");
      link.href = localImageUrl(item.url);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const image = document.createElement("img");
      image.src = link.href;
      image.alt = item.name || "图片";
      image.loading = "lazy";
      link.append(image);
      attachment.append(link);
    } else {
      const symbol = document.createElement("span");
      symbol.className = "file-symbol";
      symbol.textContent = "FILE";
      symbol.setAttribute("aria-hidden", "true");
      attachment.append(symbol);
    }
    const name = document.createElement("span");
    name.textContent = item.name || "附件";
    attachment.append(name);
    container.append(attachment);
  }
  return container;
}

function renderMessages() {
  messages.replaceChildren();
  if (!state.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.append(
      document.createTextNode(`已连接到 ${state.workspaceName || state.workspace}`),
      document.createElement("br"),
      document.createTextNode(state.workspace),
      document.createElement("br"),
      document.createTextNode("可以发送文字、图片或文件"),
    );
    messages.append(empty);
    return;
  }

  for (const message of state.messages) {
    const article = document.createElement("article");
    article.className = `message ${message.role}`;
    if (message.text) {
      if (message.role === "assistant") {
        article.append(renderMarkdown(message.text));
      } else {
        const text = document.createElement("div");
        text.className = "message-text";
        text.textContent = message.text;
        article.append(text);
      }
    }
    const attachments = messageAttachments(message.attachments);
    if (attachments) article.append(attachments);
    if (message.output) {
      const output = document.createElement("pre");
      output.textContent = message.output;
      article.append(output);
    }
    messages.append(article);
  }
  messages.scrollTop = messages.scrollHeight;
}

function render() {
  if (!state) return;
  statusDot.classList.toggle("online", state.connected);
  threadTitle.textContent = state.threadTitle || "新任务";
  stopButton.hidden = !state.busy;
  input.disabled = state.busy || uploading;
  sendButton.disabled = state.busy || uploading;
  attachButton.disabled = state.busy || uploading;
  workspaceSelect.disabled =
    state.busy || uploading || Boolean(state.pendingActions?.length);
  hostSelect.disabled = uploading;
  renderHosts(state.host, state.hosts);
  renderWorkspaces();
  permissionButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.permission === state.permissionMode);
    button.disabled = state.busy || uploading;
  });

  renderMessages();

  if (state.lastError) {
    messages.insertAdjacentHTML(
      "beforeend",
      `<p class="message error">${escapeHtml(state.lastError)}</p>`,
    );
  }
  renderApproval(state.pendingActions?.[0]);
}

function renderSelectedFiles() {
  attachmentList.hidden = selectedFiles.length === 0;
  attachmentList.innerHTML = selectedFiles.map((entry, index) => {
    const preview = entry.file.type.startsWith("image/")
      ? `<img src="${entry.previewUrl}" alt="">`
      : `<span class="file-symbol" aria-hidden="true">FILE</span>`;
    return `<div class="attachment-item">
      ${preview}
      <span class="attachment-name">${escapeHtml(entry.file.name)}</span>
      <small>${formatSize(entry.file.size)}</small>
      <button type="button" data-remove-file="${index}" title="移除附件" aria-label="移除 ${escapeHtml(entry.file.name)}">&times;</button>
    </div>`;
  }).join("");
  attachmentList.querySelectorAll("[data-remove-file]").forEach((button) => {
    button.onclick = () => {
      const [removed] = selectedFiles.splice(Number(button.dataset.removeFile), 1);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      renderSelectedFiles();
    };
  });
}

function renderApproval(action) {
  if (!action) {
    approval.hidden = true;
    approval.innerHTML = "";
    return;
  }

  approval.hidden = false;
  const params = action.params || {};
  if (action.method === "item/tool/requestUserInput") {
    const questions = params.questions || [];
    approval.innerHTML = `
      <strong>Codex 需要你的回答</strong>
      ${questions.map((question, index) => {
        const options = question.options || [];
        const control = options.length
          ? `<div class="answer-options">${options.map((option) => `
              <label>
                <input type="radio" name="question-${index}" value="${escapeHtml(option.label)}">
                <span><b>${escapeHtml(option.label)}</b><small>${escapeHtml(option.description)}</small></span>
              </label>
            `).join("")}</div>`
          : `<input class="answer-input" ${question.isSecret ? 'type="password"' : 'type="text"'}>`;
        return `
          <fieldset class="answer-question" data-id="${escapeHtml(question.id)}">
            <legend>${escapeHtml(question.question)}</legend>
            ${control}
          </fieldset>`;
      }).join("")}
      <div class="approval-actions">
        <button data-input-submit>提交回答</button>
      </div>`;
    approval.querySelector("[data-input-submit]").onclick = async () => {
      const answers = {};
      approval.querySelectorAll(".answer-question").forEach((question) => {
        const field = question.querySelector(".answer-input");
        const selected = question.querySelector("input[type=radio]:checked");
        answers[question.dataset.id] = { answers: [field?.value || selected?.value || ""] };
      });
      await answerAction(action.requestId, { answers });
    };
    return;
  }

  const detail = params.command || params.reason || action.method;
  approval.innerHTML = `
    <strong>需要审批</strong>
    <pre>${escapeHtml(detail)}</pre>
    <div class="approval-actions">
      <button data-decision="accept">允许一次</button>
      <button data-decision="acceptForSession">本次任务允许</button>
      <button class="deny" data-decision="decline">拒绝</button>
    </div>`;
  approval.querySelectorAll("[data-decision]").forEach((button) => {
    button.onclick = () => answerAction(action.requestId, {
      decision: button.dataset.decision,
    });
  });
}

async function answerAction(requestId, payload) {
  try {
    await api("/api/action", {
      method: "POST",
      body: JSON.stringify({ requestId, ...payload }),
    });
  } catch (error) {
    alert(error.message);
  }
}

function connectEvents() {
  events?.close();
  events = new EventSource("/api/events");
  events.addEventListener("state", (event) => {
    state = JSON.parse(event.data);
    render();
  });
}

async function boot() {
  try {
    publicConfig = await api("/api/public-config");
    renderHosts(publicConfig.host, publicConfig.hosts);
  } catch {
    publicConfig = null;
  }
  try {
    state = await api("/api/state");
    maxAttachments = state.limits?.maxAttachments || maxAttachments;
    maxUploadBytes = state.limits?.maxUploadBytes || maxUploadBytes;
    login.hidden = true;
    app.hidden = false;
    render();
    connectEvents();
  } catch {
    events?.close();
    app.hidden = true;
    login.hidden = false;
  }
}

async function uploadFile(file, index, total) {
  uploadStatus.textContent = `正在上传 ${index + 1}/${total}：${file.name}`;
  const response = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `上传失败 (${response.status})`);
  return body.attachment;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ code: loginForm.code.value.trim() }),
    });
    await boot();
  } catch (error) {
    loginError.textContent = error.message;
  }
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text && !selectedFiles.length) return;

  uploading = true;
  render();
  try {
    const uploaded = [];
    for (let index = 0; index < selectedFiles.length; index += 1) {
      uploaded.push(await uploadFile(selectedFiles[index].file, index, selectedFiles.length));
    }
    uploadStatus.textContent = uploaded.length ? "上传完成，正在交给 Codex" : "";
    await api("/api/send", {
      method: "POST",
      body: JSON.stringify({
        text,
        attachments: uploaded.map((attachment) => ({ id: attachment.id })),
      }),
    });
    input.value = "";
    input.style.height = "";
    selectedFiles.forEach((entry) => URL.revokeObjectURL(entry.previewUrl));
    selectedFiles = [];
    renderSelectedFiles();
    uploadStatus.textContent = "";
  } catch (error) {
    uploadStatus.textContent = "";
    alert(error.message);
  } finally {
    uploading = false;
    render();
  }
});

attachButton.onclick = () => fileInput.click();
fileInput.addEventListener("change", () => {
  const incoming = [...fileInput.files];
  fileInput.value = "";
  for (const file of incoming) {
    if (selectedFiles.length >= maxAttachments) {
      alert(`每条消息最多添加 ${maxAttachments} 个附件`);
      break;
    }
    if (file.size > maxUploadBytes) {
      alert(`${file.name} 超过 ${formatSize(maxUploadBytes)}，未添加`);
      continue;
    }
    selectedFiles.push({
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : "",
    });
  }
  renderSelectedFiles();
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

permissionButtons.forEach((button) => {
  button.onclick = async () => {
    const mode = button.dataset.permission;
    if (mode === state?.permissionMode) return;
    if (mode === "full") {
      const confirmed = confirm(
        "完全访问会允许 Codex 读写整台电脑、运行命令并且不再逐项请求审批。只在你明确需要时启用。确定继续吗？",
      );
      if (!confirmed) return;
    }
    try {
      state = await api("/api/permission", {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
      render();
    } catch (error) {
      alert(error.message);
    }
  };
});

hostSelect.addEventListener("change", () => navigateToHost(hostSelect));
loginHostSelect.addEventListener("change", () => navigateToHost(loginHostSelect));
workspaceSelect.addEventListener("change", async () => {
  const workspaceId = workspaceSelect.value;
  if (!state || workspaceId === state.workspaceId) return;
  const target = state.workspaces?.find((entry) => entry.id === workspaceId);
  const warning = selectedFiles.length
    ? "切换目录会清空当前任务和已选择但尚未发送的附件。确定继续吗？"
    : "切换目录会清空当前任务，并回到工作区权限。确定继续吗？";
  if (!confirm(warning)) {
    workspaceSelect.value = state.workspaceId;
    return;
  }
  try {
    state = await api("/api/workspace", {
      method: "POST",
      body: JSON.stringify({ workspaceId }),
    });
    selectedFiles.forEach((entry) => {
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    });
    selectedFiles = [];
    renderSelectedFiles();
    uploadStatus.textContent = "";
    render();
    input.focus();
  } catch (error) {
    workspaceSelect.value = state.workspaceId;
    alert(`无法切换到 ${target?.name || workspaceId}：${error.message}`);
  }
});

stopButton.onclick = () => api("/api/interrupt", { method: "POST", body: "{}" });
document.querySelector("#new-button").onclick = async () => {
  if (state?.busy && !confirm("当前任务仍在运行，确定新建任务？")) return;
  await api("/api/thread/new", { method: "POST", body: "{}" });
};

function renderThreadDirectories(workspaces = []) {
  const selected = threadDirectory.value;
  const options = [{ path: "", name: "全部目录" }, ...workspaces];
  threadDirectory.replaceChildren(...options.map((workspace) => {
    const option = document.createElement("option");
    option.value = workspace.path || "";
    option.textContent = workspace.path
      ? `${workspace.name || workspace.path} - ${workspace.path}`
      : workspace.name;
    option.title = workspace.path || "";
    return option;
  }));
  threadDirectory.value = options.some((entry) => entry.path === selected) ? selected : "";
}

function threadRow(thread) {
  const button = document.createElement("button");
  button.className = "thread-row";
  button.type = "button";
  button.dataset.thread = thread.id;
  const title = document.createElement("strong");
  title.textContent = thread.title;
  const path = document.createElement("span");
  path.className = "thread-path";
  path.textContent = thread.cwd || "未知目录";
  path.title = thread.cwd || "";
  const detail = document.createElement("small");
  const updatedAt = Number(thread.updatedAt);
  detail.textContent = Number.isFinite(updatedAt)
    ? new Date(updatedAt * 1000).toLocaleString()
    : "";
  button.append(title, path, detail);
  button.onclick = async () => {
    button.disabled = true;
    try {
      state = await api("/api/thread/resume", {
        method: "POST",
        body: JSON.stringify({ threadId: thread.id }),
      });
      render();
      dialog.close();
    } catch (error) {
      alert(`无法恢复任务：${error.message}`);
      button.disabled = false;
    }
  };
  return button;
}

async function loadThreads(reset = true) {
  if (reset) {
    threadsCursor = null;
    threadsList.innerHTML = "<p class='empty compact'>正在加载</p>";
  }
  threadsMore.disabled = true;
  try {
    const params = new URLSearchParams();
    if (threadSearch.value.trim()) params.set("query", threadSearch.value.trim());
    if (threadDirectory.value) params.set("cwd", threadDirectory.value);
    if (!reset && threadsCursor) params.set("cursor", threadsCursor);
    const result = await api(`/api/threads?${params}`);
    if (state && result.workspaces) {
      state.workspaces = result.workspaces;
      renderWorkspaces();
      renderThreadDirectories(result.workspaces);
    }
    if (reset) threadsList.replaceChildren();
    for (const thread of result.threads) threadsList.append(threadRow(thread));
    if (!threadsList.children.length) {
      threadsList.innerHTML = "<p class='empty compact'>没有匹配的任务</p>";
    }
    threadsCursor = result.nextCursor;
    threadsMore.hidden = !threadsCursor;
  } catch (error) {
    threadsList.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    threadsMore.hidden = true;
  } finally {
    threadsMore.disabled = false;
  }
}

async function openThreads() {
  threadsList.innerHTML = "<p class='empty compact'>正在发现本机任务与目录</p>";
  threadsMore.hidden = true;
  dialog.showModal();
  try {
    const directories = await api("/api/directories");
    if (state) {
      state.workspaces = directories.workspaces;
      renderWorkspaces();
    }
    renderThreadDirectories(directories.workspaces);
  } catch (error) {
    threadsList.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
  await loadThreads(true);
  threadSearch.focus();
}

document.querySelector("#threads-button").onclick = openThreads;
threadSearch.addEventListener("input", () => {
  clearTimeout(threadSearchTimer);
  threadSearchTimer = setTimeout(() => loadThreads(true), 300);
});
threadDirectory.addEventListener("change", () => loadThreads(true));
threadsMore.addEventListener("click", () => loadThreads(false));
document.querySelector("#close-threads").onclick = () => {
  clearTimeout(threadSearchTimer);
  dialog.close();
};

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
boot();
