// UI smoke test + review screenshots against the local preview server (LOCAL_DEV_LOGIN=1).
// Usage: npm run build && (LOCAL_DEV_LOGIN=1 DATABASE_URL=... npm run dev &) && npx tsx scripts/ui-smoke.ts
import { chromium, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
await page.getByRole("button", { name: "Demo Market Alpha" }).click();
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
await page.getByLabel("Summary").fill("Example only (screenshot): emailed the demo contact about a vendor account.");
await sign(page);
await page.getByRole("dialog", { name: "Add communication" }).getByRole("button", { name: "Save" }).click();
await page.getByText("Example only (screenshot)").waitFor();
check("communication saved and listed", true);
await page.getByRole("button", { name: "Close" }).first().click();

// ---- Status change to On hold → hidden, toggle shows muted
await page.getByRole("button", { name: "Demo Market Echo" }).click();
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
check("on-hold provider hidden from default list", (await page.locator("tbody tr", { hasText: "Demo Market Echo" }).count()) === 0);
await page.getByLabel("Show inactive marketplaces").check();
await page.locator("tr.muted-row", { hasText: "Demo Market Echo" }).waitFor();
check("toggle shows muted readable row with status label", (await page.locator("tr.muted-row", { hasText: "On hold" }).count()) === 1);
await page.screenshot({ path: `${OUT}/03-marketplaces-with-inactive.png`, fullPage: true });

// ---- Add marketplaces in bulk: names first, then tick a status per name
await page.getByRole("button", { name: "Add in bulk" }).click();
const bk = page.getByRole("dialog", { name: "Add marketplaces in bulk" });
await bk.getByLabel("Names").fill("1. Example Gifting One\n- Example Gifting Two\nDemo Market Delta\n\nExample Supplier Three");
check("bulk step 1 counts the pasted names (bullets/numbers removed)", (await bk.getByText("4 names").count()) === 1);
await page.screenshot({ path: `${OUT}/03b-bulk-add-names.png` });
await bk.getByRole("button", { name: "Next: choose statuses" }).click();
await bk.getByText("Step 2 of 2").waitFor();
check("bulk step 2 flags a name that already exists", (await bk.getByText(/Already exists as “Demo Market Delta”/).count()) === 1);
await bk.getByRole("button", { name: "Remove them" }).click();
await bk.getByRole("checkbox", { name: "Example Gifting Two: In discussion" }).check();
await bk.getByRole("checkbox", { name: "Example Supplier Three: Live" }).check();
await bk.getByLabel("Type of Example Supplier Three").selectOption("supplier_opportunity");
check("one status per name (ticking another unticks Prospect)", !(await bk.getByRole("checkbox", { name: "Example Gifting Two: Prospect" }).isChecked()));
await sign(page);
await page.screenshot({ path: `${OUT}/03c-bulk-add-statuses.png` });
await bk.getByRole("button", { name: "Add 3 marketplaces" }).click();
await page.getByText("3 marketplaces added.").waitFor();
check("bulk add saved 3 records with their statuses",
  (await page.locator("tbody tr", { hasText: "Example Gifting Two" }).innerText()).includes("In discussion"));

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

// ---- Inside a marketplace: propose several gifts by category, add several requirements
await page.getByRole("tab", { name: "Marketplaces" }).click();
await page.getByRole("button", { name: "Demo Market Alpha" }).click();
const det = page.getByRole("dialog").filter({ hasText: "Setup checklist" });
await det.getByRole("button", { name: "Propose several" }).click();
const bp = page.getByRole("dialog", { name: "Propose several products" });
await bp.getByRole("combobox", { name: /^Gift category/ }).selectOption("live_to_give_box");
await bp.getByRole("button", { name: "Next: review gifts" }).click();
await bp.getByText("Step 2 of 2").waitFor();
check("propose several: category finds the selected Live to Give gift", (await bp.getByRole("checkbox", { name: /Propose Thank You Gift Box — Simple/ }).isChecked()));
await sign(page);
await page.screenshot({ path: `${OUT}/03d-propose-several.png` });
await bp.getByRole("button", { name: /Propose 1 gift/ }).click();
await det.locator(".card", { hasText: "Thank You Gift Box — Simple" }).waitFor();
check("propose several: proposal saved on the marketplace", true);
await det.getByRole("button", { name: "Add several" }).click();
const br = page.getByRole("dialog", { name: "Add several requirements" });
await br.getByRole("textbox", { name: /^Requirements/ }).fill("- Example: ship within 2 business days\n- Example: branded packing slip\n- Example: ship within 2 business days");
await br.getByRole("combobox", { name: /^Category for all/ }).selectOption("fulfillment");
await br.getByRole("button", { name: "Next: set categories" }).click();
await br.getByText(/Repeated \(same as line 1\)/).waitFor();
check("add several requirements: repeated line flagged", true);
await br.getByRole("button", { name: "Remove them" }).click();
await br.getByLabel("Category of line 2").selectOption("product");
await sign(page);
await page.screenshot({ path: `${OUT}/03e-requirements-several.png` });
await br.getByRole("button", { name: "Add 2 requirements" }).click();
await det.getByText("Example: branded packing slip").waitFor();
check("add several requirements: 2 saved with their categories", (await det.locator(".card", { hasText: "Example: branded packing slip" }).innerText()).includes("Product"));
await page.getByRole("button", { name: "Close" }).first().click();
await page.getByRole("tab", { name: "Pricing" }).click();

await page.getByRole("button", { name: "Add pricing record" }).click();
const pf = page.getByRole("dialog", { name: "Add pricing record" });
await pf.getByLabel("Channel").selectOption({ label: "Direct website" });
await pf.getByPlaceholder("Search gifts by name, variant or SKU").fill("Thank You Gift Box");
await pf.getByRole("button", { name: /Thank You Gift Box — Simple/ }).click();
const retailBox = pf.locator(".ref-box", { hasText: "Retail reference price" });
await retailBox.getByText("From source").waitFor();
check("retail reference prefilled from the website (no retyping)", (await retailBox.innerText()).includes("$32.63"));
check("unknown cost shown as Unknown, not $0", (await pf.locator(".ref-box", { hasText: "Internal gift cost" }).innerText()).includes("Unknown"));
await pf.getByLabel("Fulfillment format").selectOption("corporate_separate_addresses");
check("direct discount prefilled from channel default", (await pf.getByLabel("Customer discount %").inputValue()) === "15");
await pf.getByText("Suggested customer price").waitFor();
const calc = await pf.locator(".calc").first().innerText();
check("direct suggested price = retail × (1 − demo 15%)", calc.includes("$27.74"), calc.split("\n")[0]);
await pf.getByRole("button", { name: /More details/ }).click();
check("optional fields live under More details", await pf.getByLabel("Payment terms").isVisible());
await sign(page);
await pf.locator(".calc").first().scrollIntoViewIfNeeded();
await page.screenshot({ path: `${OUT}/05-pricing-form-direct.png` });
await pf.getByRole("button", { name: "Save" }).click();
await page.locator("tbody tr", { hasText: "Thank You Gift Box" }).waitFor();
const agreedCell = await page.locator("tbody tr", { hasText: "Thank You Gift Box" }).locator('td[data-label="Agreed price"]').innerText();
check("suggested price not stored as agreed", agreedCell.trim().startsWith("—"), agreedCell);

// manual cost override needs reason + source + date
await page.getByRole("button", { name: "Add pricing record" }).click();
const pm = page.getByRole("dialog", { name: "Add pricing record" });
await pm.getByLabel("Channel").selectOption({ label: "Demo Market Delta" });
await pm.getByPlaceholder("Search gifts by name, variant or SKU").fill("Thank You Gift Box");
await pm.getByRole("button", { name: /Thank You Gift Box — Simple/ }).click();
// pricing models: only the chosen model's fields; live "SB receives"
await pm.getByRole("radio", { name: /Commission-based/ }).check();
await pm.getByRole("textbox", { name: /^Marketplace selling price/ }).fill("40.00");
await pm.getByLabel("Commission is calculated on").selectOption("selling_price");
await pm.getByLabel("Commission % (optional)").fill("15");
await pm.locator(".calc.interpret strong", { hasText: "$34.00" }).waitFor();
check("commission-based: SB receives = selling price − commission", (await pm.locator(".calc.interpret").innerText()).includes("15% commission"));
await page.screenshot({ path: `${OUT}/05b-pricing-form-commission.png` });
await pm.getByLabel("Commission % (optional)").fill("");
check("blank commission is not 0% (amount not calculated)", (await pm.locator(".calc.interpret").innerText()).includes("not specified"));
await pm.getByRole("radio", { name: /Fixed supplier price/ }).check();
check("fixed supplier price hides commission and fee fields", (await pm.getByLabel("Commission % (optional)").count()) === 0 && (await pm.getByLabel(/Fixed fee/).count()) === 0);
await pm.getByLabel("Agreed supplier price — SB receives per gift").fill("24.00");
check("fixed supplier price: SB receives the supplier price, nothing deducted", (await pm.locator(".calc.interpret").innerText()).includes("No commission is deducted"));
await pm.locator(".ref-box", { hasText: "Internal gift cost" }).getByLabel("Enter a manual value instead").check();
await pm.locator(".ref-box", { hasText: "Internal gift cost" }).getByLabel("Manual amount (USD)").fill("14.00");
await pm.getByLabel("Proposed supplier price").fill("21.00");
await sign(page);
await pm.getByRole("button", { name: "Save" }).click();
await pm.getByText("Reason required").waitFor();
check("manual value without reason is refused, input kept", (await pm.getByLabel("Proposed supplier price").inputValue()) === "21.00");
await pm.locator(".ref-box", { hasText: "Internal gift cost" }).getByLabel("Reason").fill("Example only: vendor quote pending Product Master mapping");
await pm.locator(".ref-box", { hasText: "Internal gift cost" }).getByLabel("Source").fill("Example quote Q-SCREENSHOT");
await pm.getByRole("button", { name: "Save" }).click();
await page.locator("tbody tr", { hasText: "Demo Market Delta" }).first().waitFor();
await page.locator("tbody tr", { hasText: "Demo Market Delta" }).first().getByRole("button", { name: "Open" }).click();
await page.getByRole("dialog").getByText("Manual", { exact: true }).waitFor();
check("manual value labelled Manual in the price view", true);
await page.screenshot({ path: `${OUT}/06-pricing-view-sources.png` });
await page.getByRole("button", { name: "Close" }).first().click();
await page.screenshot({ path: `${OUT}/07-pricing-table.png`, fullPage: true });

// ---- Pots + succulents: individual formats not offered
await page.getByRole("button", { name: "Add pricing record" }).click();
const pf2 = page.getByRole("dialog", { name: "Add pricing record" });
await pf2.getByLabel("Channel").selectOption({ label: "Demo Market Charlie" });
await pf2.getByPlaceholder("Search gifts by name, variant or SKU").fill("With Succulent");
await pf2.getByRole("button", { name: /10-Pack \/ With Succulent/ }).click();
await pf2.getByText("Pots with succulents: complete gift, bulk orders only").waitFor();
const fmtOptions = await pf2.getByLabel("Fulfillment format").locator("option").allInnerTexts();
check("pots+succulents hides individual / separate-address formats", !fmtOptions.some((o) => o.startsWith("Individual") || o.includes("separate")), fmtOptions.join(", "));
await pf2.getByRole("button", { name: "Cancel" }).click();

// ---- Pricing file import: a marketplace-style CSV (no template), file-level channel + model
const csvPath = join(tmpdir(), "example-partner-prices-SCREENSHOT.csv");
writeFileSync(csvPath, "SKU,Item name,Wholesale price,Price\nSYN-TYGB-S,Thank You Gift Box,22,39\nSYN-NOPE,Unknown item,10,20\n");
await page.getByRole("button", { name: "Import pricing file" }).click();
const xi = page.getByRole("dialog", { name: "Import pricing file" });
await sign(page);
await xi.locator('input[type="file"]').setInputFiles(csvPath);
await xi.getByText("What each column means").waitFor();
check("column suggestion: Wholesale price → agreed supplier price", (await xi.getByLabel("Meaning of Wholesale price").inputValue()) === "supplier_price");
check("a bare “Price” column is never assumed to be what SB earns", (await xi.getByLabel("Meaning of Price", { exact: true }).inputValue()) === "" && (await xi.getByText(/doesn't say whose price it is/).count()) === 1);
await xi.getByRole("combobox", { name: /^Channel/ }).selectOption({ label: "Demo Market Alpha" });
await xi.getByRole("combobox", { name: /^Pricing model(?! for)/ }).selectOption("fixed_supplier");
await xi.getByRole("combobox", { name: /^Fulfillment format/ }).selectOption("individual");
await xi.getByRole("button", { name: "Apply and re-check rows" }).click();
await xi.getByText("Review rows").waitFor();
check("preview interprets the price (SB receives $22.00) and flags the unmatched SKU",
  (await xi.locator(".import-table").innerText()).includes("$22.00") && (await xi.getByText(/No gift with SKU/).count()) === 1);
await page.screenshot({ path: `${OUT}/08-pricing-file-import-preview.png`, fullPage: true });
await xi.getByRole("button", { name: /Save 1 selected row/ }).click();
await xi.getByText("Import saved.").waitFor();
check("pricing file import saved the selected valid row", (await xi.locator(".alert.success").innerText()).includes("1 create"));
await xi.getByRole("button", { name: "Close" }).last().click();

// ---- Revenue: manual Shopify report upload (synthetic fixture), rule preview + confirm, manual fee
await page.getByRole("tab", { name: "Revenue" }).click();
await page.getByRole("button", { name: "Upload Shopify report" }).click();
const up = page.getByRole("dialog", { name: "Upload Shopify report" });
await up.locator('input[type="file"]').setInputFiles(join(import.meta.dirname, "..", "tests", "fixtures", "shopify-orders-SYNTHETIC.csv"));
await up.getByText(/5 orders from 7 rows/).waitFor();
await up.getByLabel("Report exported at").fill("2026-10-05T01:00");
await up.getByLabel("Export covers orders from").fill("2026-08-10");
await up.getByLabel("Export covers orders to").fill("2026-10-04");
await sign(page);
await page.screenshot({ path: `${OUT}/09-shopify-upload.png` });
await up.getByRole("button", { name: "Import" }).click();
await up.getByText(/5 new/).waitFor();
check("manual Shopify upload imported 5 synthetic orders", true);
await up.getByRole("button", { name: "Close" }).last().click();

await page.getByRole("button", { name: /Shopify matching rules/ }).click();
await page.getByRole("button", { name: "Add rule" }).click();
const rf = page.getByRole("dialog", { name: "Add matching rule" });
await rf.getByLabel("Channel").selectOption({ label: "Demo Market Bravo" });
await rf.getByLabel("Source field").selectOption("billing_company");
await rf.getByLabel("Match value").fill("  bravo GIFTING llc ");
await rf.getByRole("button", { name: "Preview impact" }).click();
await rf.getByText("orders change channel/state").waitFor();
check("rule preview shows matching count before saving", (await rf.locator(".stats").innerText()).includes("1 orders match"));
await page.screenshot({ path: `${OUT}/10-rule-preview.png` });
await sign(page);
await rf.getByRole("button", { name: "Confirm and apply" }).click();
await page.locator("tbody tr", { hasText: "Demo Market Bravo" }).first().waitFor();
const bravoRow = await page.locator("table.dense tbody tr", { hasText: "Demo Market Bravo" }).first().innerText();
check("assigned Shopify order appears in Bravo revenue ($280.00, tax/Route/discount handled)", bravoRow.includes("$280.00"), bravoRow.replace(/\s+/g, " "));
check("fees shown as not recorded when unknown", bravoRow.includes("Fees not recorded"));

await page.getByRole("button", { name: "Add manual entry" }).click();
const me = page.getByRole("dialog", { name: "Add manual entry" });
await me.getByLabel("Kind").selectOption("fee");
await me.getByLabel("Channel").selectOption({ label: "Demo Market Bravo" });
await me.getByLabel("Reporting month").fill("2026-09");
await me.getByLabel("Marketplace fees (USD)").fill("35.00");
await me.getByLabel("Reference").fill("EXAMPLE-STATEMENT-1");
await me.getByLabel("Reason").fill("Example only (screenshot): fee from partner statement");
await sign(page);
await me.getByRole("button", { name: "Save" }).click();
await page.locator("table.dense tbody tr", { hasText: "$245.00" }).first().waitFor();
check("recorded fee gives revenue after fees", true);
await page.screenshot({ path: `${OUT}/11-revenue.png`, fullPage: true });

// ---- Manual
await page.getByRole("button", { name: "How to use" }).click();
const man = page.getByRole("dialog", { name: "How to use this site" });
await man.getByRole("heading", { name: "Quick reference — when this happens, do this" }).waitFor();
check("manual opens with all steps and the quick reference", (await man.locator(".manual-step").count()) === 12);
await man.getByRole("button", { name: "6. Agree the price" }).click();
await page.screenshot({ path: `${OUT}/00-manual.png` });
await page.getByRole("button", { name: "Close" }).first().click();

// ---- Mobile
const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });

await m.goto(BASE);
await m.locator("tbody tr").first().waitFor();
await m.screenshot({ path: `${OUT}/12-mobile-marketplaces.png`, fullPage: true });
const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
check("mobile: no horizontal page scroll", !overflow);
await m.getByRole("button", { name: "How to use" }).click();
await m.getByRole("heading", { name: "1. Add the partner" }).waitFor();
check("mobile manual: no horizontal page scroll", !(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
await m.screenshot({ path: `${OUT}/12b-mobile-manual.png` });
await m.getByRole("button", { name: "Close" }).first().click();
await m.getByRole("button", { name: "Demo Market Echo" }).count().then(async (n) => n || (await m.getByLabel("Show inactive marketplaces").check()));
await m.getByRole("button", { name: "Demo Market Alpha" }).click();
await m.getByRole("dialog").getByText("Requirements").first().waitFor();
await m.screenshot({ path: `${OUT}/12b-mobile-detail.png`, fullPage: false });
await m.goto(`${BASE}/?tab=pricing`);
await m.locator("tbody tr").first().waitFor();
await m.screenshot({ path: `${OUT}/13-mobile-pricing.png`, fullPage: true });
check("mobile pricing: no horizontal page scroll", !(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
await m.getByRole("button", { name: "Add pricing record" }).click();
await m.getByRole("dialog", { name: "Add pricing record" }).getByLabel("Channel").selectOption({ label: "Direct website" });
await m.screenshot({ path: `${OUT}/14-mobile-pricing-form.png` });
check("mobile pricing form: no horizontal page scroll", !(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
await m.goto(`${BASE}/?tab=revenue`);
await m.locator(".summary").waitFor();
await m.screenshot({ path: `${OUT}/15-mobile-revenue.png`, fullPage: true });
check("mobile revenue: no horizontal page scroll", !(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));

await browser.close();
let failed = 0;
for (const [n, ok, d] of results) { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); if (!ok) failed++; }
process.exit(failed ? 1 : 0);
