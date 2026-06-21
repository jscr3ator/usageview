const app = document.getElementById("app");

const state = {
  config: null,
  setup: null,
  stats: null,
  timer: null,
  resizeHandler: null,
};

boot();

async function boot() {
  app.classList.remove("is-loading");
  const key = new URLSearchParams(location.search).get("key");
  if (key) {
    await api(`/api/view/session?key=${encodeURIComponent(key)}`, {}, true);
    history.replaceState(null, "", location.pathname);
  }

  if (location.pathname === "/setup") {
    await renderSetup();
    return;
  }

  await renderDashboardShell();
}

async function renderSetup() {
  const setup = await api("/api/setup/status", {}, true);
  if (!setup.ok) {
    app.innerHTML = lockedSetup();
    return;
  }
  state.setup = setup;
  state.config = setup.config;
  app.innerHTML = setupTemplate(setup);
  bindSetup();
}

function bindSetup() {
  const form = document.getElementById("setupForm");
  const widgetControls = document.getElementById("widgetControls");
  const steps = [...document.querySelectorAll("[data-setup-step]")];
  const dots = [...document.querySelectorAll("[data-step-dot]")];
  const backButton = document.getElementById("setupBack");
  const nextButton = document.getElementById("setupNext");
  const saveButton = document.getElementById("setupSave");
  const saveState = document.getElementById("saveState");
  const spotifyConnect = document.getElementById("spotifyConnect");
  let draggedWidgetId = null;
  let currentStep = 0;
  let autosaveTimer = 0;

  const renderWidgetControls = () => {
    widgetControls.innerHTML = widgetEditorMarkup(state.config.widgets);
  };

  const setupPayload = () => ({
    viewerKey: document.getElementById("viewerKey").value.trim(),
    config: {
      refreshMs: Number(document.getElementById("refreshMs").value || 2500),
      density: document.querySelector("[name='density']:checked")?.value || "compact",
      dashboardWidth: document.querySelector("[name='dashboardWidth']:checked")?.value || "standard",
      glass: document.querySelector("[name='glass']:checked")?.value || "balanced",
      textScale: document.querySelector("[name='textScale']:checked")?.value || "normal",
      showUpdatedAt: document.getElementById("showUpdatedAt").checked,
      widgets: state.config.widgets,
    },
    spotify: {
      clientId: document.getElementById("spotifyClientId").value.trim(),
      clientSecret: document.getElementById("spotifyClientSecret").value.trim(),
      refreshToken: document.getElementById("spotifyRefreshToken").value.trim(),
    },
  });

  const updateSpotifyConnectState = () => {
    const payload = setupPayload();
    const hasClient = Boolean(payload.spotify.clientId || state.setup?.spotify?.clientIdConfigured);
    const hasSecret = Boolean(payload.spotify.clientSecret || state.setup?.spotify?.clientSecretConfigured);
    spotifyConnect.classList.toggle("is-disabled", !(hasClient && hasSecret));
  };

  const saveSetup = async (message = "Saved") => {
    saveState.textContent = "Saving...";
    const saved = await api("/api/setup", { method: "PUT", body: JSON.stringify(setupPayload()) });
    if (saved.ok) {
      state.setup = saved;
      state.config = saved.config;
      saveState.textContent = message;
      document.getElementById("displayUrl").value = firstDisplayUrl(saved);
      updateSpotifyConnectState();
      return true;
    }
    saveState.textContent = saved.error || "Could not save";
    updateSpotifyConnectState();
    return false;
  };

  const autosave = () => {
    saveState.textContent = "Unsaved changes";
    updateSpotifyConnectState();
    clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => {
      saveSetup("Saved automatically");
    }, 650);
  };

  const showStep = (index) => {
    currentStep = Math.max(0, Math.min(steps.length - 1, index));
    steps.forEach((step, stepIndex) => {
      step.hidden = stepIndex !== currentStep;
    });
    dots.forEach((dot, dotIndex) => {
      dot.classList.toggle("is-active", dotIndex === currentStep);
    });
    backButton.disabled = currentStep === 0;
    nextButton.hidden = currentStep === steps.length - 1;
    saveButton.hidden = currentStep !== steps.length - 1;
  };

  backButton.addEventListener("click", () => showStep(currentStep - 1));
  nextButton.addEventListener("click", () => showStep(currentStep + 1));

  widgetControls.addEventListener("click", (event) => {
    const reset = event.target.closest("#resetLayout");
    if (reset) {
      state.config.widgets = defaultWidgets();
      renderWidgetControls();
      autosave();
      return;
    }

    const move = event.target.closest("[data-move]");
    if (move) {
      const index = Number(move.dataset.index);
      const direction = Number(move.dataset.move);
      const next = index + direction;
      if (next < 0 || next >= state.config.widgets.length) return;
      reorderWidget(index, next);
      renderWidgetControls();
      autosave();
      return;
    }

    const size = event.target.closest("[data-size]");
    if (size) {
      const item = state.config.widgets.find((widget) => widget.id === size.dataset.size);
      if (!item) return;
      item.size = nextWidgetSize(item.size);
      renderWidgetControls();
      autosave();
    }
  });

  widgetControls.addEventListener("change", (event) => {
    const input = event.target.closest("[data-widget]");
    if (!input) return;
    const item = state.config.widgets.find((widget) => widget.id === input.dataset.widget);
    if (item) {
      item.enabled = input.checked;
      autosave();
    }
  });

  widgetControls.addEventListener("input", (event) => {
    const input = event.target.closest("[data-widget-label]");
    if (!input) return;
    const item = state.config.widgets.find((widget) => widget.id === input.dataset.widgetLabel);
    if (item) {
      item.label = input.value.trim().slice(0, 24) || defaultWidgetLabel(item.id);
      autosave();
    }
  });

  widgetControls.addEventListener("dragstart", (event) => {
    const row = event.target.closest("[data-widget-row]");
    if (!row) return;
    draggedWidgetId = row.dataset.widgetRow;
    row.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedWidgetId);
  });

  widgetControls.addEventListener("dragend", () => {
    draggedWidgetId = null;
    widgetControls.querySelectorAll(".is-dragging, .is-drop-target").forEach((row) => {
      row.classList.remove("is-dragging", "is-drop-target");
    });
  });

  widgetControls.addEventListener("dragover", (event) => {
    const row = event.target.closest("[data-widget-row]");
    if (!row || !draggedWidgetId || row.dataset.widgetRow === draggedWidgetId) return;
    event.preventDefault();
    widgetControls.querySelectorAll(".is-drop-target").forEach((item) => item.classList.remove("is-drop-target"));
    row.classList.add("is-drop-target");
  });

  widgetControls.addEventListener("drop", (event) => {
    const row = event.target.closest("[data-widget-row]");
    if (!row) return;
    event.preventDefault();
    const fromId = draggedWidgetId || event.dataTransfer.getData("text/plain");
    const toId = row.dataset.widgetRow;
    const from = state.config.widgets.findIndex((widget) => widget.id === fromId);
    const to = state.config.widgets.findIndex((widget) => widget.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    reorderWidget(from, to);
    draggedWidgetId = null;
    renderWidgetControls();
    autosave();
  });

  form.addEventListener("input", (event) => {
    if (event.target.closest("#displayUrl")) return;
    if (event.target.closest("#viewerKey")) {
      document.getElementById("displayUrl").value = firstDisplayUrl({
        ...state.setup,
        viewerKey: document.getElementById("viewerKey").value.trim(),
      });
    }
    autosave();
  });

  form.addEventListener("change", (event) => {
    if (event.target.closest("[data-widget]")) return;
    autosave();
  });

  document.getElementById("copyDisplayUrl").addEventListener("click", async () => {
    const value = document.getElementById("displayUrl").value;
    await navigator.clipboard?.writeText(value).catch(() => {});
  });

  document.getElementById("regenKey").addEventListener("click", async () => {
    const next = await api("/api/setup/regenerate-key", { method: "POST" });
    if (next.ok) {
      state.setup = next;
      document.getElementById("viewerKey").value = next.viewerKey;
      document.getElementById("displayUrl").value = firstDisplayUrl(next);
      updateSpotifyConnectState();
    }
  });

  spotifyConnect.addEventListener("click", async () => {
    const payload = setupPayload();
    const hasClient = Boolean(payload.spotify.clientId || state.setup?.spotify?.clientIdConfigured);
    const hasSecret = Boolean(payload.spotify.clientSecret || state.setup?.spotify?.clientSecretConfigured);
    if (!hasClient || !hasSecret) {
      saveState.textContent = "Add Spotify Client ID and secret first";
      updateSpotifyConnectState();
      return;
    }
    clearTimeout(autosaveTimer);
    const saved = await saveSetup("Saved. Opening Spotify...");
    if (saved) location.href = "/api/setup/spotify/connect";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearTimeout(autosaveTimer);
    await saveSetup("Saved");
  });

  showStep(0);
  updateSpotifyConnectState();
}

async function renderDashboardShell() {
  app.innerHTML = `
    <section id="dashboard" class="dashboard">
      <div id="dashboardStage" class="dashboard-stage">
        <header class="dashboard-top">
          <span id="updatedAt" class="status-strip" aria-live="polite">Waiting for data</span>
        </header>
        <section id="widgets" class="widgets"></section>
      </div>
    </section>
  `;
  if (state.resizeHandler) window.removeEventListener("resize", state.resizeHandler);
  state.resizeHandler = () => fitDashboard();
  window.addEventListener("resize", state.resizeHandler, { passive: true });
  state.config = await api("/api/config", {}, true);
  if (state.config.status === 401) {
    renderDisplayKeyForm();
    return;
  }
  applyConfig();
  await refresh();
  clearInterval(state.timer);
  state.timer = setInterval(refresh, state.config.refreshMs || 3000);
}

function renderDisplayKeyForm() {
  app.innerHTML = `
    <section class="setup-page">
      <form id="keyForm" class="glass-panel setup-panel narrow">
        <p class="eyebrow">Private display</p>
        <h1>Display key</h1>
        <label class="field">
          <span>Key</span>
          <input id="displayKey" autocomplete="off" spellcheck="false">
        </label>
        <button class="primary" type="submit">Open display</button>
        <p id="keyError" class="small-text"></p>
      </form>
    </section>
  `;
  document.getElementById("keyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const key = document.getElementById("displayKey").value.trim();
    const response = await api(`/api/view/session?key=${encodeURIComponent(key)}`, {}, true);
    if (!response.ok) {
      document.getElementById("keyError").textContent = "Invalid key";
      return;
    }
    await renderDashboardShell();
  });
}

async function refresh() {
  const stats = await api("/api/stats", {}, true);
  if (stats.status === 401) {
    clearInterval(state.timer);
    renderDisplayKeyForm();
    return;
  }
  if (!stats.ok) return;
  state.stats = stats;
  state.config = stats.config || state.config;
  applyConfig();
  renderDashboard();
}

function applyConfig() {
  app.dataset.density = state.config?.density || "compact";
  app.dataset.width = state.config?.dashboardWidth || "standard";
  app.dataset.glass = state.config?.glass || "balanced";
  app.dataset.text = state.config?.textScale || "normal";
}

function renderDashboard() {
  const stats = state.stats;
  const config = state.config;
  const widgets = document.getElementById("widgets");
  const updatedAt = document.getElementById("updatedAt");
  if (!stats || !config || !widgets || !updatedAt) return;

  updatedAt.hidden = config.showUpdatedAt === false;
  updatedAt.textContent = config.showUpdatedAt === false
    ? ""
    : new Date(stats.now).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
  widgets.innerHTML = "";

  const renderers = {
    spotify: renderSpotify,
    codex: renderCodex,
    cpu: renderCpu,
    memory: renderMemory,
    gpu: renderGpu,
    clock: renderClock,
  };

  const visibleWidgets = config.widgets.filter((item) => item.enabled);
  widgets.style.setProperty("--dashboard-rows", String(widgetRows(visibleWidgets)));

  for (const widget of visibleWidgets) {
    const render = renderers[widget.id];
    if (render) widgets.appendChild(render(stats, widget));
  }
  fitDashboard();
}

function fitDashboard() {
  const dashboard = document.getElementById("dashboard");
  const stage = document.getElementById("dashboardStage");
  if (!dashboard || !stage) return;
  stage.style.setProperty("--fit-scale", "1");
  const availableWidth = Math.max(1, dashboard.clientWidth);
  const availableHeight = Math.max(1, dashboard.clientHeight);
  const stageWidth = Math.max(1, stage.offsetWidth);
  const stageHeight = Math.max(1, stage.offsetHeight);
  const scale = Math.min(1, availableWidth / stageWidth, availableHeight / stageHeight);
  stage.style.setProperty("--fit-scale", String(Math.max(0.18, scale)));
}

function renderSpotify(stats, widget) {
  const spotify = stats.spotify;
  const label = widget?.label || "Spotify";
  const card = document.createElement("article");
  card.className = widgetClass("spotify", widget);
  if (!spotify.ok) {
    card.innerHTML = `${head(label, "Offline")}<div class="song song-idle"><div class="song-copy"><div class="song-title">Nothing playing</div></div></div>`;
    return card;
  }
  if (!spotify.playing || !spotify.item) {
    card.innerHTML = `${head(label, "Idle")}<div class="song song-idle"><div class="song-copy"><div class="song-title">Nothing playing</div></div></div>`;
    return card;
  }
  const progress = spotify.item.durationMs ? (spotify.progressMs / spotify.item.durationMs) * 100 : 0;
  card.innerHTML = `
    ${head(label, spotify.playing ? "Playing" : "Paused")}
    <div class="song">
      <div class="album-wrap">${spotify.item.image ? `<img class="album" alt="" src="${escapeHtml(spotify.item.image)}">` : `<div class="album"></div>`}</div>
      <div class="song-copy">
        <div class="song-title">${escapeHtml(spotify.item.title)}</div>
        <div class="song-artist">${escapeHtml(spotify.item.artists || "")}</div>
      </div>
    </div>
    <div class="player-bottom">${bar(progress)}<span class="small-text">${time(spotify.progressMs)} / ${time(spotify.item.durationMs)}</span></div>
  `;
  return card;
}

function renderCodex(stats, widget) {
  const card = document.createElement("article");
  card.className = widgetClass("codex", widget);
  const codex = stats.codex;
  const label = widget?.label || "Codex";
  if (!codex.ok) {
    card.innerHTML = `${head(label, "Unavailable")}<p class="small-text">${escapeHtml(codex.message || "No data")}</p>`;
    return card;
  }
  const usage = codex.usage || {};
  card.innerHTML = `
    ${head(label, codex.limits?.stale ? "Stale" : "Live")}
    <div class="codex-limits">
      ${limitCell("5H", codex.limits?.primary)}
      ${limitCell("Week", codex.limits?.secondary)}
    </div>
    <div class="mini-grid two-up">
      ${mini("Today", shortNumber(usage.todayTokens || 0), `${usage.todayCalls || 0} prompts sent`)}
      ${mini("All time", shortNumber(usage.totalTokens || 0), "tokens used")}
    </div>
  `;
  return card;
}

function renderCpu(stats, widget) {
  const cpu = stats.system.cpu;
  return metricCard(widget?.label || "CPU", `${fmt(cpu.percent)}%`, cpu.percent, `${cpu.cores} cores`, "", widget);
}

function renderMemory(stats, widget) {
  const memory = stats.system.memory;
  return metricCard(widget?.label || "Memory", `${fmt(memory.percent)}%`, memory.percent, bytes(memory.used), `${bytes(memory.total)} total`, widget);
}

function renderGpu(stats, widget) {
  if (!stats.gpu.ok || !stats.gpu.devices?.length) {
    return metricCard(widget?.label || "GPU", "N/A", 0, "Unavailable", "", widget);
  }
  const gpu = stats.gpu.devices[0];
  const name = trim(String(gpu.name || "").replace(/^NVIDIA GeForce\s+/i, ""), 18);
  return metricCard(widget?.label || "GPU", `${fmt(gpu.percent)}%`, gpu.percent, gpu.temperatureC ? `${gpu.temperatureC} C` : "", name, widget);
}

function renderClock(stats, widget) {
  const card = document.createElement("article");
  card.className = widgetClass("clock", widget);
  const now = new Date();
  card.innerHTML = `${head(widget?.label || "Time", now.toLocaleDateString([], { weekday: "short" }))}<div class="clock-face">${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div><p class="small-text">${now.toLocaleDateString([], { month: "long", day: "numeric" })}</p>`;
  return card;
}

function setupTemplate(setup) {
  const params = new URLSearchParams(location.search);
  const spotifyStatus = params.get("spotify");
  return `
    <section class="setup-page">
      <form id="setupForm" class="glass-panel setup-panel wizard-panel">
        <header class="setup-head">
          <div>
            <p class="eyebrow">Local setup</p>
            <h1>Onboarding</h1>
          </div>
          <a class="secondary-action" href="/">Display</a>
        </header>

        <div class="wizard-dots" aria-hidden="true">
          <span data-step-dot></span>
          <span data-step-dot></span>
          <span data-step-dot></span>
          <span data-step-dot></span>
          <span data-step-dot></span>
        </div>

        <section class="setup-step" data-setup-step>
          <p class="step-kicker">Start</p>
          <h2>Your private display</h2>
          <p class="setup-copy">This app runs on this PC, shows a read-only dashboard on your tablet, and keeps setup locked to localhost.</p>
          <div class="step-list">
            <span>Use the tray icon for setup, dashboard, copy URL, restart, and quit.</span>
            <span>Share only the keyed display URL with the tablet.</span>
            <span>Spotify can be skipped and added later.</span>
          </div>
        </section>

        <section class="setup-step" data-setup-step>
          <p class="step-kicker">Display</p>
          <h2>Display access</h2>
          <p class="setup-copy">Type your own display key or generate one. This key lets a tablet read stats from your PC, but it does not allow control actions.</p>
          <div class="field-row">
            <label class="field">
              <span>Display key</span>
              <input id="viewerKey" value="${escapeAttr(setup.viewerKey)}" minlength="8" maxlength="128" autocomplete="off" spellcheck="false">
            </label>
            <button id="regenKey" class="secondary-action" type="button">Generate</button>
          </div>
          <p class="setup-note">Use at least 8 characters. The tablet URL updates automatically after the key saves.</p>
          <div class="field-row">
            <label class="field">
              <span>Tablet URL</span>
              <input id="displayUrl" value="${escapeAttr(firstDisplayUrl(setup))}" readonly>
            </label>
            <button id="copyDisplayUrl" class="secondary-action" type="button">Copy</button>
          </div>
        </section>

        <section class="setup-step" data-setup-step>
          <p class="step-kicker">Layout</p>
          <h2>Widgets</h2>
          <p class="setup-copy">Drag to reorder, rename widgets, hide anything you do not want, and choose how much space each item gets.</p>
          <p class="setup-note">Codex usage reads local Codex logs on this PC. If Codex has not been used here, or if its telemetry format changes, the widget will say unavailable instead of guessing.</p>
          <div id="widgetControls" class="widget-controls">
            ${widgetEditorMarkup(setup.config.widgets)}
          </div>
        </section>

        <section class="setup-step" data-setup-step>
          <p class="step-kicker">Spotify</p>
          <h2>Music</h2>
          <p class="setup-copy">Optional. Create a Spotify developer app, add the redirect URI, paste your Client ID and secret, then connect. Keys save automatically as you type.</p>
          <div class="callout">
            <span>Redirect URI</span>
            <code>${escapeHtml(setup.redirectUri)}</code>
          </div>
          <a class="secondary-action external-link" href="https://developer.spotify.com/dashboard">Open Spotify dashboard</a>
          <label class="field"><span>Client ID</span><input id="spotifyClientId" placeholder="${setup.spotify.clientIdConfigured ? "Saved" : ""}" autocomplete="off" spellcheck="false"></label>
          <label class="field"><span>Client secret</span><input id="spotifyClientSecret" type="password" placeholder="${setup.spotify.clientSecretConfigured ? "Saved" : ""}" autocomplete="off" spellcheck="false"></label>
          <label class="field"><span>Refresh token</span><input id="spotifyRefreshToken" type="password" placeholder="${setup.spotify.refreshTokenConfigured ? "Saved automatically after connect" : "Optional manual paste"}" autocomplete="off" spellcheck="false"></label>
          <button id="spotifyConnect" class="secondary-action ${setup.spotify.clientIdConfigured && setup.spotify.clientSecretConfigured ? "" : "is-disabled"}" type="button">Connect Spotify</button>
          ${spotifyStatus ? `<p class="small-text">Spotify: ${escapeHtml(spotifyStatus)}</p>` : ""}
        </section>

        <section class="setup-step" data-setup-step>
          <p class="step-kicker">Finish</p>
          <h2>Refresh</h2>
          <p class="setup-copy">Tune the display for your tablet. Lower refresh numbers feel faster but use more CPU and network.</p>
          <label class="field">
            <span>Refresh ms</span>
            <input id="refreshMs" type="number" min="1000" max="15000" step="500" value="${Number(setup.config.refreshMs || 2500)}">
          </label>
          <div class="option-group">
            <span>Dashboard width</span>
            <div class="segmented three">
              ${radio("dashboardWidth", "compact", "Compact", setup.config.dashboardWidth === "compact")}
              ${radio("dashboardWidth", "standard", "Standard", setup.config.dashboardWidth !== "compact" && setup.config.dashboardWidth !== "wide")}
              ${radio("dashboardWidth", "wide", "Wide", setup.config.dashboardWidth === "wide")}
            </div>
          </div>
          <div class="option-group">
            <span>Glass</span>
            <div class="segmented three">
              ${radio("glass", "clear", "Clear", setup.config.glass === "clear")}
              ${radio("glass", "balanced", "Balanced", setup.config.glass !== "clear" && setup.config.glass !== "deep")}
              ${radio("glass", "deep", "Deep", setup.config.glass === "deep")}
            </div>
          </div>
          <div class="option-group">
            <span>Text size</span>
            <div class="segmented three">
              ${radio("textScale", "small", "Small", setup.config.textScale === "small")}
              ${radio("textScale", "normal", "Normal", setup.config.textScale !== "small" && setup.config.textScale !== "large")}
              ${radio("textScale", "large", "Large", setup.config.textScale === "large")}
            </div>
          </div>
          <label class="check-line">
            <input id="showUpdatedAt" type="checkbox" ${setup.config.showUpdatedAt !== false ? "checked" : ""}>
            <span>Show updated time</span>
          </label>
          <div class="segmented">
            <label><input type="radio" name="density" value="compact" ${setup.config.density !== "roomy" ? "checked" : ""}><span>Compact</span></label>
            <label><input type="radio" name="density" value="roomy" ${setup.config.density === "roomy" ? "checked" : ""}><span>Roomy</span></label>
          </div>
          <div class="step-list">
            <span>Press save, then use the tablet URL from the tray copy action or the display step.</span>
            <span>Local setup stays blocked from other devices.</span>
          </div>
        </section>

        <footer class="setup-actions">
          <span id="saveState" class="small-text">${setup.setupComplete ? "Configured" : "Not saved yet"}</span>
          <div class="wizard-actions">
            <button id="setupBack" class="secondary-action" type="button">Back</button>
            <button id="setupNext" class="primary" type="button">Next</button>
            <button id="setupSave" class="primary" type="submit">Save setup</button>
          </div>
        </footer>
      </form>
    </section>
  `;
}

function lockedSetup() {
  return `
    <section class="setup-page">
      <div class="glass-panel setup-panel narrow">
        <p class="eyebrow">Local setup</p>
        <h1>Open on this PC</h1>
        <p class="small-text">Setup is only available from localhost so network devices cannot change this display.</p>
      </div>
    </section>
  `;
}

function widgetControlMarkup(widgets) {
  return widgets.map((widget, index) => `
    <div class="widget-control" draggable="true" data-widget-row="${escapeAttr(widget.id)}">
      <button class="drag-handle" type="button" aria-label="Drag ${escapeAttr(widget.label || widget.id)}">Grip</button>
      <label class="toggle-line" title="Show widget">
        <input type="checkbox" data-widget="${escapeAttr(widget.id)}" ${widget.enabled !== false ? "checked" : ""}>
      </label>
      <label class="field compact-field">
        <span>${escapeHtml(defaultWidgetLabel(widget.id))}</span>
        <input data-widget-label="${escapeAttr(widget.id)}" value="${escapeAttr(widget.label || defaultWidgetLabel(widget.id))}" maxlength="24" autocomplete="off" spellcheck="false">
      </label>
      <button class="size-button" type="button" data-size="${escapeAttr(widget.id)}" aria-label="Change ${escapeAttr(widget.label || widget.id)} size">${sizeLabel(widget.size)}</button>
      <div class="move-actions">
        <button class="small-button" type="button" data-index="${index}" data-move="-1" aria-label="Move ${escapeAttr(widget.label || widget.id)} up">Up</button>
        <button class="small-button" type="button" data-index="${index}" data-move="1" aria-label="Move ${escapeAttr(widget.label || widget.id)} down">Dn</button>
      </div>
    </div>
  `).join("");
}

function widgetEditorMarkup(widgets) {
  return `
    <div class="editor-toolbar">
      <span>Layout editor</span>
      <button id="resetLayout" class="secondary-action" type="button">Reset</button>
    </div>
    ${widgetControlMarkup(widgets)}
  `;
}

function radio(name, value, label, checked) {
  return `<label><input type="radio" name="${escapeAttr(name)}" value="${escapeAttr(value)}" ${checked ? "checked" : ""}><span>${escapeHtml(label)}</span></label>`;
}

function defaultWidgets() {
  return [
    { id: "spotify", label: "Spotify", enabled: true, size: "wide" },
    { id: "codex", label: "Codex", enabled: true, size: "tall" },
    { id: "cpu", label: "CPU", enabled: true, size: "normal" },
    { id: "memory", label: "Memory", enabled: true, size: "normal" },
    { id: "gpu", label: "GPU", enabled: true, size: "normal" },
    { id: "clock", label: "Clock", enabled: true, size: "normal" },
  ];
}

function widgetRows(widgets) {
  const cells = widgets.reduce((total, widget) => {
    if (widget.size === "tall") return total + 4;
    if (widget.size === "wide") return total + 2;
    return total + 1;
  }, 0);
  return Math.max(1, Math.ceil(cells / 2));
}

function defaultWidgetLabel(id) {
  return defaultWidgets().find((widget) => widget.id === id)?.label || id;
}

function firstDisplayUrl(setup) {
  const base = setup.networkUrls?.[0]?.url || setup.localUrl || location.origin;
  return `${base}/?key=${encodeURIComponent(setup.viewerKey || "")}`;
}

function metricCard(name, value, percent, left, right, widget) {
  const card = document.createElement("article");
  card.className = widgetClass("metric", widget);
  card.innerHTML = `${head(name, "Live")}<div class="metric-value">${escapeHtml(value)}</div>${bar(percent)}<div class="metric-foot"><span class="small-text">${escapeHtml(left)}</span><span class="small-text">${escapeHtml(right)}</span></div>`;
  return card;
}

function widgetClass(kind, widget) {
  const size = widget?.size || "normal";
  return `widget ${kind} ${size === "wide" ? "is-wide" : ""} ${size === "tall" ? "is-tall" : ""}`.replace(/\s+/g, " ").trim();
}

function reorderWidget(from, to) {
  const copy = [...state.config.widgets];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  state.config.widgets = copy;
}

function nextWidgetSize(size) {
  if (size === "normal") return "wide";
  if (size === "wide") return "tall";
  return "normal";
}

function sizeLabel(size) {
  if (size === "wide") return "Wide";
  if (size === "tall") return "Tall";
  return "Normal";
}

function head(name, stateText) {
  return `<div class="metric-head"><span class="metric-title">${escapeHtml(name)}</span><span class="metric-unit">${escapeHtml(stateText)}</span></div>`;
}

function bar(value) {
  const number = Math.max(0, Math.min(100, Number(value) || 0));
  return `<div class="bar" aria-hidden="true"><span style="--value:${number}%"></span></div>`;
}

function limitCell(label, window) {
  if (!window) return `<div class="limit-cell"><span class="mini-label">${escapeHtml(label)}</span><div class="limit-value">N/A</div><span class="small-text">no data</span></div>`;
  const remaining = window.remainingPercent ?? null;
  const reset = window.resetsAt ? new Date(window.resetsAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "unknown";
  return `<div class="limit-cell"><span class="mini-label">${escapeHtml(label)}</span><div class="limit-value">${remaining === null ? "N/A" : `${fmt(remaining)}%`}</div><span class="small-text">reset ${escapeHtml(reset)}</span>${bar(remaining || 0)}</div>`;
}

function mini(label, value, caption) {
  return `<div class="mini"><span class="mini-label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><span class="small-text">${escapeHtml(caption || "")}</span></div>`;
}

async function api(path, options = {}, quiet = false) {
  try {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok && payload.ok !== false, ...payload };
  } catch (error) {
    if (!quiet) console.error(error);
    return { ok: false, error: "Network error" };
  }
}

function fmt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return number.toFixed(number >= 10 ? 0 : 1);
}

function bytes(value) {
  const gb = Number(value || 0) / 1024 / 1024 / 1024;
  return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
}

function shortNumber(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1)}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return String(number);
}

function trim(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function time(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
