import { chromium } from "playwright-core";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const edgePaths = [
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "usageview-test-"));
  process.env.LIQUID_STATS_DATA_DIR = dataDir;
  process.env.PORT = "8899";
  const { startLiquidStatsServer } = await import("../src/server.js");
  const { server, port } = await startLiquidStatsServer({ host: "127.0.0.1", port: 8899 });

  const executablePath = edgePaths.find((path) => existsSync(path));
  assert(executablePath, "Microsoft Edge or Chrome was not found for the UI test");

  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 760, height: 760 } });

  try {
    await page.goto(`http://127.0.0.1:${port}/setup`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Onboarding" }).waitFor();
    await page.getByText("Your private display").waitFor();
    await page.getByText("read-only dashboard").waitFor();

    await page.getByRole("button", { name: "Next" }).click();
    await page.getByText("Display access").waitFor();
    await page.locator("#viewerKey").fill("my-custom-display-key");
    await page.waitForFunction(async () => {
      const status = await fetch("/api/setup/status").then((res) => res.json());
      return status.viewerKey === "my-custom-display-key";
    });
    const displayUrl = await page.locator("#displayUrl").inputValue();
    assert(displayUrl.includes("?key=my-custom-display-key"), "Display URL does not include the custom display key");

    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("heading", { name: "Widgets" }).waitFor();
    await page.getByText("Codex usage reads local Codex logs").waitFor();
    await page.locator('[data-widget="spotify"]').uncheck();
    await page.locator('[data-widget-label="codex"]').fill("Usage");
    await page.getByRole("button", { name: /Change CPU size/i }).click();
    await page.getByRole("button", { name: /Move CPU up/i }).click();

    await page.getByRole("button", { name: "Next" }).click();
    await page.getByText("Music").waitFor();
    await page.getByText("Redirect URI", { exact: true }).waitFor();
    await page.getByText(`http://127.0.0.1:${port}/api/setup/spotify/callback`).waitFor();
    await page.locator("#spotifyClientId").fill("test-client-id");
    await page.locator("#spotifyClientSecret").fill("test-client-secret");
    await page.waitForFunction(async () => {
      const status = await fetch("/api/setup/status").then((res) => res.json());
      return status.spotify.clientIdConfigured && status.spotify.clientSecretConfigured;
    });
    const connectDisabled = await page.locator("#spotifyConnect").evaluate((button) => button.classList.contains("is-disabled"));
    assert(connectDisabled === false, "Spotify Connect stayed disabled after Client ID and secret autosaved");

    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("heading", { name: "Refresh" }).waitFor();
    await page.locator("#refreshMs").fill("3000");
    await page.getByText("Roomy").click();
    await page.locator('label:has(input[name="dashboardWidth"][value="wide"])').click();
    await page.locator('label:has(input[name="glass"][value="deep"])').click();
    await page.locator('label:has(input[name="textScale"][value="large"])').click();
    await page.getByRole("button", { name: "Save setup" }).click();
    await page.getByText("Saved").waitFor();

    const status = await page.request.get(`http://127.0.0.1:${port}/api/setup/status`).then((res) => res.json());
    assert(status.setupComplete === true, "Setup did not save as complete");
    assert(status.config.refreshMs === 3000, "Refresh value did not save");
    assert(status.config.density === "roomy", "Density did not save");
    assert(status.config.dashboardWidth === "wide", "Dashboard width did not save");
    assert(status.config.glass === "deep", "Glass setting did not save");
    assert(status.config.textScale === "large", "Text size did not save");
    assert(status.config.widgets.some((widget) => widget.id === "codex" && widget.label === "Usage"), "Widget label did not save");
    assert(status.config.widgets.some((widget) => widget.id === "spotify" && widget.enabled === false), "Spotify hidden setting did not save");

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
    await page.getByText(/CPU|Usage|Memory/).first().waitFor();
    await page.getByText("prompts sent").waitFor();
    await assertDashboardFits(page, 760, 760);
    await assertDashboardFits(page, 420, 420);
    await assertDashboardFits(page, 360, 240);
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function assertDashboardFits(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(100);
  const box = await page.locator("#dashboardStage").boundingBox();
  assert(box, "Dashboard stage was not rendered");
  assert(box.x >= -1, `Dashboard overflows left at ${width}x${height}`);
  assert(box.y >= -1, `Dashboard overflows top at ${width}x${height}`);
  assert(box.x + box.width <= width + 1, `Dashboard overflows right at ${width}x${height}`);
  assert(box.y + box.height <= height + 1, `Dashboard overflows bottom at ${width}x${height}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
