// End-to-end: a permanent bar in one browser. Opening barkeeper still needs
// the sync server, but nothing here waits for another member.
//
// Needs Chromium; set CHROMIUM to its path if it is not /usr/bin/chromium.
// Run `npm run build` first.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { preview } from "vite";

// Not the port of the sync test, which runs at the same time.
const PORT = 4176;
const BASE = `http://localhost:${PORT}/`;
const BOOT_TIMEOUT = 90_000;

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

function ingredient(id, name, sizes, extra = {}) {
  return {
    id, name, baseUnit: "ml", units: [], ingredients: [], yield: 0, sizes,
    allergens: [], nonVeganIngredients: [], notes: "", safetyFactor: 0, abv: 0,
    color: "#e9ecef", hideInShoppingList: false, ...extra,
  };
}

function bottle(id, size, price) {
  return { id, size, sources: [{ id: `${id}-shop`, price, shopLink: "shop" }] };
}

function cocktail(id, name, ingredients) {
  return {
    id, name, ingredients: ingredients.map(([ingredientId, amount]) => ({ id: ingredientId, unit: "ml", amount })),
    garnishes: [], notes: "", cubes: 0, crushed: 0, largeCubes: 0, cubesServing: 0, crushedServing: 0,
    largeCubesServing: 0, method: undefined, glass: undefined, event: "null", numToPrep: 0, price: 0, flavorCues: [],
  };
}

// Last Word and Closing Argument share everything but the base spirit.
function homeBar() {
  const shared = [["chartreuse", 22.5], ["maraschino", 22.5], ["lime", 22.5]];
  return {
    cocktails: [
      cocktail("last-word", "Last Word", [["gin", 22.5], ...shared]),
      cocktail("closing-argument", "Closing Argument", [["mezcal", 22.5], ...shared]),
    ],
    ingredients: [
      ingredient("gin", "Gin", [bottle("gin-700", 700, 20), bottle("gin-1000", 1000, 24)]),
      ingredient("mezcal", "Mezcal", [bottle("mezcal-700", 700, 40)]),
      ingredient("chartreuse", "Green Chartreuse", [bottle("chartreuse-700", 700, 45)]),
      ingredient("maraschino", "Maraschino", [bottle("maraschino-700", 700, 30)]),
      ingredient("lime", "Lime juice", []),
    ],
    events: [],
    glassTypes: [],
    settings: { mode: "popup", costDistRange: [50, 200], costDistMinimaNum: 5, costDistMinimaThreshold: 7, unitConvTable: [] },
  };
}

async function openBar(data) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(BASE);
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: BOOT_TIMEOUT });

  await openTab(page, "settings");
  const chooser = page.waitForEvent("filechooser");
  await page.locator("button", { hasText: "import as new space" }).click();
  const reloaded = page.waitForEvent("load", { timeout: BOOT_TIMEOUT });
  await (await chooser).setFiles({
    name: "Home bar.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
  await reloaded;
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: BOOT_TIMEOUT });
  return page;
}

async function openTab(page, name) {
  if (name === "settings") await page.locator("#header .nav-link").last().click();
  else await page.locator("#header .nav-link", { hasText: name }).click();
}

async function tabNames(page) {
  const names = await page.locator("#header .nav-link").evaluateAll((els) => els.map((e) => e.innerText.trim()));
  // The last tab is the settings gear.
  return names.slice(0, -1);
}

async function cocktailNames(page) {
  return page
    .locator("input[x-model='cocktail.name']")
    .evaluateAll((els) => els.map((e) => e.value));
}

async function card(page, name) {
  const index = (await cocktailNames(page)).indexOf(name);
  assert.notEqual(index, -1, `no card for ${name}`);
  return page.locator(".card:has(input[x-model='cocktail.name'])").nth(index);
}

test("drinks go on and off the menu of a permanent bar", { timeout: 5 * 60_000 }, async () => {
  const page = await openBar(homeBar());
  assert.deepEqual(await tabNames(page), ["Ideas", "Ingredients"]);

  await openTab(page, "settings");
  await page.locator("#bar-mode-bar").check();
  assert.deepEqual(await tabNames(page), ["Menu", "Repertoire", "Stock", "Ingredients"]);

  await openTab(page, "Repertoire");
  assert.deepEqual((await cocktailNames(page)).sort(), ["Closing Argument", "Last Word"]);
  assert.equal(await page.locator(".costDistChart").count(), 0);
  // 22.5 ml each of gin at 24 €/l, chartreuse at 45 €/700 ml, maraschino at
  // 30 €/700 ml, and lime juice without a price.
  const serve = await (await card(page, "Last Word")).locator(".serve-cost").innerText();
  assert.match(serve, /Cost per serve: 2,95\s€/);
  assert.match(serve, /Without a price: Lime juice/);

  await (await card(page, "Last Word")).locator(".on-menu").click();
  assert.deepEqual(await cocktailNames(page), ["Closing Argument"]);
  await openTab(page, "Menu");
  assert.deepEqual(await cocktailNames(page), ["Last Word"]);

  // A new cocktail on the menu tab starts on the menu.
  const search = page.locator("input[placeholder='search cocktails...']");
  await search.fill("Naked and Famous");
  await page.locator("button", { hasText: "New Cocktail" }).click();
  await search.fill("");
  assert.deepEqual(await cocktailNames(page), ["Naked and Famous", "Last Word"]);

  // Bar mode survives a reload and opens on the menu.
  await page.evaluate(async () => {
    window.barkeeper.session.flush();
    await window.barkeeper.ark.repo.flush();
  });
  await page.reload();
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: BOOT_TIMEOUT });
  assert.deepEqual(await cocktailNames(page), ["Naked and Famous", "Last Word"]);

  // Switching back brings the popup tabs back.
  await openTab(page, "settings");
  await page.locator("#bar-mode-popup").check();
  assert.deepEqual(await tabNames(page), ["Ideas", "Ingredients"]);
  assert.deepEqual(page.errors, []);
});

function barMode(data) {
  data.settings.mode = "bar";
  return data;
}

async function setInput(locator, value) {
  await locator.fill(String(value));
  await locator.dispatchEvent("change");
}

// Alpine renders after a microtask, so read until the value settles.
async function eventually(read, expected, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  let actual;
  while (Date.now() < deadline) {
    actual = await read();
    if (typeof expected === "function" ? expected(actual) : actual === expected) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`expected ${expected}, got ${actual}`);
}

test("stock is counted in sizes plus a loose amount", { timeout: 5 * 60_000 }, async () => {
  const page = await openBar(barMode(homeBar()));
  await openTab(page, "Stock");
  const gin = page.locator(".stock-item[data-ingredient='gin']");
  const untracked = () => gin.locator(".badge", { hasText: "not tracked" }).isVisible();
  const total = () => gin.locator(".stock-total").innerText();
  const warns = async () => /text-danger/.test(await gin.locator(".stock-total").getAttribute("class"));
  await eventually(untracked, true);
  // Clearing an empty field does not start tracking.
  await setInput(gin.locator(".stock-loose"), "");
  await eventually(untracked, true);

  await setInput(gin.locator(".stock-count[data-size='700']"), 2.5);
  await eventually(untracked, false);
  await eventually(total, "1.750,00 ml");
  await setInput(gin.locator(".stock-loose"), 100);
  await eventually(total, "1.850,00 ml");

  await setInput(gin.locator(".stock-par"), 2000);
  await eventually(warns, true);
  await setInput(gin.locator(".stock-count[data-size='1000']"), 1);
  await eventually(total, "2.850,00 ml");
  await eventually(warns, false);

  // Removing a size keeps its bottles as loose stock.
  await openTab(page, "Ingredients");
  const ginCard = page.locator(".card:has(input[x-model='ingredient.name'])").filter({ has: page.locator("#sizes-gin") });
  await ginCard.locator(".ingredient-size").first().locator("button", { hasText: "✗" }).first().click();
  await openTab(page, "Stock");
  await eventually(() => gin.locator(".stock-count").count(), 1);
  await eventually(() => gin.locator(".stock-loose").inputValue(), "1850");
  await eventually(total, "2.850,00 ml");

  await gin.locator(".stop-tracking").click();
  await eventually(untracked, true);
  // The minimum stays.
  assert.equal(await gin.locator(".stock-par").inputValue(), "2000");
  assert.deepEqual(page.errors, []);
});

test("the stock decides how many of each cocktail can be made", { timeout: 5 * 60_000 }, async () => {
  const data = barMode(homeBar());
  data.bar = {
    cocktails: { "last-word": { onMenu: true } },
    stock: { gin: { counts: { "gin-700": 1 } }, chartreuse: { loose: 180 } },
    par: {},
  };
  const page = await openBar(data);
  await openTab(page, "Stock");
  const row = (id) => page.locator(`.makeable-list [data-cocktail='${id}']`);
  await eventually(() => row("last-word").innerText(), (text) => /on the menu/.test(text) && /Green Chartreuse runs out first\s+8$/.test(text));
  await eventually(() => row("closing-argument").locator(".makeable-count").innerText(), "8");

  await setInput(page.locator(".stock-item[data-ingredient='mezcal'] .stock-loose"), 45);
  await eventually(() => row("closing-argument").innerText(), (text) => /Mezcal runs out first\s+2$/.test(text));

  await openTab(page, "Menu");
  const lastWord = await card(page, "Last Word");
  assert.equal(await lastWord.locator(".makeable-count").innerText(), "8");
  assert.equal(await lastWord.locator(".makeable-limiting").innerText(), "Green Chartreuse runs out first.");
  assert.deepEqual(page.errors, []);
});
