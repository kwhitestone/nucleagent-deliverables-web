import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

// LD-DOWNLOAD-BUTTON: the 下载 buttons in real Chromium (Vite dev build, API mocked at the
// network layer). Every save must land as a real download whose bytes hash like the
// stored object, without opening any tab. Skips when playwright is missing.
const playwrightPath = process.env.PLAYWRIGHT_PATH ?? resolve("../../node_modules/playwright");
const skip = existsSync(playwrightPath) ? false : "playwright not installed";

const now = new Date().toISOString();
const row = (id: number, name: string, mimeType: string, source = "generated") => ({
  id, fileId: `f${id}`, storageNamespace: "ns", userId: 1, conversationId: 128, name, mimeType, size: 64,
  status: "active", source, createdAt: now, updatedAt: now, ...(source === "app-link" ? { appUrl: "https://app.example.test/board" } : {}),
});
const IMAGE = 21, VIDEO = 22, LINK = 23, BROKEN = 24;
const items = [row(IMAGE, "截图 1.png", "image/png"), row(VIDEO, "演示 视频.mp4", "video/mp4"), row(LINK, "数据看板", "", "app-link"), row(BROKEN, "坏文件.png", "image/png")];
const bytes = (id: number) => Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 31 + id) & 0xff));
const sha = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

/* eslint-disable @typescript-eslint/no-explicit-any */
let browser: any;
let server: any;
let origin = "";

before(async () => {
  if (skip) return;
  const { createServer } = await import("vite");
  server = await createServer({ logLevel: "silent", server: { port: 0, strictPort: false, hmr: false, watch: null } });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const { chromium } = createRequire(import.meta.url)(playwrightPath);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

/** Desktop page; file fetches (not <img>/<video> loads) wait for `release()` when `hold` is set. */
async function open(hold = false) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN", acceptDownloads: true });
  await context.addInitScript(() => {
    localStorage.setItem("nucleagent_access_token", "fixture-token");
    localStorage.setItem("nucleagent_locale", "zh");
  });
  const envelope = (data: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, message: "ok", data }) });
  const fetched: number[] = [];
  let release!: () => void;
  const gate = hold ? new Promise<void>((done) => { release = done; }) : Promise.resolve();
  await context.route("**/api/v1/deliverables?**", (route: any) => route.fulfill(envelope({ items, hasMore: false, nextBeforeId: 0 })));
  await context.route("**/api/v1/deliverables/*/download", (route: any) => {
    const id = Number(route.request().url().split("/").at(-2));
    return route.fulfill(envelope({ url: `${origin}/fixture-files/${id}?signature=fixture-only` }));
  });
  await context.route("**/fixture-files/**", async (route: any) => {
    const id = Number(new URL(route.request().url()).pathname.split("/").at(-1));
    const isSave = route.request().resourceType() === "fetch";
    if (isSave) { fetched.push(id); await gate; }
    if (id === BROKEN && isSave) return route.fulfill({ status: 403, contentType: "application/xml", body: "<Error/>" });
    return route.fulfill({ status: 200, contentType: items.find((item) => item.id === id)!.mimeType, body: bytes(id) });
  });
  await context.route("https://app.example.test/**", (route: any) => route.fulfill({ status: 200, contentType: "text/html", body: "app" }));
  const page = await context.newPage();
  const popups: string[] = []; // registered after our own page so only tabs opened by the app count
  context.on("page", (popup: any) => popups.push(popup.url()));
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  const downloads: any[] = [];
  page.on("download", (download: any) => downloads.push(download));
  await page.goto(`${origin}/deliverables`);
  await page.locator("tbody tr").first().waitFor();
  const rowButton = (id: number, label: string) =>
    page.locator("tbody tr").nth(items.findIndex((item) => item.id === id)).locator(".row-actions button", { hasText: label });
  return { context, page, errors, downloads, popups, fetched, release: () => release?.(), rowButton };
}

async function savedHash(download: any): Promise<string> {
  return sha(readFileSync(await download.path()));
}
const settle = (page: any) => page.waitForTimeout(300);

for (const [id, name] of [[IMAGE, "截图 1.png"], [VIDEO, "演示 视频.mp4"]] as const) {
  test(`${name}: row 下载 and preview 下载 both save the original bytes, no tab`, { skip }, async () => {
    const { context, page, errors, downloads, popups, rowButton } = await open();
    try {
      await rowButton(id, "下载").click();
      await page.waitForEvent("download");
      await rowButton(id, "预览").click();
      await page.locator(id === IMAGE ? "img.media-preview" : "video.media-preview").waitFor();
      await page.locator(".preview-actions button", { hasText: "下载" }).click();
      await page.waitForEvent("download");
      await page.setViewportSize({ width: 393, height: 800 }); // the phone bottom bar only shows on phones
      await page.locator(".preview-bar .bar-button", { hasText: "下载" }).click();
      await page.waitForEvent("download");
      assert.equal(downloads.length, 3);
      for (const download of downloads) {
        assert.equal(download.suggestedFilename(), name);
        assert.equal(await savedHash(download), sha(bytes(id)));
      }
      assert.deepEqual(popups, []);
      assert.equal(await page.locator(".download-error").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test("repeated clicks on one item share one fetch and save once", { skip }, async () => {
  const { context, page, downloads, popups, fetched, release, rowButton } = await open(true);
  try {
    for (let click = 0; click < 3; click += 1) await rowButton(IMAGE, "下载").click();
    await settle(page);
    release();
    await page.waitForEvent("download");
    await settle(page);
    assert.equal(downloads.length, 1);
    assert.deepEqual(fetched, [IMAGE]);
    assert.equal(await savedHash(downloads[0]), sha(bytes(IMAGE)));
    assert.deepEqual(popups, []);
  } finally {
    await context.close();
  }
});

test("closing the preview cancels only its own caller: the row save of the same file still lands", { skip }, async () => {
  const { context, page, downloads, popups, fetched, release, rowButton } = await open(true);
  try {
    await rowButton(VIDEO, "预览").click();
    await page.locator("video.media-preview").waitFor();
    await page.locator(".preview-actions button", { hasText: "下载" }).click(); // first caller: the preview
    await settle(page);
    // The dialog covers the table; press the row button the way a second entry point would.
    await rowButton(VIDEO, "下载").evaluate((button: HTMLButtonElement) => button.click());
    await page.locator(".preview-card .icon-button").click(); // preview leaves
    release();
    await page.waitForEvent("download");
    await settle(page);
    assert.equal(downloads.length, 1);
    assert.deepEqual(fetched, [VIDEO]);
    assert.equal(await savedHash(downloads[0]), sha(bytes(VIDEO)));
    assert.equal(await page.locator(".alert, [role=alert]").filter({ hasText: "下载失败" }).count(), 0);
    assert.deepEqual(popups, []);
  } finally {
    await context.close();
  }
});

test("cancel: closing the preview while its only save is in flight saves nothing and shows no error", { skip }, async () => {
  const { context, page, downloads, popups, fetched, release, rowButton } = await open(true);
  try {
    await rowButton(IMAGE, "预览").click();
    await page.locator("img.media-preview").waitFor();
    await page.locator(".preview-actions button", { hasText: "下载" }).click();
    await settle(page);
    assert.deepEqual(fetched, [IMAGE]);
    await page.locator(".preview-card .icon-button").click();
    release();
    await settle(page);
    assert.deepEqual([downloads.length, popups.length], [0, 0]);
    assert.equal(await page.getByText("下载失败").count(), 0);
  } finally {
    await context.close();
  }
});

test("failure: a refused file shows 下载失败, saves nothing, opens nothing; the next item still saves", { skip }, async () => {
  const { context, page, downloads, popups, rowButton } = await open();
  try {
    await rowButton(BROKEN, "下载").click();
    await page.getByText("下载失败").first().waitFor();
    await settle(page);
    assert.deepEqual([downloads.length, popups.length], [0, 0]);
    await rowButton(IMAGE, "下载").click();
    await page.waitForEvent("download");
    assert.equal(await savedHash(downloads[0]), sha(bytes(IMAGE)));
  } finally {
    await context.close();
  }
});

test("link entry: an app link opens its app and never requests a file download", { skip }, async () => {
  const { context, page, downloads, fetched, rowButton } = await open();
  try {
    assert.equal(await rowButton(LINK, "下载").count(), 0);
    const popup = context.waitForEvent("page");
    await rowButton(LINK, "打开应用").click(); // opens the preview card for the link
    await page.locator(".preview-actions button", { hasText: "打开应用" }).click();
    const opened = await popup;
    await opened.waitForLoadState();
    assert.match(opened.url(), /^https:\/\/app\.example\.test\/board/);
    await settle(page);
    assert.deepEqual([downloads.length, fetched.length], [0, 0]);
  } finally {
    await context.close();
  }
});
