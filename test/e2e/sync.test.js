// End-to-end: two browsers with separate storage share a space through the
// configured sync server (the public keyhive server by default).
//
// Needs Chromium; set CHROMIUM to its path if it is not /usr/bin/chromium.
// Run `npm run build` first.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { preview } from "vite";

const PORT = 4175;
const BASE = `http://localhost:${PORT}/`;
const SYNC_TIMEOUT = 60_000;

let server;
let browser;

before(async () => {
  server = await preview({ preview: { port: PORT, strictPort: true }, logLevel: "warn" });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
});

after(async () => {
  await browser?.close();
  server?.httpServer.close();
});

async function openClient(url = BASE) {
  const context = await browser.newContext();
  context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(url);
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: SYNC_TIMEOUT });
  return page;
}

async function openTab(page, name) {
  if (name === "settings") await page.locator("#header .nav-link").last().click();
  else await page.locator("#header .nav-link", { hasText: name }).click();
}

// "New Cocktail" names the cocktail after the search text, which then keeps
// filtering the list, so clear it again.
async function newCocktail(page, name) {
  const search = page.locator("input[placeholder='search cocktails...']");
  await search.fill(name);
  await page.locator("button", { hasText: "New Cocktail" }).click();
  await search.fill("");
}

async function cocktailNames(page) {
  return page
    .locator("input[x-model='cocktail.name']")
    .evaluateAll((els) => els.map((e) => e.value));
}

async function eventually(fn, message) {
  const deadline = Date.now() + SYNC_TIMEOUT;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.fail(message);
}

test("two members edit one space", { timeout: 5 * 60_000 }, async () => {
  const anna = await openClient();
  await openTab(anna, "settings");
  await anna.locator("#device-name").fill("Anna");
  await anna.locator("#device-name").dispatchEvent("change");
  await anna.locator("#space-name").fill("GPN crew");
  await anna.locator("#space-name").dispatchEvent("change");
  await eventually(
    async () => (await anna.locator(".space-switcher button").innerText()).includes("GPN crew"),
    "the rename did not show up",
  );

  await eventually(
    async () => anna.locator("button", { hasText: "Create invite link" }).isVisible(),
    "Anna is not shown as an admin",
  );
  await anna.locator("button", { hasText: "Create invite link" }).click();
  const link = await eventually(
    async () => (await anna.locator(".invite-link").count()) && anna.locator(".invite-link").inputValue(),
    "no invite link was created",
  );
  assert.match(link, /#invite=/);

  await openTab(anna, "Ideas");
  await newCocktail(anna, "Negroni");

  const ben = await openClient(link.replace(/^https?:\/\/[^/]+\//, BASE));
  assert.equal(await ben.locator(".space-switcher button").innerText(), "GPN crew");

  await openTab(ben, "Ideas");
  await eventually(
    async () => (await cocktailNames(ben)).includes("Negroni"),
    "Ben never saw Anna's cocktail",
  );

  // Both edit at the same time: Ben renames the cocktail, Anna adds another.
  await ben.locator("input[x-model='cocktail.name']").first().fill("Boulevardier");
  await newCocktail(anna, "Americano");

  const expected = ["Americano", "Boulevardier"];
  await eventually(
    async () => JSON.stringify((await cocktailNames(anna)).sort()) === JSON.stringify(expected),
    "Anna did not end up with both cocktails",
  );
  await eventually(
    async () => JSON.stringify((await cocktailNames(ben)).sort()) === JSON.stringify(expected),
    "Ben did not end up with both cocktails",
  );

  // Ben shows up by name in Anna's member list once he sets one.
  await openTab(ben, "settings");
  await ben.locator("#device-name").fill("Ben");
  await ben.locator("#device-name").dispatchEvent("change");
  await openTab(anna, "settings");
  await eventually(
    async () => (await anna.locator(".list-group-item", { hasText: "Ben" }).count()) > 0,
    "Ben's name never reached Anna",
  );

  assert.deepEqual(anna.errors.filter((e) => !e.includes("barProgram")), []);
  assert.deepEqual(ben.errors.filter((e) => !e.includes("barProgram")), []);
});

test("a cocktail can be copied into another space", { timeout: 3 * 60_000 }, async () => {
  const page = await openClient();
  await openTab(page, "Ideas");
  await newCocktail(page, "Last Word");
  await page.waitForTimeout(500);

  await openTab(page, "settings");
  await page.locator(".new-space-name").fill("MRMCD");
  await page.locator(".new-space-name").press("Enter");
  await page.waitForEvent("load", { timeout: SYNC_TIMEOUT });
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: SYNC_TIMEOUT });
  assert.equal(await page.locator(".space-switcher button").innerText(), "MRMCD");

  // Back to the first space, and copy the cocktail over.
  await page.locator(".space-switcher button").click();
  await page.locator(".dropdown-item", { hasText: "Home bar" }).click();
  await page.waitForEvent("load", { timeout: SYNC_TIMEOUT });
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: SYNC_TIMEOUT });
  await openTab(page, "Ideas");
  const card = page.locator(".card", { has: page.locator("input[x-model='cocktail.name']") }).first();
  await card.locator(".copy-to-space").selectOption({ label: "MRMCD" });
  await card.locator("button", { hasText: "Copy to space" }).click();
  await page.waitForTimeout(1000);

  await page.locator(".space-switcher button").click();
  await page.locator(".dropdown-item", { hasText: "MRMCD" }).click();
  await page.waitForEvent("load", { timeout: SYNC_TIMEOUT });
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: SYNC_TIMEOUT });
  await openTab(page, "Ideas");
  assert.deepEqual(await cocktailNames(page), ["Last Word"]);
});

test("data from before sync becomes the first space", { timeout: 2 * 60_000 }, async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    if (localStorage.getItem("barkeeper-spaces")) return;
    localStorage.setItem(
      "barkeeper",
      JSON.stringify({
        cocktails: [{ id: "c1", name: "Daiquiri", ingredients: [], garnishes: [], event: "null", flavorCues: [] }],
        ingredients: [],
        events: [],
        prepMethods: [],
        glassTypes: [],
        settings: { costDistRange: [50, 200], costDistMinimaNum: 5, costDistMinimaThreshold: 7, unitConvTable: [], darkMode: false },
      }),
    );
  });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: SYNC_TIMEOUT });
  assert.equal(await page.locator(".space-switcher button").innerText(), "Home bar");
  await openTab(page, "Ideas");
  assert.deepEqual(await cocktailNames(page), ["Daiquiri"]);
  await context.close();
});

test("barkeeper starts and keeps edits without a sync server", { timeout: 2 * 60_000 }, async () => {
  const { KEYHIVE_SYNC_SERVER_CONTACT_CARD_JSON, KEYHIVE_SYNC_SERVER_PEER_ID } = await import(
    "@automerge/automerge-repo-keyhive"
  ).catch(() => ({}));
  const context = await browser.newContext();
  await context.addInitScript(
    ([card, peerId]) => {
      localStorage.setItem(
        "barkeeper-sync-server",
        JSON.stringify({ endpoint: "ws://127.0.0.1:9", contactCardJson: card, peerId }),
      );
    },
    [KEYHIVE_SYNC_SERVER_CONTACT_CARD_JSON ?? "{}", KEYHIVE_SYNC_SERVER_PEER_ID ?? "x"],
  );
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: SYNC_TIMEOUT });
  await openTab(page, "Ideas");
  await newCocktail(page, "Offline Old Fashioned");
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: SYNC_TIMEOUT });
  await openTab(page, "Ideas");
  assert.deepEqual(await cocktailNames(page), ["Offline Old Fashioned"]);
  await context.close();
});

test("an exported space imports as a new space", { timeout: 2 * 60_000 }, async () => {
  const page = await openClient();
  await openTab(page, "Ideas");
  await newCocktail(page, "Paper Plane");
  await page.waitForTimeout(500);
  await openTab(page, "settings");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("button", { hasText: "export space" }).click(),
  ]);
  assert.equal(download.suggestedFilename(), "Home bar.json");
  const exported = JSON.parse(await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString()));
  assert.deepEqual(exported.cocktails.map((c) => c.name), ["Paper Plane"]);
  assert.ok(!("darkMode" in exported.settings) || typeof exported.settings.darkMode === "boolean");

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator("button", { hasText: "import as new space" }).click(),
  ]);
  await chooser.setFiles({
    name: "Imported.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await page.waitForEvent("load", { timeout: SYNC_TIMEOUT });
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: SYNC_TIMEOUT });
  assert.equal(await page.locator(".space-switcher button").innerText(), "Imported");
  await openTab(page, "Ideas");
  assert.deepEqual(await cocktailNames(page), ["Paper Plane"]);
});

test("a space with an event still starts", { timeout: 2 * 60_000 }, async () => {
  const page = await openClient();
  await openTab(page, "settings");
  await page.locator("input[x-model='newEvent']").fill("MRMCD 2026");
  await page.locator("input[x-model='newEvent']").press("Enter");
  await openTab(page, "MRMCD 2026");
  await newCocktail(page, "Espresso Martini");
  await page.locator("input[x-model\\.number='cocktail.numToPrep']").first().fill("50");
  await eventually(
    () =>
      page.evaluate(() =>
        Object.values(window.barkeeper.session.doc().rows).some(
          (row) => String(row['["name"]']) === "Espresso Martini" && row['["numToPrep"]'] === 50,
        ),
      ),
    "the cocktail was never written to the space",
  );

  await page.reload();
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: SYNC_TIMEOUT });
  await openTab(page, "MRMCD 2026");
  assert.deepEqual(await cocktailNames(page), ["Espresso Martini"]);
  assert.equal(
    await page.locator("input[x-model\\.number='cocktail.numToPrep']").first().inputValue(),
    "50",
  );
  // Upstream already throws on cocktails without a glass or prep method
  // (reading properties of undefined, and the bar sheet widths that fail
  // along with them). Anything else, like a strict mode ReferenceError, is new.
  const upstream = /^Cannot read properties of undefined|^(prepWidth|amountWidth|unitWidth) is not defined$/;
  assert.deepEqual(page.errors.filter((e) => !upstream.test(e)), []);
});

test("an import can replace the open space", { timeout: 2 * 60_000 }, async () => {
  const page = await openClient();
  await openTab(page, "Ideas");
  await newCocktail(page, "Old Pal");
  await page.waitForTimeout(500);
  await openTab(page, "settings");
  await page.locator("#space-name").fill("Home bar, replaced");
  await page.locator("#space-name").dispatchEvent("change");

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator("button", { hasText: "import replacing this space" }).click(),
  ]);
  // A file from an older version, without settings.
  await chooser.setFiles({
    name: "other.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        cocktails: [{ id: "c9", name: "Hanky Panky", ingredients: [], garnishes: [], event: "null", flavorCues: [] }],
        ingredients: [],
        events: [],
      }),
    ),
  });

  await openTab(page, "Ideas");
  await eventually(
    async () => JSON.stringify(await cocktailNames(page)) === JSON.stringify(["Hanky Panky"]),
    "the space was not replaced",
  );
  await page.reload();
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: SYNC_TIMEOUT });
  // Same space, same name, new contents.
  assert.equal(await page.locator(".space-switcher button").innerText(), "Home bar, replaced");
  await openTab(page, "Ideas");
  assert.deepEqual(await cocktailNames(page), ["Hanky Panky"]);
  await openTab(page, "settings");
  assert.equal(await page.locator(".list-group-item", { hasText: "open" }).count(), 1);
});

test("a space from before fixed prep method ids is upgraded when opened", { timeout: 2 * 60_000 }, async () => {
  const { STIRRED_ID, SHAKEN_ID } = await import("../../src/migrate.js");
  const page = await openClient();
  await openTab(page, "Ideas");
  await newCocktail(page, "Daiquiri");
  await page.waitForTimeout(1000);

  // Write the old ids straight into the document, as an earlier version would have.
  await page.evaluate(() => {
    const { session } = window.barkeeper;
    session.flush();
    session.handle.change((d) => {
      for (const row of Object.values(d.rows)) {
        const field = String(row.$f ?? "");
        if (field === '["prepMethods"]') row['["id"]'] = String(row['["name"]']) === "stirred" ? 0 : 1;
        if (field === '["cocktails"]') row['["method"]'] = 1;
      }
    });
  });
  const stored = () =>
    page.evaluate(() =>
      Object.values(window.barkeeper.session.doc().rows)
        .filter((row) => ['["prepMethods"]', '["cocktails"]'].includes(String(row.$f)))
        .map((row) => row['["id"]'] ?? null)
        .concat(
          Object.values(window.barkeeper.session.doc().rows)
            .filter((row) => String(row.$f) === '["cocktails"]')
            .map((row) => row['["method"]']),
        ),
    );
  assert.ok((await stored()).includes(0));

  await page.evaluate(() => window.barkeeper.spaces.persist());
  await page.reload();
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: SYNC_TIMEOUT });
  await eventually(async () => {
    const values = await stored();
    return values.includes(STIRRED_ID) && values.filter((v) => v === SHAKEN_ID).length === 2 &&
      !values.includes(0) && !values.includes(1);
  }, "the old prep method ids were not upgraded in the space");
});

test("an ingredient is copied to another space with its sub-recipes", { timeout: 3 * 60_000 }, async () => {
  const page = await openClient();
  const ingredient = (id, name, ingredients = []) => ({
    id, name, baseUnit: "ml", units: [], ingredients, yield: 0, sources: [], allergens: [],
    nonVeganIngredients: [], notes: "", safetyFactor: 0.1, abv: 0, color: "#e9ecef", hideInShoppingList: false,
  });
  const recipes = {
    cocktails: [],
    events: [],
    ingredients: [
      ingredient("5b0c7f0e-3f1c-4d63-9b1e-6f6f3c7a0001", "Simple syrup", [
        { id: "5b0c7f0e-3f1c-4d63-9b1e-6f6f3c7a0002", unit: "ml", amount: 500 },
        { id: "5b0c7f0e-3f1c-4d63-9b1e-6f6f3c7a0003", unit: "ml", amount: 500 },
      ]),
      ingredient("5b0c7f0e-3f1c-4d63-9b1e-6f6f3c7a0002", "Water"),
      ingredient("5b0c7f0e-3f1c-4d63-9b1e-6f6f3c7a0003", "Sugar"),
    ],
  };

  await openTab(page, "settings");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator("button", { hasText: "import as new space" }).click(),
  ]);
  await chooser.setFiles({ name: "Recipes.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(recipes)) });
  await page.waitForEvent("load", { timeout: SYNC_TIMEOUT });
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: SYNC_TIMEOUT });

  await openTab(page, "Ingredients");
  await page.locator("input[placeholder='search ingredients...']").fill("Simple");
  const copy = async () => {
    await page.locator(".copy-ingredient-to-space").selectOption({ label: "Home bar" });
    await page.locator("button", { hasText: "Copy to space" }).click();
    return eventually(async () => {
      const notice = page.locator(".space-notice");
      return (await notice.isVisible()) && notice.innerText();
    }, "no notice after copying");
  };
  assert.match(await copy(), /^Copied to Home bar/);
  assert.match(await copy(), /^Home bar already has this ingredient/);

  await page.locator(".space-switcher button").click();
  await page.locator(".dropdown-item", { hasText: "Home bar" }).click();
  await page.waitForEvent("load", { timeout: SYNC_TIMEOUT });
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: SYNC_TIMEOUT });
  await openTab(page, "Ingredients");
  const names = await page
    .locator("input[x-model='ingredient.name']")
    .evaluateAll((els) => els.map((e) => e.value).sort());
  assert.deepEqual(names, ["Simple syrup", "Sugar", "Water"]);
});
