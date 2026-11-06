/** Editor rejection/unknown delivery keeps the modal draft and original command. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1600, height: 1000 } });
await page.addInitScript(() => {
  try { localStorage.setItem("opendirector.modelSetup.v1", "dismissed"); } catch {}
});
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  const health = await (
    await page.request.get(base + "/api/creation-test-health", {
      headers: { "X-OpenDirector-Request": "1" },
    })
  ).json();
  assert.equal(health.isolated, true);
  const pid = crypto.randomUUID();
  await page.request.post(base + `/api/creation/projects/${pid}/commands`, {
    headers: { "X-OpenDirector-Request": "1" },
    data: {
      projectId: pid,
      commandId: crypto.randomUUID(),
      type: "project.create",
      payload: { name: "Editor save " + pid.slice(0, 8) },
    },
  });
  await page.goto(base + `/ai-tool/ai-canvas/${pid}`);
  const saved = () => page.getByText("已保存到本机", { exact: true }).waitFor();
  const state = async () =>
    (
      await page.request.get(base + `/api/creation/projects/${pid}`, {
        headers: { "X-OpenDirector-Request": "1" },
      })
    ).json();
  await saved();
  await page.getByLabel("选择本地素材文件", { exact: true }).setInputFiles({
    name: "source.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNsYGhgIAUwkaR6VMOohiGlAQBCPQEgiSD+iQAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await page.waitForFunction(
    () => document.querySelector(".cw-image-preview")?.naturalWidth > 0,
  );
  await saved();
  const item = (await state()).canvasItems[0];
  async function open(layers = false) {
    await page
      .locator(`.react-flow__node[data-id="${item.id}"] .cw-node-title`)
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "编辑图片", exact: true }).click();
    await page.getByRole("combobox", { name: "裁剪比例" }).waitFor();
    if (layers)
      await page
        .getByRole("button", { name: "图层工作台", exact: true })
        .click();
  }
  async function lock(value) {
    await page.evaluate(
      async ({ pid, id, value }) => {
        const { request, json } = await import("/src/backend/api.ts");
        const s = await request(`/creation/projects/${pid}`),
          i = s.canvasItems.find((i) => i.id === id);
        const receipt = await request(
          `/creation/projects/${pid}/commands`,
          json("POST", {
            projectId: pid,
            commandId: crypto.randomUUID(),
            type: "canvas.update",
            expectedVersions: [
              { objectType: "canvas_item", id, revision: i.revision },
            ],
            payload: { itemId: id, locked: value },
          }),
        );
        if (receipt.status !== "applied") throw Error(JSON.stringify(receipt));
        const { creationClient } =
          await import("/src/backend/creationClient.ts");
        await creationClient(pid).refresh();
      },
      { pid, id: item.id, value },
    );
    await page.waitForFunction(({id, value}) => {
      const node = document.querySelector(`.react-flow__node[data-id="${id}"] .cw-node`);
      return node && node.classList.contains("cw-node-locked") === value;
    }, {id: item.id, value});
  }
  // A real server lock arrives after the editor's version basis was captured.
  await open();
  await page.getByRole("slider", { name: /亮度/ }).press("End");
  await lock(true);
  await page.getByRole("button", { name: "应用编辑", exact: true }).click();
  await page.getByText(/无法应用编辑/).waitFor();
  assert.equal(
    await page.getByRole("slider", { name: /亮度/ }).inputValue(),
    "200",
  );
  assert.equal((await state()).editorDocuments.length, 0);
  await lock(false);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await saved();
  console.log(
    "PASS crop rejection keeps draft and leaves authoritative content unchanged",
  );
  await open(true);
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .getByLabel("图层文字内容", { exact: true })
    .fill("Keep this layer draft");
  await lock(true);
  await page.getByRole("button", { name: "应用到画布", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page.getByLabel("图层文字内容", { exact: true }).inputValue(),
    "Keep this layer draft",
  );
  assert.equal((await state()).editorDocuments.length, 0);
  await lock(false);
  await page.getByRole("button", { name: "关闭图层工作台" }).click();
  await saved();
  console.log("PASS layer rejection keeps layer contents");
  await open();
  await page.getByRole("slider", { name: /亮度/ }).press("End");
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const bodies = [];
  let unknown = true,
    started = false;
  await page.route("**/commands", async (route) => {
    const body = route.request().postDataJSON();
    if (!body.payload?.operations?.some((op) => op.type === "canvas.applyEdit"))
      return route.continue();
    bodies.push(body);
    started = true;
    await gate;
    const result = await route.fetch();
    if (unknown) await route.abort("failed");
    else await route.fulfill({ response: result });
  });
  await page.route("**/receipts/*", (route) =>
    unknown ? route.abort("failed") : route.continue(),
  );
  await page.getByRole("button", { name: "应用编辑", exact: true }).click();
  while (!started) await page.waitForTimeout(25);
  assert.equal(
    await page.getByRole("combobox", { name: "裁剪比例" }).count(),
    1,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "正在应用…", exact: true })
      .isDisabled(),
    true,
  );
  release();
  await page.getByText(/无法应用编辑/).waitFor();
  const first = (await state()).editorDocuments.find(
    (d) => d.kind === "image_crop",
  );
  assert.ok(first);
  unknown = false;
  await page.getByRole("button", { name: "应用编辑", exact: true }).click();
  await page
    .getByRole("combobox", { name: "裁剪比例" })
    .waitFor({ state: "hidden" });
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(
    (await state()).editorDocuments.find((d) => d.id === first.id).revision,
    first.revision,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS delayed acknowledgement and unknown response keep the draft; retry replays exactly once",
  );
} catch (error) {
  console.error(await page.locator("body").innerText());
  console.error({errors});
  throw error;
} finally {
  await browser.close();
}
