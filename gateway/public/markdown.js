function stripDestination(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  const titleMatch = trimmed.match(/^(\S+)(?:\s+["'][^"']*["'])?$/);
  return titleMatch ? titleMatch[1] : trimmed;
}

function localPathFromUrl(value) {
  const destination = stripDestination(value);
  if (/^[a-zA-Z]:[\\/]/.test(destination) || destination.startsWith("/")) {
    return destination;
  }
  if (!destination.toLowerCase().startsWith("file://")) return "";
  try {
    const parsed = new URL(destination);
    let path = decodeURIComponent(parsed.pathname);
    if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
    return path;
  } catch {
    return "";
  }
}

export function safeImageUrl(value) {
  const destination = stripDestination(value);
  const localPath = localPathFromUrl(destination);
  if (localPath) return `/api/local-file?path=${encodeURIComponent(localPath)}`;
  if (destination.startsWith("/api/uploads/") || destination.startsWith("/api/local-file?")) {
    return destination;
  }
  try {
    const parsed = new URL(destination);
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function safeLinkUrl(value) {
  const destination = stripDestination(value);
  try {
    const parsed = new URL(destination, window.location.origin);
    if (["https:", "http:", "mailto:"].includes(parsed.protocol)) return parsed.toString();
  } catch {
    return "";
  }
  return "";
}

function appendText(parent, value) {
  if (value) parent.append(document.createTextNode(value));
}

function appendInline(parent, source) {
  let remaining = String(source || "");
  const patterns = [
    {
      regex: /^!\[([^\]]*)\]\(([^)\n]+)\)/,
      render(match) {
        const src = safeImageUrl(match[2]);
        if (!src) {
          appendText(parent, match[0]);
          return;
        }
        const link = document.createElement("a");
        link.href = src;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "markdown-image-link";
        const image = document.createElement("img");
        image.src = src;
        image.alt = match[1] || "图片";
        image.loading = "lazy";
        image.className = "markdown-image";
        link.append(image);
        parent.append(link);
      },
    },
    {
      regex: /^\[([^\]]+)\]\(([^)\n]+)\)/,
      render(match) {
        const href = safeLinkUrl(match[2]);
        if (!href) {
          appendText(parent, match[0]);
          return;
        }
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        appendInline(link, match[1]);
        parent.append(link);
      },
    },
    {
      regex: /^`([^`\n]+)`/,
      render(match) {
        const code = document.createElement("code");
        code.textContent = match[1];
        parent.append(code);
      },
    },
    {
      regex: /^\*\*([^*\n]+)\*\*/,
      render(match) {
        const strong = document.createElement("strong");
        appendInline(strong, match[1]);
        parent.append(strong);
      },
    },
    {
      regex: /^__([^_\n]+)__/,
      render(match) {
        const strong = document.createElement("strong");
        appendInline(strong, match[1]);
        parent.append(strong);
      },
    },
    {
      regex: /^\*([^*\n]+)\*/,
      render(match) {
        const emphasis = document.createElement("em");
        appendInline(emphasis, match[1]);
        parent.append(emphasis);
      },
    },
  ];

  while (remaining) {
    if (remaining.startsWith("\n")) {
      parent.append(document.createElement("br"));
      remaining = remaining.slice(1);
      continue;
    }
    let matched = false;
    for (const pattern of patterns) {
      const match = remaining.match(pattern.regex);
      if (!match) continue;
      pattern.render(match);
      remaining = remaining.slice(match[0].length);
      matched = true;
      break;
    }
    if (matched) continue;
    const special = remaining.slice(1).search(/[!\[*_`\n]/);
    const length = special === -1 ? remaining.length : special + 1;
    appendText(parent, remaining.slice(0, length));
    remaining = remaining.slice(length);
  }
}

function appendParagraph(container, lines) {
  const paragraph = document.createElement("p");
  appendInline(paragraph, lines.join("\n"));
  container.append(paragraph);
}

export function renderMarkdown(value) {
  const container = document.createElement("div");
  container.className = "markdown";
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    appendParagraph(container, paragraph);
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^```([\w.+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[1]) code.dataset.language = fence[1];
      code.textContent = codeLines.join("\n");
      pre.append(code);
      container.append(pre);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const element = document.createElement(`h${heading[1].length + 2}`);
      appendInline(element, heading[2]);
      container.append(element);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      const blockquote = document.createElement("blockquote");
      appendInline(blockquote, quote[1]);
      container.append(blockquote);
      continue;
    }
    const listItem = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      const ordered = /\d+\./.test(listItem[2]);
      const tag = ordered ? "ol" : "ul";
      let list = container.lastElementChild;
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = document.createElement(tag);
        container.append(list);
      }
      const item = document.createElement("li");
      appendInline(item, listItem[3]);
      list.append(item);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return container;
}
