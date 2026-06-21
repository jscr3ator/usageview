import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = process.env.LIQUID_STATS_DATA_DIR || join(ROOT, "data");
const ENV_PATH = join(ROOT, ".env");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const SECRETS_PATH = join(DATA_DIR, "secrets.json");
const CODEX_COLLECTOR = join(ROOT, "scripts", "collect_codex.py");
const COOKIE_NAME = "liquid_stats_view";

loadDotEnv(ENV_PATH);
mkdirSync(DATA_DIR, { recursive: true });

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const spotifyStates = new Map();
let activePort = PORT;

let secrets = loadOrCreateSecrets();
let cpuSample = sampleCpu();
let gpuCache = { ts: 0, value: unavailable("GPU", "No GPU sample yet") };
let codexCache = { ts: 0, value: unavailable("Codex", "No Codex sample yet") };

export function createLiquidStatsServer() {
  return createServer(async (req, res) => {
  try {
    setSecurityHeaders(res);
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { ok: true, bootId: BOOT_ID, setupComplete: Boolean(secrets.setupComplete) });
    }

    if (url.pathname === "/api/setup" || url.pathname.startsWith("/api/setup/")) {
      if (!isLocalRequest(req)) return json(res, 403, { ok: false, error: "Setup is localhost only" });
      return handleSetupApi(req, res, url);
    }

    if (url.pathname.startsWith("/api/")) {
      if (req.method === "GET" && url.pathname === "/api/view/session") {
        return handleViewSession(req, res, url);
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        if (!isViewerAuthorized(req)) return json(res, 401, { ok: false, error: "Display key required" });
        return json(res, 200, publicConfig(readConfig()));
      }
      if (req.method === "GET" && url.pathname === "/api/stats") {
        if (!isViewerAuthorized(req)) return json(res, 401, { ok: false, error: "Display key required" });
        return json(res, 200, await collectStats());
      }
      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "")) {
        return json(res, 405, { ok: false, error: "Read-only display" });
      }
      return json(res, 404, { ok: false, error: "API route not found" });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return text(res, 405, "Method not allowed");
    }
    return serveStatic(url.pathname, res, req.method === "HEAD");
  } catch (error) {
    console.error(error);
    return json(res, 500, { ok: false, error: "Server error" });
  }
  });
}

export function startLiquidStatsServer({ port = PORT, host = HOST } = {}) {
  const server = createLiquidStatsServer();
  return new Promise((resolveStart, rejectStart) => {
    const onError = (error) => rejectStart(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      activePort = port;
      server.off("error", onError);
      console.log("");
      console.log("UsageView is running:");
      console.log(`  Setup:   http://localhost:${port}/setup`);
      console.log(`  Local:   http://localhost:${port}`);
      for (const item of networkUrls(port)) {
        console.log(`  Network: http://${item}:${port}`);
      }
      console.log("");
      resolveStart({ server, port, host });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startLiquidStatsServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function handleSetupApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/setup/status") {
    return json(res, 200, setupStatus());
  }
  if (req.method === "PUT" && url.pathname === "/api/setup") {
    const body = await readJsonBody(req, 32_000);
    if (body.__error) return json(res, body.__status || 400, { ok: false, error: body.__error });
    const nextConfig = sanitizeConfig(body.config || {});
    writeFileSync(CONFIG_PATH, JSON.stringify(nextConfig, null, 2) + "\n");

    const nextSecrets = { ...secrets, setupComplete: true };
    const viewerKey = String(body.viewerKey || "").trim();
    if (viewerKey.length < 8) {
      return json(res, 400, { ok: false, error: "Display key must be at least 8 characters" });
    }
    nextSecrets.viewerKey = viewerKey.slice(0, 128);

    const spotify = body.spotify || {};
    for (const [inputKey, outputKey] of [
      ["clientId", "spotifyClientId"],
      ["clientSecret", "spotifyClientSecret"],
      ["refreshToken", "spotifyRefreshToken"],
    ]) {
      const value = String(spotify[inputKey] || "").trim();
      if (value) nextSecrets[outputKey] = value;
    }

    secrets = saveSecrets(nextSecrets);
    return json(res, 200, setupStatus());
  }
  if (req.method === "POST" && url.pathname === "/api/setup/regenerate-key") {
    secrets = saveSecrets({ ...secrets, viewerKey: generateKey() });
    return json(res, 200, setupStatus());
  }
  if (req.method === "GET" && url.pathname === "/api/setup/spotify/connect") {
    return handleSpotifyConnect(res);
  }
  if (req.method === "GET" && url.pathname === "/api/setup/spotify/callback") {
    return handleSpotifyCallback(url, res);
  }
  return json(res, 404, { ok: false, error: "Setup route not found" });
}

function setupStatus() {
  const config = readConfig();
  return {
    ok: true,
    setupComplete: Boolean(secrets.setupComplete),
    viewerKey: secrets.viewerKey,
    localUrl: `http://localhost:${activePort}`,
    setupUrl: `http://localhost:${activePort}/setup`,
    redirectUri: spotifyRedirectUri(),
    networkUrls: networkUrls(activePort).map((ip) => ({
      host: ip,
      url: `http://${ip}:${activePort}`,
      keyedUrl: `http://${ip}:${activePort}/?key=${encodeURIComponent(secrets.viewerKey)}`,
    })),
    spotify: {
      clientIdConfigured: Boolean(secrets.spotifyClientId),
      clientSecretConfigured: Boolean(secrets.spotifyClientSecret),
      refreshTokenConfigured: Boolean(secrets.spotifyRefreshToken),
    },
    config,
  };
}

function handleViewSession(req, res, url) {
  const key = url.searchParams.get("key") || "";
  if (!verifyKey(key)) return json(res, 401, { ok: false, error: "Invalid display key" });
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(secrets.viewerKey)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 365}`
  );
  return json(res, 200, { ok: true });
}

function isViewerAuthorized(req) {
  if (isLocalRequest(req)) return true;
  const cookie = req.headers.cookie || "";
  const cookieKey = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  return verifyKey(cookieKey ? decodeURIComponent(cookieKey) : "");
}

function verifyKey(value) {
  const a = Buffer.from(String(value || ""));
  const b = Buffer.from(String(secrets.viewerKey || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

async function collectStats() {
  const [gpu, codex, spotify] = await Promise.all([collectGpu(), collectCodex(), collectSpotify()]);
  return {
    ok: true,
    bootId: BOOT_ID,
    now: new Date().toISOString(),
    system: collectSystem(),
    gpu,
    codex,
    spotify,
    config: publicConfig(readConfig()),
  };
}

function collectSystem() {
  const previous = cpuSample;
  const current = sampleCpu();
  cpuSample = current;
  const idle = current.idle - previous.idle;
  const total = current.total - previous.total;
  const percent = total > 0 ? clamp(100 - (idle / total) * 100, 0, 100) : 0;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  return {
    source: "OS counters",
    cpu: {
      percent: round(percent, 1),
      cores: os.cpus().length,
      model: os.cpus()[0]?.model || "CPU",
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      percent: round((usedMem / totalMem) * 100, 1),
    },
    uptimeSeconds: os.uptime(),
  };
}

function sampleCpu() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, value] of Object.entries(cpu.times)) {
      total += value;
      if (kind === "idle") idle += value;
    }
  }
  return { idle, total };
}

async function collectGpu() {
  if (Date.now() - gpuCache.ts < 3000) return gpuCache.value;
  const result = await execFile("nvidia-smi", [
    "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
    "--format=csv,noheader,nounits",
  ], 2500);
  if (!result.ok) {
    gpuCache = { ts: Date.now(), value: unavailable("GPU", "GPU telemetry unavailable") };
    return gpuCache.value;
  }
  const gpus = result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, util, used, total, temp] = line.split(",").map((item) => item.trim());
      return {
        name,
        percent: Number(util),
        memoryUsedMb: Number(used),
        memoryTotalMb: Number(total),
        memoryPercent: Number(total) > 0 ? round((Number(used) / Number(total)) * 100, 1) : null,
        temperatureC: Number(temp),
      };
    });
  gpuCache = { ts: Date.now(), value: { ok: true, source: "nvidia-smi", devices: gpus } };
  return gpuCache.value;
}

async function collectCodex() {
  if (Date.now() - codexCache.ts < 5000) return codexCache.value;
  const env = {
    ...process.env,
    CODEX_LOG_PATH: process.env.CODEX_LOG_PATH || join(os.homedir(), ".codex", "logs_2.sqlite"),
    CODEX_SESSIONS_PATH: process.env.CODEX_SESSIONS_PATH || join(os.homedir(), ".codex", "sessions"),
    CODEX_STATUS_PATH: process.env.CODEX_STATUS_PATH || join(os.homedir(), ".codex", "codex-status.json"),
    DISPLAY_TZ: process.env.DISPLAY_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
  const result = await execFile(process.env.PYTHON_CMD || "python", [CODEX_COLLECTOR], 9000, env);
  if (!result.ok) {
    codexCache = { ts: Date.now(), value: unavailable("Codex", result.stderr || "Could not read Codex usage") };
    return codexCache.value;
  }
  try {
    codexCache = { ts: Date.now(), value: JSON.parse(result.stdout) };
  } catch {
    codexCache = { ts: Date.now(), value: unavailable("Codex", "Codex collector returned invalid JSON") };
  }
  return codexCache.value;
}

async function collectSpotify() {
  const clientId = secrets.spotifyClientId || process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = secrets.spotifyClientSecret || process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = secrets.spotifyRefreshToken || process.env.SPOTIFY_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    return { ...unavailable("Spotify", "Not configured"), configured: false };
  }
  try {
    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    if (!tokenResponse.ok) throw new Error(`Token refresh failed: ${tokenResponse.status}`);
    const token = await tokenResponse.json();
    const playingResponse = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (playingResponse.status === 204) {
      return { ok: true, source: "Spotify Web API", playing: false, item: null };
    }
    if (!playingResponse.ok) throw new Error(`Now playing failed: ${playingResponse.status}`);
    const payload = await playingResponse.json();
    const item = payload.item || {};
    return {
      ok: true,
      source: "Spotify Web API",
      playing: Boolean(payload.is_playing),
      progressMs: payload.progress_ms ?? null,
      item: item.name
        ? {
            title: item.name,
            artists: (item.artists || []).map((artist) => artist.name).join(", "),
            album: item.album?.name || "",
            durationMs: item.duration_ms || null,
            image: item.album?.images?.[0]?.url || null,
          }
        : null,
    };
  } catch (error) {
    return unavailable("Spotify", error.message);
  }
}

function handleSpotifyConnect(res) {
  if (!secrets.spotifyClientId || !secrets.spotifyClientSecret) {
    return json(res, 400, { ok: false, error: "Save Spotify client ID and secret first" });
  }
  const state = generateKey();
  spotifyStates.set(state, Date.now() + 10 * 60 * 1000);
  const authorize = new URL("https://accounts.spotify.com/authorize");
  authorize.searchParams.set("client_id", secrets.spotifyClientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", spotifyRedirectUri());
  authorize.searchParams.set("scope", "user-read-currently-playing user-read-playback-state");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("show_dialog", "false");
  res.writeHead(302, { Location: authorize.toString(), "Cache-Control": "no-store" });
  res.end();
}

async function handleSpotifyCallback(url, res) {
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (error) return redirectSetup(res, `spotify=${encodeURIComponent(error)}`);
  if (!code || !state) return redirectSetup(res, "spotify=missing");
  const expiry = spotifyStates.get(state);
  spotifyStates.delete(state);
  if (!expiry || Date.now() > expiry) return redirectSetup(res, "spotify=expired");

  try {
    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${secrets.spotifyClientId}:${secrets.spotifyClientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: spotifyRedirectUri(),
      }),
    });
    const payload = await tokenResponse.json();
    if (!tokenResponse.ok || !payload.refresh_token) {
      throw new Error(payload.error_description || payload.error || `Spotify token exchange failed: ${tokenResponse.status}`);
    }
    secrets = saveSecrets({ ...secrets, spotifyRefreshToken: payload.refresh_token, setupComplete: true });
    return redirectSetup(res, "spotify=connected");
  } catch (callbackError) {
    return redirectSetup(res, `spotify=${encodeURIComponent(callbackError.message)}`);
  }
}

function redirectSetup(res, query) {
  res.writeHead(302, { Location: `/setup?${query}`, "Cache-Control": "no-store" });
  res.end();
}

function spotifyRedirectUri() {
  return `http://127.0.0.1:${activePort}/api/setup/spotify/callback`;
}

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return sanitizeConfig({});
  try {
    return sanitizeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  } catch {
    return sanitizeConfig({});
  }
}

function publicConfig(config) {
  return {
    refreshMs: config.refreshMs,
    density: config.density,
    dashboardWidth: config.dashboardWidth,
    glass: config.glass,
    textScale: config.textScale,
    showUpdatedAt: config.showUpdatedAt,
    widgets: config.widgets,
  };
}

function sanitizeConfig(input) {
  const defaults = defaultConfig();
  const allowedIds = new Set(defaults.widgets.map((widget) => widget.id));
  const provided = Array.isArray(input?.widgets) ? input.widgets : [];
  const byId = new Map(defaults.widgets.map((widget) => [widget.id, { ...widget }]));
  const ordered = [];
  for (const item of provided) {
    if (!allowedIds.has(item?.id) || ordered.some((widget) => widget.id === item.id)) continue;
    ordered.push({
      id: item.id,
      label: String(item.label || byId.get(item.id).label).slice(0, 24),
      enabled: item.enabled !== false,
      size: normalizeWidgetSize(item.size || byId.get(item.id).size),
    });
  }
  for (const item of defaults.widgets) {
    if (!ordered.some((widget) => widget.id === item.id)) ordered.push(item);
  }
  return {
    density: input?.density === "roomy" ? "roomy" : "compact",
    dashboardWidth: normalizeChoice(input?.dashboardWidth, ["compact", "standard", "wide"], defaults.dashboardWidth),
    glass: normalizeChoice(input?.glass, ["clear", "balanced", "deep"], defaults.glass),
    textScale: normalizeChoice(input?.textScale, ["small", "normal", "large"], defaults.textScale),
    showUpdatedAt: input?.showUpdatedAt !== false,
    refreshMs: clamp(Number(input?.refreshMs || defaults.refreshMs), 1000, 15000),
    widgets: ordered,
  };
}

function defaultConfig() {
  return {
    density: "compact",
    dashboardWidth: "standard",
    glass: "balanced",
    textScale: "normal",
    showUpdatedAt: true,
    refreshMs: 2500,
    widgets: [
      { id: "spotify", label: "Spotify", enabled: true, size: "wide" },
      { id: "codex", label: "Codex", enabled: true, size: "tall" },
      { id: "cpu", label: "CPU", enabled: true, size: "normal" },
      { id: "memory", label: "Memory", enabled: true, size: "normal" },
      { id: "gpu", label: "GPU", enabled: true, size: "normal" },
      { id: "clock", label: "Clock", enabled: true, size: "normal" },
    ],
  };
}

function normalizeWidgetSize(value) {
  return ["normal", "wide", "tall"].includes(value) ? value : "normal";
}

function normalizeChoice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function loadOrCreateSecrets() {
  if (existsSync(SECRETS_PATH)) {
    try {
      return normalizeSecrets(JSON.parse(readFileSync(SECRETS_PATH, "utf8")));
    } catch {
      return saveSecrets({});
    }
  }
  return saveSecrets({});
}

function normalizeSecrets(input) {
  return {
    setupComplete: Boolean(input?.setupComplete),
    viewerKey: String(input?.viewerKey || generateKey()),
    spotifyClientId: String(input?.spotifyClientId || ""),
    spotifyClientSecret: String(input?.spotifyClientSecret || ""),
    spotifyRefreshToken: String(input?.spotifyRefreshToken || ""),
  };
}

function saveSecrets(input) {
  const next = normalizeSecrets(input);
  writeFileSync(SECRETS_PATH, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

function generateKey() {
  return randomBytes(18).toString("base64url");
}

function serveStatic(pathname, res, headOnly) {
  const route = pathname === "/" || pathname === "/setup" ? "index.html" : pathname.replace(/^\/+/, "");
  const fullPath = resolve(join(PUBLIC_DIR, route));
  if (!fullPath.startsWith(PUBLIC_DIR) || !existsSync(fullPath)) {
    return text(res, 404, "Not found");
  }
  const type = mimeType(extname(fullPath));
  const cache = type.includes("html") || type.includes("css") || type.includes("javascript")
    ? "no-store"
    : "public, max-age=3600";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": cache });
  if (!headOnly) res.end(readFileSync(fullPath));
  else res.end();
}

function isLocalRequest(req) {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' https://i.scdn.co https://mosaic.scdn.co data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'");
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function text(res, status, payload) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(payload);
}

function readJsonBody(req, limit) {
  return new Promise((resolveBody) => {
    let raw = "";
    let finished = false;
    const finish = (payload) => {
      if (finished) return;
      finished = true;
      resolveBody(payload);
    };
    req.on("data", (chunk) => {
      if (finished) return;
      raw += chunk;
      if (raw.length > limit) {
        finish({ __error: "Request body too large", __status: 413 });
        req.destroy();
      }
    });
    req.on("end", () => {
      if (finished) return;
      try {
        finish(raw ? JSON.parse(raw) : {});
      } catch {
        finish({ __error: "Invalid JSON", __status: 400 });
      }
    });
    req.on("error", () => finish({ __error: "Request aborted", __status: 400 }));
  });
}

function execFile(file, args, timeoutMs, env = process.env) {
  return new Promise((resolveExec) => {
    const child = spawn(file, args, { windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveExec({ ok: false, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveExec({ ok: code === 0, stdout, stderr });
    });
  });
}

function unavailable(source, message) {
  return { ok: false, source, message };
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function networkUrls(port) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) urls.push(entry.address);
    }
  }
  return urls;
}

function mimeType(ext) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  }[ext] || "application/octet-stream";
}
