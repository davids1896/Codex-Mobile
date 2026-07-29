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
const permissionButtons = [...document.querySelectorAll("[data-permission]")];

let maxAttachments = 8;
let maxUploadBytes = 25 * 1024 * 1024;
let state = null;
let events = null;
let selectedFiles = [];
let uploading = false;

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

function renderMessageAttachments(items = []) {
  if (!items.length) return "";
  return `<div class="message-attachments">${items.map((item) => {
    const preview = item.isImage && item.url
      ? `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}">`
      : `<span class="file-symbol" aria-hidden="true">FILE</span>`;
    return `<div class="message-attachment">${preview}<span>${escapeHtml(item.name)}</span></div>`;
  }).join("")}</div>`;
}

function render() {
  if (!state) return;
  statusDot.classList.toggle("online", state.connected);
  threadTitle.textContent = state.threadTitle || "新任务";
  stopButton.hidden = !state.busy;
  input.disabled = state.busy || uploading;
  sendButton.disabled = state.busy || uploading;
  attachButton.disabled = state.busy || uploading;
  permissionButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.permission === state.permissionMode);
    button.disabled = state.busy || uploading;
  });

  if (!state.messages.length) {
    messages.innerHTML = `<div class="empty">已连接到 ${escapeHtml(state.workspace)}<br>可以发送文字、图片或文件</div>`;
  } else {
    messages.innerHTML = state.messages.map((message) => {
      const output = message.output ? `<pre>${escapeHtml(message.output)}</pre>` : "";
      return `<article class="message ${message.role}">
        ${message.text ? `<div>${escapeHtml(message.text)}</div>` : ""}
        ${renderMessageAttachments(message.attachments)}
        ${output}
      </article>`;
    }).join("");
    messages.scrollTop = messages.scrollHeight;
  }

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

stopButton.onclick = () => api("/api/interrupt", { method: "POST", body: "{}" });
document.querySelector("#new-button").onclick = async () => {
  if (state?.busy && !confirm("当前任务仍在运行，确定新建任务？")) return;
  await api("/api/thread/new", { method: "POST", body: "{}" });
};
document.querySelector("#threads-button").onclick = async () => {
  threadsList.innerHTML = "<p class='empty'>正在加载</p>";
  dialog.showModal();
  try {
    const result = await api("/api/threads");
    threadsList.innerHTML = result.threads.map((thread) => `
      <button class="thread-row" data-thread="${thread.id}">
        <strong>${escapeHtml(thread.title)}</strong>
        <small>${new Date(thread.updatedAt * 1000).toLocaleString()}</small>
      </button>`).join("") || "<p class='empty'>暂无历史任务</p>";
    threadsList.querySelectorAll("[data-thread]").forEach((button) => {
      button.onclick = async () => {
        await api("/api/thread/resume", {
          method: "POST",
          body: JSON.stringify({ threadId: button.dataset.thread }),
        });
        dialog.close();
      };
    });
  } catch (error) {
    threadsList.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
};
document.querySelector("#close-threads").onclick = () => dialog.close();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
boot();
