(function () {
  const state = {
    mode: "quick",
    sessionId: loadSessionId(),
    keyConfigured: false,
    busy: false,
  };

  const prompts = document.getElementById("promptList");
  const modeToggle = document.getElementById("modeToggle");
  const submitButton = document.getElementById("submitButton");
  const composer = document.getElementById("composer");
  const chatFeed = document.getElementById("chatFeed");
  const errorBanner = document.getElementById("errorBanner");
  const questionInput = document.getElementById("questionInput");
  const resetButton = document.getElementById("resetButton");

  function loadSessionId() {
    const existing = window.localStorage.getItem("commodity-agent-session-id");
    if (existing) return existing;
    const created = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now());
    window.localStorage.setItem("commodity-agent-session-id", created);
    return created;
  }

  function newSessionId() {
    const created = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now());
    window.localStorage.setItem("commodity-agent-session-id", created);
    return created;
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function escapeHtml(value) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function renderRichText(text) {
    const escaped = escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    const blocks = escaped.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
    return blocks
      .map((block) => `<p>${block.replace(/\n/g, "<br />")}</p>`)
      .join("");
  }

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.classList.remove("hidden");
  }

  function clearError() {
    errorBanner.textContent = "";
    errorBanner.classList.add("hidden");
  }

  function addMessage(role, html, extra) {
    const article = document.createElement("article");
    article.className = `message-card ${role}`;
    article.innerHTML = `
      <div class="message-top">
        <span>${role === "user" ? "你" : "智能体"}</span>
        ${extra ? `<small>${extra}</small>` : ""}
      </div>
      <div class="message-body">${html}</div>
    `;
    chatFeed.appendChild(article);
    chatFeed.scrollTop = chatFeed.scrollHeight;
    return article;
  }

  function setBusy(busy) {
    state.busy = busy;
    submitButton.disabled = busy;
    submitButton.textContent = busy ? "分析中..." : "开始分析";
  }

  function formatTime(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function updateModeUi() {
    modeToggle.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === state.mode);
    });
    setText("activeModeLabel", state.mode === "research" ? "联网研究" : "快速判断");
  }

  async function loadStatus() {
    const response = await fetch("/api/status");
    const payload = await response.json();
    setText("latestGeneratedAt", formatTime(payload.latest_generated_at));
    setText("trackedCount", payload.tracked_count == null ? "-" : String(payload.tracked_count));
    setText("quickModel", payload.quick_model || "-");
    setText("researchModel", payload.research_model || "-");
    setText("keyStatus", payload.key_configured ? "已配置" : "未配置");
    setText("statusBadge", payload.key_configured ? "可联网" : "待配置");

    state.keyConfigured = Boolean(payload.key_configured);
    const notice = document.getElementById("setupNotice");
    if (state.keyConfigured) {
      notice.classList.add("hidden");
      notice.textContent = "";
    } else {
      notice.classList.remove("hidden");
      notice.innerHTML = [
        "未检测到 <code>OPENAI_API_KEY</code>。",
        "先在当前机器设置环境变量，再双击启动本地智能体。",
      ].join("<br />");
    }
  }

  function renderCitations(citations) {
    if (!citations || !citations.length) return "";
    const links = citations
      .map((item) => `<a href="${item.url}" target="_blank" rel="noreferrer">${escapeHtml(item.title || item.url)}</a>`)
      .join("");
    return `<div class="citation-list">${links}</div>`;
  }

  async function submitQuestion(question, resetSession) {
    clearError();
    addMessage("user", renderRichText(question), state.mode === "research" ? "联网研究" : "快速判断");
    const loading = addMessage("assistant", "<p>正在组合本地监测上下文并请求模型分析，请稍候...</p>");
    setBusy(true);

    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          mode: state.mode,
          session_id: state.sessionId,
          reset_session: resetSession,
        }),
      });
      const payload = await response.json();
      loading.remove();

      if (!response.ok || !payload.ok) {
        showError(payload.error || "分析失败。");
        return;
      }

      const focus = payload.local_summary && payload.local_summary.focus_materials && payload.local_summary.focus_materials.length
        ? `聚焦 ${payload.local_summary.focus_materials.join("、")}`
        : payload.model;
      addMessage(
        "assistant",
        `${renderRichText(payload.answer)}${renderCitations(payload.citations)}`,
        `${focus} · ${formatTime(payload.updated_at)}`
      );
    } catch (error) {
      loading.remove();
      showError(`请求失败: ${error}`);
    } finally {
      setBusy(false);
    }
  }

  prompts.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-prompt]");
    if (!button || state.busy) return;
    questionInput.value = button.dataset.prompt || "";
    questionInput.focus();
  });

  modeToggle.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button || state.busy) return;
    state.mode = button.dataset.mode || "quick";
    updateModeUi();
  });

  resetButton.addEventListener("click", () => {
    if (state.busy) return;
    state.sessionId = newSessionId();
    chatFeed.innerHTML = "";
    clearError();
    addMessage(
      "assistant",
      "<p>已开始新会话。你可以直接问今天哪些原材料值得盯盘，或者让它整理成老板汇报。</p>",
      "本地公开数据优先"
    );
  });

  composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.busy) return;
    const question = questionInput.value.trim();
    if (!question) {
      showError("请输入要分析的问题。");
      return;
    }
    questionInput.value = "";
    await submitQuestion(question, false);
  });

  addMessage(
    "assistant",
    "<p>这里是本地-only 的智能分析入口。它会先读取最新监测结果，再按需要联网补充当天外部信息。</p>",
    "欢迎使用"
  );
  updateModeUi();
  loadStatus().catch((error) => showError(`状态初始化失败: ${error}`));
})();
