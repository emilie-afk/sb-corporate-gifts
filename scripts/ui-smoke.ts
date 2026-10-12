// UI smoke test + review screenshots against the local preview server (LOCAL_DEV_LOGIN=1).
// Usage: npm run build && (LOCAL_DEV_LOGIN=1 DATABASE_URL=... npm run dev &) && npx tsx scripts/ui-smoke.ts
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:8888";
const OUT = process.env.SHOT_DIR ?? "screenshots";
mkdirSync(OUT, { recursive: true });
const NAME = "UI smoke test";
const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push([name, ok, detail]); };

async function sign(page: Page) {
  const f = page.getByLabel("Your name").last();
  await f.fill(NAME);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
page.on("pageerror", (e) => check("no page errors", false, e.message));

// ---- Marketplaces list
await page.goto(BASE);
await page.getByRole("heading", { name: "Marketplaces" }).waitFor();
await page.locator("tbody tr").first().waitFor();
const rows = await page.locator("tbody tr").count();
check("default list shows 8 working providers", rows === 8, `${rows} rows`);
await page.screenshot({ path: `${OUT}/01-marketplaces-desktop.png`, fullPage: true });

// ---- Detail panel + milestone done
await page.getByRole("button", { name: "Reachdesk" }).click();
await page.getByRole("dialog").getByText("Setup checklist").waitFor();
await page.getByRole("button", { name: "Mark done" }).first().click();
await sign(page);
await page.getByRole("dialog", { name: "Mark done" }).getByRole("button", { name: "Save" }).click();
await page.getByText(`Done by ${NAME}`).waitFor();
check("milestone done records typed name", true);
const prog = await page.locator(".section", { hasText: "Setup checklist" }).locator(".count").first().innerText();
check("progress updates to 1 / 6", prog.trim() === "1 / 6", prog);
await page.screenshot({ path: `${OUT}/02-marketplace-detail.png`, fullPage: false });

// ---- Not applicable requires reason (client shows server validation)
await page.getByRole("button", { name: "N/A" }).first().click();
await sign(page);
await page.getByRole("dialog", { name: "Mark not applicable" }).getByRole("button", { name: "Save" }).click();
await page.getByText("A brief reason is required").waitFor();
check("N/A without reason shows actionable error and keeps form", true);
await page.getByRole("dialog", { name: "Mark not applicable" }).getByRole("button", { name: "Cancel" }).click();

// ---- Communication note
await page.getByRole("button", { name: "Add communication" }).click();
await page.getByLabel("Summary").fill("Example only (screenshot): emailed former contact about reactivating the vendor account.");
await sign(page);
await page.getByRole("dialog", { name: "Add communication" }).getByRole("button", { name: "Save" }).click();
await page.getByText("Example only (screenshot)").waitFor();
check("communication saved and listed", true);
await page.getByRole("button", { name: "Close" }).first().click();

// ---- Status change to On hold → hidden, toggle shows muted
await page.getByRole("button", { name: "Snappy" }).click();
await page.getByRole("button", { name: "Change status" }).click();
await page.getByLabel("New status").selectOption("on_hold");
await sign(page);
await page.getByRole("dialog", { name: "Change status" }).getByRole("button", { name: "Save" }).click();
await page.getByText("A reason is required").waitFor();
check("inactive status requires reason", true);
await page.getByLabel("Reason").selectOption("fulfillment_requirement");
await page.getByLabel("Detail (optional)").fill("Example only: confirm 1–3 business-day dispatch first.");
await page.getByRole("dialog", { name: "Change status" }).getByRole("button", { name: "Save" }).click();
await page.getByRole("dialog").getByText("Reactivate").waitFor();
await page.getByRole("button", { name: "Close" }).first().click();
await page.waitForTimeout(300);
check("on-hold provider hidden from default list", (await page.locator("tbody tr", { hasText: "Snappy" }).count()) === 0);
await page.getByLabel("Show inactive marketplaces").check();
await page.locator("tr.muted-row", { hasText: "Snappy" }).waitFor();
check("toggle shows muted readable row with status label", (await page.locator("tr.muted-row", { hasText: "On hold" }).count()) === 1);
await page.screenshot({ path: `${OUT}/03-marketplaces-with-inactive.png`, fullPage: true });

// ---- Pricing: select a gift, then add Direct website pricing
await page.getByRole("tab", { name: "Pricing" }).click();
await page.getByRole("button", { name: "Gifts & collections" }).click();
await page.getByLabel("Selected for this dashboard only").uncheck();
await page.getByPlaceholder("Search name, variant, SKU").fill("Thank You Gift Box");
await page.locator("tbody tr", { hasText: "Thank You Gift Box — Simple" }).first().getByRole("button", { name: "Edit" }).click();
const gf = page.getByRole("dialog", { name: "Thank You Gift Box — Simple" });
await gf.getByLabel("Selected for use in this dashboard").check();
await gf.getByLabel("Internal family").selectOption("live_to_give_box");
await gf.getByLabel("Handwritten card eligible").selectOption("yes");
await sign(page);
await gf.getByRole("button", { name: "Save" }).click();
await page.getByLabel("Selected for this dashboard only").check();
await page.locator("tbody tr", { hasText: "Thank You Gift Box — Simple" }).waitFor();
await page.screenshot({ path: `${OUT}/04-gifts-panel.png` });
await page.getByRole("button", { name: "Close" }).first().click();

await page.getByRole("button", { name: "Add pricing record" }).click();
const pf = page.getByRole("dialog", { name: "Add pricing record" });
await pf.getByLabel("Channel").selectOption({ label: "Direct website" });
await pf.getByPlaceholder("Search gifts by name, variant or SKU").fill("Thank You Gift Box");
await pf.getByRole("button", { name: /Thank You Gift Box — Simple/ }).click();
await pf.getByLabel("Fulfillment format").selectOption("corporate_separate_addresses");
await pf.getByLabel("Customer discount %").fill("20");
await pf.getByText("Suggested customer price").waitFor();
const calc = await pf.locator(".calc").innerText();
check("direct suggested price = retail × (1 − 20%)", calc.includes("$26.10"), calc.split("\n")[0]);
await sign(page);
await pf.locator(".calc").scrollIntoViewIfNeeded();
await page.screenshot({ path: `${OUT}/05-pricing-form-direct.png` });
await pf.getByRole("button", { name: "Save" }).click();
await page.locator("tbody tr", { hasText: "Thank You Gift Box" }).waitFor();
const agreedCell = await page.locator("tbody tr", { hasText: "Thank You Gift Box" }).locator('td[data-label="Agreed selling"]').innerText();
check("suggested price not stored as agreed", agreedCell.trim() === "—", agreedCell);
await page.screenshot({ path: `${OUT}/06-pricing-table.png`, fullPage: true });

// ---- Pots + succulents: individual formats not offered
await page.getByRole("button", { name: "Add pricing record" }).click();
const pf2 = page.getByRole("dialog", { name: "Add pricing record" });
await pf2.getByLabel("Channel").selectOption({ label: "CorporateGift.com" });
await pf2.getByPlaceholder("Search gifts by name, variant or SKU").fill("With Succulent");
await pf2.getByRole("button", { name: /10-Pack \/ With Succulent/ }).click();
await pf2.getByText("Pots plus succulents: bulk only").waitFor();
const fmtOptions = await pf2.getByLabel("Fulfillment format").locator("option").allInnerTexts();
check("pots+succulents hides individual / separate-address formats", !fmtOptions.some((o) => o.startsWith("Individual") || o.includes("separate")), fmtOptions.join(", "));
await pf2.getByRole("button", { name: "Cancel" }).click();

// ---- Revenue form with missing vs zero
await page.getByRole("tab", { name: "Revenue" }).click();
await page.getByRole("button", { name: "Add monthly revenue" }).click();
const rf = page.getByRole("dialog", { name: "Add monthly revenue" });
await rf.getByLabel("Channel").selectOption({ label: "Direct website" });
await rf.getByLabel("Reporting month").fill("2026-09");
await rf.getByLabel("Order count").fill("2");
await rf.getByLabel("Gift units sold").fill("24");
await rf.getByLabel("Gift sales revenue (USD)").fill("626.40");
await rf.getByLabel("Customer shipping revenue (USD)").fill("0");
await rf.screenshot({ path: `${OUT}/07-revenue-form-missing.png` });
await rf.getByLabel("Refunds (USD)").fill("0");
await rf.getByLabel("Marketplace fees (USD)").fill("0");
await rf.getByLabel("Notes").fill("Example only (screenshot) — not real revenue.");
await sign(page);
await rf.getByRole("button", { name: "Save" }).click();
await page.locator("tbody tr", { hasText: "2026-09" }).waitFor();
await page.locator(".summary").waitFor();
const net = await page.locator(".summary").innerText();
check("revenue totals include saved record", net.includes("$626.40"), net.split("\n").slice(0, 2).join(" "));
// duplicate month+channel blocked with actionable message
await page.getByRole("button", { name: "Add monthly revenue" }).click();
const rf2 = page.getByRole("dialog", { name: "Add monthly revenue" });
await rf2.getByLabel("Channel").selectOption({ label: "Direct website" });
await rf2.getByLabel("Reporting month").fill("2026-09");
await sign(page);
await rf2.getByRole("button", { name: "Save" }).click();
await rf2.getByText("already exists for this channel and month").waitFor();
check("duplicate channel/month blocked; form input kept", (await rf2.getByLabel("Reporting month").inputValue()) === "2026-09");
await rf2.getByRole("button", { name: "Cancel" }).click();
await page.screenshot({ path: `${OUT}/08-revenue.png`, fullPage: true });

// ---- Mobile
const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
await m.goto(BASE);
await m.locator("tbody tr").first().waitFor();
await m.screenshot({ path: `${OUT}/09-mobile-marketplaces.png`, fullPage: true });
const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
check("mobile: no horizontal page scroll", !overflow);
await m.getByRole("button", { name: "Snappy" }).count().then(async (n) => n || (await m.getByLabel("Show inactive marketplaces").check()));
await m.getByRole("button", { name: "Reachdesk" }).click();
await m.getByRole("dialog").getByText("Requirements").first().waitFor();
await m.screenshot({ path: `${OUT}/10-mobile-detail.png`, fullPage: false });
await m.goto(`${BASE}/?tab=pricing`);
await m.locator("tbody tr").first().waitFor();
await m.screenshot({ path: `${OUT}/11-mobile-pricing.png`, fullPage: true });
check("mobile pricing: no horizontal page scroll", !(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));

await browser.close();
let failed = 0;
for (const [n, ok, d] of results) { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); if (!ok) failed++; }
process.exit(failed ? 1 : 0);
