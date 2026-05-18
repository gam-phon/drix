#!/usr/bin/env node
// Captures the viewer screenshots used on the landing page.
//
// Drives a headless Chrome over the DevTools Protocol — no npm dependencies,
// no image tooling (Chrome encodes WebP directly). Each shot opens the viewer
// in `?demo` mode so the grid is populated with the bundled sample file.
//
// Prerequisites:
//   1. npm run sample           (writes public/sample.parquet)
//   2. a running server, e.g.   npm run dev   or   npm run preview
//
// Usage:
//   DRIX_BASE_URL=http://localhost:5173 node scripts/capture-screenshots.mjs

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.DRIX_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT ?? 9333);

// Each feature tab gets a WebP shot; the `data` tab also gets smaller
// `data-1440` / `data-720` variants for the responsive hero <img> srcset, and
// `og` is a wider PNG for social cards. The page always renders at a 1440px
// CSS width — `scale` only changes the rasterised pixel density.
const SHOTS = [
  { name: "data", tab: "data", out: "public/shots/data.webp", format: "webp" },
  { name: "data-1440", tab: "data", out: "public/shots/data-1440.webp", format: "webp", scale: 1 },
  { name: "data-720", tab: "data", out: "public/shots/data-720.webp", format: "webp", scale: 0.5 },
  { name: "sql", tab: "sql", out: "public/shots/sql.webp", format: "webp" },
  { name: "info", tab: "info", out: "public/shots/info.webp", format: "webp", settle: 4500 },
  {
    name: "optimize",
    tab: "optimize",
    out: "public/shots/optimize.webp",
    format: "webp",
    run: true,
  },
  { name: "insight", tab: "insight", out: "public/shots/insight.webp", format: "webp", run: true },
  {
    name: "og",
    tab: "data",
    out: "public/og.png",
    format: "png",
    width: 1200,
    height: 630,
    scale: 1,
  },
];

// --- Minimal CDP client over a single (flattened) browser WebSocket --------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    });
  }
  send(method, params, sessionId) {
    const id = ++this.seq;
    const msg = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }
}

function once(target, event) {
  return new Promise((resolve, reject) => {
    target.addEventListener(event, resolve, { once: true });
    target.addEventListener("error", () => reject(new Error(`ws ${event} failed`)), { once: true });
  });
}

async function browserWebSocket(port) {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error("Chrome DevTools endpoint never came up");
}

async function evalExpr(cdp, session, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, session);
  return r.result?.value;
}

async function waitFor(cdp, session, expression, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await evalExpr(cdp, session, expression)) return;
    } catch {
      // page mid-navigation — retry
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function capture(cdp, shot) {
  const width = shot.width ?? 1440;
  const height = shot.height ?? 900;
  const scale = shot.scale ?? 2;
  console.log(`• ${shot.name} …`);

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send(
    "Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-color-scheme", value: "light" }] },
    sessionId,
  );
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: scale, mobile: false },
    sessionId,
  );

  await cdp.send("Page.navigate", { url: `${BASE}/parquet?demo&tab=${shot.tab}` }, sessionId);

  // The demo file has loaded once its alias shows in the sidebar and the
  // loading bar / "Reading…" message are gone.
  await waitFor(
    cdp,
    sessionId,
    "document.body.innerText.includes('sample.parquet') && " +
      "!document.querySelector('.drix-progress') && " +
      "!document.body.innerText.includes('Reading sample.parquet')",
    60000,
    `${shot.name}: sample file load`,
  );
  await sleep(shot.settle ?? 3000);

  // Optimize / Insight tabs need their analysis kicked off explicitly.
  if (shot.run) {
    const clicked = await evalExpr(
      cdp,
      sessionId,
      "(() => { const b = [...document.querySelectorAll('button.primary')]" +
        ".find((x) => /Compute statistics|Run analysis/.test(x.textContent));" +
        " if (b) { b.click(); return true; } return false; })()",
    );
    if (!clicked) throw new Error(`${shot.name}: run button not found`);
    await sleep(1000);
    await waitFor(
      cdp,
      sessionId,
      "/Re-compute statistics|Re-run analysis/.test(document.body.innerText)",
      90000,
      `${shot.name}: analysis to finish`,
    );
    await sleep(2000);
  }

  const { data } = await cdp.send(
    "Page.captureScreenshot",
    shot.format === "webp" ? { format: "webp", quality: 82 } : { format: "png" },
    sessionId,
  );
  writeFileSync(shot.out, Buffer.from(data, "base64"));
  console.log(`  ↳ ${shot.out}`);

  await cdp.send("Target.closeTarget", { targetId });
}

async function main() {
  mkdirSync("public/shots", { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "drix-cdp-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless",
      `--remote-debugging-port=${PORT}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
    ],
    { stdio: "ignore" },
  );

  try {
    const ws = new WebSocket(await browserWebSocket(PORT));
    await once(ws, "open");
    const cdp = new Cdp(ws);
    for (const shot of SHOTS) await capture(cdp, shot);
    ws.close();
    console.log("Done.");
  } finally {
    chrome.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
