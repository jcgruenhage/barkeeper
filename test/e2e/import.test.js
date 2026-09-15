// End-to-end: importing recipes into a space that already has some of their
// ingredients, through the review screen.
//
// Needs Chromium; set CHROMIUM to its path if it is not /usr/bin/chromium.
// Run `npm run build` first.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { preview } from "vite";

// Not the port of the other e2e tests, which run at the same time.
const PORT = 4177;
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

function ingredient(id, name, extra = {}) {
  return {
    id, name, baseUnit: "ml", units: [], ingredients: [], yield: 0, sizes: [],
    allergens: [], nonVeganIngredients: [], notes: "", safetyFactor: 0.1, abv: 0,
    color: "#e9ecef", hideInShoppingList: false, ...extra,
  };
}

// A space that already has some of what the file brings, so that matching has
// something to do: Gin and Green Chartreuse by name, and a Lime that the file
// calls "Lime juice".
function homeBar() {
  return {
    cocktails: [],
    ingredients: [
      ingredient("gin", "Gin", { abv: 45 }),
      ingredient("chartreuse", "Green Chartreuse", { abv: 55 }),
      ingredient("lime", "Lime", { baseUnit: "pcs", units: [["oz", 1]] }),
    ],
    events: [],
    prepMethods: [
      { id: "37ead6e5-971c-418b-9c65-2eb9e717b49b", name: "stirred", dilutionFormula: "1" },
      { id: "f065e002-f9f0-4b58-8bc2-6b410cfdfa09", name: "shaken", dilutionFormula: "1" },
    ],
    glassTypes: [{ id: "8f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8", name: "Coupe", volume: 200 }],
    settings: {
      mode: "popup", costDistRange: [50, 200], costDistMinimaNum: 5,
      costDistMinimaThreshold: 7, unitConvTable: [["oz", "ml", 30]],
    },
  };
}

const recipes = {
  barkeeperImport: 1,
  cocktails: [
    {
      name: "Last Word",
      method: "shaken",
      glass: "Coupe",
      ingredients: [
        { name: "Gin", amount: 1, unit: "oz" },
        { name: "Maraschino", amount: 1, unit: "oz" },
        { name: "Green Chartreuse", amount: 1, unit: "oz" },
        { name: "Lime juice", amount: 1, unit: "oz" },
      ],
    },
    {
      name: "Daiquiri",
      method: "shaken",
      ingredients: [
        { name: "Rum", amount: 2, unit: "oz" },
        { name: "Lime juice", amount: 1, unit: "oz" },
        { name: "Simple syrup", amount: 0.5, unit: "oz" },
      ],
      garnishes: [{ name: "Lime juice", amount: 1, unit: "wedge" }],
    },
  ],
  ingredients: [
    { name: "Maraschino", abv: 32 },
    { name: "Rum", abv: 40 },
    { name: "Simple syrup", abv: 0 },
  ],
};

async function openBar(data) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(BASE);
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: BOOT_TIMEOUT });

  await openSettings(page);
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

const openSettings = (page) => page.locator("#header .nav-link").last().click();

async function startImport(page, file) {
  await openSettings(page);
  const chooser = page.waitForEvent("filechooser");
  await page.locator("button.import-extend").click();
  await (await chooser).setFiles({
    name: "recipes.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await page.waitForSelector("#import-review");
}

// The review rows of one section, as [name, selected decision] pairs.
function rows(page, section) {
  return page
    .locator(`#import-review .card[data-section="${section}"] tbody tr`)
    .evaluateAll((trs) =>
      trs.map((tr) => [
        tr.querySelector(".import-record-name").innerText.trim(),
        tr.querySelector("select").selectedOptions[0].innerText.trim(),
      ]),
    );
}

const data = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.Alpine.store("barkeeper").data)));

test("imports recipes into a space, matching what it already has", { timeout: 5 * 60_000 }, async () => {
  const page = await openBar(homeBar());
  await startImport(page, recipes);

  // Gin and Green Chartreuse are matched by name. Maraschino, Rum and Simple
  // syrup are new. "Lime juice" only resembles the space's "Lime", so it is
  // left for this screen to settle rather than guessed at.
  assert.deepEqual((await rows(page, "ingredients")).sort(), [
    ["Gin", "use Gin"],
    ["Green Chartreuse", "use Green Chartreuse"],
    ["Lime juice", "add as new: Lime juice"],
    ["Maraschino", "add as new: Maraschino"],
    ["Rum", "add as new: Rum"],
    ["Simple syrup", "add as new: Simple syrup"],
  ]);
  assert.deepEqual(await rows(page, "glassTypes"), [["Coupe", "use Coupe"]]);
  assert.deepEqual(await rows(page, "prepMethods"), [["shaken", "use shaken"]]);
  assert.deepEqual((await rows(page, "cocktails")).sort(), [["Daiquiri", "import"], ["Last Word", "import"]]);

  // The one row that needs a look is listed first and marked.
  await page.waitForSelector("#import-review .alert-warning:has-text('need a look')");
  const first = page.locator('#import-review .card[data-section="ingredients"] tbody tr').first();
  assert.equal((await first.locator(".import-record-name").innerText()).trim(), "Lime juice");
  assert.ok(await first.evaluate((tr) => tr.classList.contains("needs-review")));

  // Take the suggestion: "Lime juice" is the space's "Lime".
  await first.locator("select").selectOption({ label: "use Lime — looks close" });
  assert.ok(!(await first.evaluate((tr) => tr.classList.contains("needs-review"))));

  await page.locator("#import-review button.import-run").click();
  await page.waitForSelector("#import-review .alert-success");

  const after = await data(page);
  assert.deepEqual(after.ingredients.map((i) => i.name).sort(), [
    "Gin", "Green Chartreuse", "Lime", "Maraschino", "Rum", "Simple syrup",
  ]);
  // The ones it already had are untouched, down to their ids.
  assert.deepEqual(
    after.ingredients.filter((i) => ["gin", "chartreuse", "lime"].includes(i.id)),
    homeBar().ingredients,
  );

  const lastWord = after.cocktails.find((c) => c.name === "Last Word");
  const byName = Object.fromEntries(after.ingredients.map((i) => [i.name, i.id]));
  assert.deepEqual(lastWord.ingredients, [
    { id: "gin", amount: 1, unit: "oz" },
    { id: byName.Maraschino, amount: 1, unit: "oz" },
    { id: "chartreuse", amount: 1, unit: "oz" },
    { id: "lime", amount: 1, unit: "oz" },
  ]);
  assert.equal(lastWord.method, "f065e002-f9f0-4b58-8bc2-6b410cfdfa09");
  assert.equal(lastWord.glass, "8f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8");
  assert.equal(lastWord.event, "null");

  // Both cocktails agree on which record the lime is.
  const daiquiri = after.cocktails.find((c) => c.name === "Daiquiri");
  assert.equal(daiquiri.ingredients[1].id, "lime");
  assert.equal(daiquiri.garnishes[0].id, "lime");
  assert.equal(daiquiri.garnishes[0].unit, "wedge");

  await page.locator("#import-review button", { hasText: "Done" }).click();
  assert.equal(await page.locator("#import-review").count(), 0);

  // And it survives a reload, so it reached the document rather than the view.
  await page.evaluate(async () => {
    window.barkeeper.session.flush();
    await window.barkeeper.ark.repo.flush();
  });
  await page.reload();
  await page.waitForSelector("#boot-status", { state: "hidden", timeout: BOOT_TIMEOUT });
  const reloaded = await data(page);
  assert.deepEqual(reloaded.cocktails.map((c) => c.name).sort(), ["Daiquiri", "Last Word"]);
  assert.equal(reloaded.cocktails.find((c) => c.name === "Last Word").ingredients[0].id, "gin");

  assert.deepEqual(page.errors, []);
});

test("a second import of the same file adds nothing", { timeout: 5 * 60_000 }, async () => {
  const page = await openBar(homeBar());
  await startImport(page, recipes);
  await page.locator("#import-review button.import-run").click();
  await page.waitForSelector("#import-review .alert-success");
  await page.locator("#import-review button", { hasText: "Done" }).click();
  const once = await data(page);

  await startImport(page, recipes);
  // Both cocktails are already here, so both default to being left out, every
  // ingredient matches, and there is nothing left to import.
  assert.deepEqual((await rows(page, "cocktails")).sort(), [
    ["Daiquiri", "leave out"],
    ["Last Word", "leave out"],
  ]);
  assert.equal(await page.locator('#import-review .card[data-section="cocktails"] .badge:text("already in this space")').count(), 2);
  assert.deepEqual(
    (await rows(page, "ingredients")).map(([, decision]) => decision.startsWith("use ")),
    [true, true, true, true, true, true],
  );
  assert.ok(await page.locator("#import-review button.import-run").isDisabled());

  await page.locator("#import-review button", { hasText: "Cancel" }).click();
  assert.deepEqual(await data(page), once);
  assert.deepEqual(page.errors, []);
});

test("refuses a file it cannot read", { timeout: 5 * 60_000 }, async () => {
  const page = await openBar(homeBar());
  await openSettings(page);
  const chooser = page.waitForEvent("filechooser");
  await page.locator("button.import-extend").click();
  await (await chooser).setFiles({
    name: "notes.json",
    mimeType: "application/json",
    buffer: Buffer.from("this is not json"),
  });
  await page.waitForSelector("#import-review .alert-danger");
  assert.match(await page.locator("#import-review .alert-danger").innerText(), /not a JSON file/);
  assert.equal((await data(page)).cocktails.length, 0);
  assert.deepEqual(page.errors, []);
});
