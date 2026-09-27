import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

// UNI-MOBILE-IMPL board §15: the real app (Vite dev build of src) in real
// Chromium, API mocked at the network layer. Skips when playwright is missing.
// EVIDENCE_DIR=<dir> additionally writes light/dark screenshots.
const playwrightPath = process.env.PLAYWRIGHT_PATH ?? resolve("../../node_modules/playwright");
const skip = existsSync(playwrightPath) ? false : "playwright not installed";
const evidence = process.env.EVIDENCE_DIR;

const now = new Date().toISOString();
const row = (id: number, name: string, mimeType: string, size: number, source = "generated") => ({
  id, fileId: `f${id}`, storageNamespace: "ns", userId: 1, conversationId: 128, name, mimeType, size,
  status: "active", source, createdAt: now, updatedAt: now, ...(source === "app-link" ? { appUrl: "https://app.example.test/board" } : {}),
});
const items = [
  row(1, "AI Agent 竞品分析报告-一个很长很长的文件名称用于测试省略.pdf", "application/pdf", 2_516_582),
  row(2, "Q3 季度汇报.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", 8_493_465),
  row(3, "数据看板", "", 0, "app-link"),
  row(4, "notes.txt", "text/plain", 12_000, "upload"),
];

/* eslint-disable @typescript-eslint/no-explicit-any */
let browser: any;
let server: any;
let origin = "";

before(async () => {
  if (skip) return;
  const { createServer } = await import("vite");
  server = await createServer({ logLevel: "silent", server: { port: 0, strictPort: false, hmr: false, watch: null } });
  await server.listen();
  const address = server.httpServer.address();
  origin = `http://127.0.0.1:${address.port}`;
  const { chromium } = createRequire(import.meta.url)(playwrightPath);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function open(width: number, colorScheme: "light" | "dark" = "light", search = "") {
  const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme, reducedMotion: "reduce", hasTouch: width < 1024, locale: "zh-CN" });
  await context.addInitScript(() => {
    localStorage.setItem("nucleagent_access_token", "fixture-token");
    localStorage.setItem("nucleagent_locale", "zh");
  });
  const envelope = (data: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, message: "ok", data }) });
  await context.route("**/api/v1/deliverables?**", (route: any) => route.fulfill(envelope({ items, hasMore: false, nextBeforeId: 0 })));
  await context.route("**/api/v1/deliverables/*/download", (route: any) => route.fulfill(envelope({ url: `${origin}/fixture-file.txt` })));
  // Presign never answers: the upload stays visibly in flight.
  await context.route("**/api/v1/deliverables/uploads/presign", () => undefined);
  await context.route("**/fixture-file.txt", (route: any) => route.fulfill({ status: 200, contentType: "text/plain", body: "fixture preview text" }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`${origin}/deliverables${search}`);
  await page.locator(".file-cell:visible").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors };
}

// Every visible, enabled control must be a >= 44x44 target; the page must not scroll sideways.
async function audit(page: any) {
  return page.evaluate(() => {
    const root = document.getElementById("deliverables-app")!;
    const overflow = Math.max(document.documentElement.scrollWidth, root.scrollWidth) - window.innerWidth;
    const small = [...document.querySelectorAll("button, input, select, a[href]")].flatMap((node) => {
      const element = node as HTMLElement;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width <= 1 || rect.height <= 1 || style.visibility === "hidden" || element.closest("[aria-hidden=true]")) return [];
      return rect.width + 0.5 < 44 || rect.height + 0.5 < 44 ? [`${element.tagName}.${element.className} "${element.textContent?.trim().slice(0, 20)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`] : [];
    });
    const smallInputs = [...document.querySelectorAll("input:not([type=file])")].flatMap((node) => {
      const element = node as HTMLElement;
      if (element.getBoundingClientRect().width <= 1) return [];
      const size = parseFloat(getComputedStyle(element).fontSize);
      return size < 16 ? [`${element.className} ${size}px`] : [];
    });
    return { overflow, small, smallInputs };
  });
}

async function shot(page: any, name: string, width: number, scheme: string) {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `deliverables-${name}-${width}-${scheme}.png`) });
}

for (const width of [393, 360, 320]) {
  test(`phone layout at ${width}px: list, add sheet, row menu, preview, upload`, { skip }, async () => {
    for (const scheme of evidence ? ["light", "dark"] as const : ["light"] as const) {
      const { context, page, errors } = await open(width, scheme);
      try {
        const check = async (label: string) => {
          const result = await audit(page);
          assert.ok(result.overflow <= 0, `${label}: horizontal overflow ${result.overflow}px`);
          assert.deepEqual(result.small, [], `${label}: targets under 44px`);
          assert.deepEqual(result.smallInputs, [], `${label}: inputs under 16px`);
        };
        // ① list
        assert.equal(await page.locator(".primary-actions").isVisible(), false);
        assert.equal(await page.locator("table").isVisible(), false);
        assert.equal(await page.locator("input[type=date]").first().isVisible(), false);
        assert.equal(await page.locator(".chip").count(), 5);
        assert.equal(await page.locator(".mobile-row").count(), items.length);
        const rowBox = await page.locator(".mobile-row").first().boundingBox();
        assert.ok(Math.round(rowBox.height) >= 64 && rowBox.height < 72, `row height ${rowBox.height}`);
        const searchBox = await page.locator(".search-field").boundingBox();
        assert.equal(Math.round(searchBox.height), 40);
        await check("list");
        await shot(page, "list", width, scheme);

        // ② add sheet
        await page.locator(".add-button").click();
        const addRows = page.locator(".sheet-row");
        assert.deepEqual(await addRows.allTextContents(), ["上传文件", "从相册选择", "从 URL 导入", "添加应用链接", "取消"]);
        assert.equal(await page.locator("input[accept='image/*,video/*']").count(), 1);
        await check("add sheet");
        await shot(page, "add-sheet", width, scheme);
        await addRows.last().click();
        assert.equal(await page.locator(".sheet").count(), 0);

        // ⑤ row menu
        await page.locator(".more-button").first().click();
        assert.deepEqual(await page.locator(".sheet-row").allTextContents(), ["预览", "下载", "复制到对话…", "删除"]);
        assert.equal(await page.locator(".sheet-group").count(), 2);
        await check("row menu");
        await shot(page, "row-menu", width, scheme);
        await page.locator(".sheet-scrim").click({ position: { x: 10, y: 10 } });

        // ④ preview: full screen, share + download in the bottom bar
        await page.locator(".mobile-row .file-cell").nth(3).click();
        await page.waitForSelector(".text-preview");
        const card = await page.locator(".preview-card").boundingBox();
        assert.equal(Math.round(card.width), width);
        assert.deepEqual((await page.locator(".bar-button").allTextContents()).map((text: string) => text.trim()), ["分享", "下载"]);
        const bar = await page.locator(".preview-bar").boundingBox();
        assert.ok(bar.y + bar.height >= 799, "action bar sits at the bottom");
        await check("preview");
        await shot(page, "preview", width, scheme);
        await page.locator(".preview-card .icon-button").click();

        // ③ upload page (URL import shares the full-screen layout)
        await page.locator(".add-button").click();
        await page.locator(".sheet-row").nth(2).click();
        const dialog = await page.locator(".dialog-card").boundingBox();
        assert.equal(Math.round(dialog.width), width);
        await check("upload page");
        await shot(page, "upload", width, scheme);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  });
}

test("phone upload inside a conversation starts on pick with the owner locked", { skip }, async () => {
  const { context, page, errors } = await open(393, "light", "?conversationId=128");
  try {
    let presigned: any = null;
    page.on("request", (request: any) => { if (request.url().endsWith("/uploads/presign")) presigned = request.postDataJSON(); });
    await page.locator(".add-button").click();
    const chooser = page.waitForEvent("filechooser");
    await page.locator(".sheet-row").first().click();
    await (await chooser).setFiles({ name: "竞品清单.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fixture") });
    await page.locator(".dialog-card").waitFor();
    await page.waitForFunction(() => document.querySelector(".dialog-actions .primary")?.textContent?.includes("正在上传"));
    assert.equal(presigned?.conversationId, 128);
    assert.equal(presigned?.name, "竞品清单.pdf");
    assert.ok(await page.locator(".dialog-body input[inputmode=numeric]").isDisabled());
    assert.equal(await page.locator(".dialog-body input[inputmode=numeric]").inputValue(), "128");
    await shot(page, "uploading", 393, "light");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

for (const width of [1024, 1280]) test(`desktop at ${width}px keeps the table, three header buttons and all filters`, { skip }, async () => {
  const { context, page, errors } = await open(width);
  try {
    assert.equal(await page.locator(".primary-actions button").count(), 3);
    assert.ok(await page.locator(".primary-actions").isVisible());
    assert.ok(await page.locator("table").isVisible());
    assert.equal(await page.locator("input[type=date]:visible").count(), 2);
    assert.ok(await page.locator("select.filter-control").isVisible());
    for (const hidden of [".add-button", ".chips", ".mobile-list", ".more-button"]) {
      assert.equal(await page.locator(hidden).first().isVisible(), false, hidden);
    }
    await page.locator("table .file-cell").nth(3).click();
    await page.waitForSelector(".text-preview");
    assert.equal(await page.locator(".preview-bar").isVisible(), false);
    assert.ok(await page.locator(".preview-actions .button").isVisible());
    await shot(page, "desktop", width, "light");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
