// Partner research import (CSV): preview → reviewed decisions → apply as one recorded batch → optional reversal.
//
// Rules (see docs/PARTNERS_MIGRATION.md):
// - Matching uses the stable record ID (optional "Partner ID" column), the normalised name and the record's verified
//   aliases. A website host, a former name stated in the research or a similar name is supporting evidence only: the
//   row becomes a possible duplicate and needs a decision. A shared parent company is never used for matching.
// - Existing records keep their ID, stage, history, owner, actions, negotiated terms, pricing, products, revenue,
//   resources and task links. The import fills EMPTY fields only; a different existing value is a conflict that keeps
//   the existing value unless the reviewer chooses the imported one for that field.
// - Research (contacts, contact routes, requirements) is ADDED with its source and date; nothing existing is edited.
//   Stable keys make a re-import add nothing twice.
// - Sales role / Slack eligibility is never changed for existing records; new records start as "Unclear" so a
//   Slack mention cannot act on them until someone confirms they sell our gifts. No tasks are created.
// - Each applied import is a batch with one item per row (what was created or filled), so it can be reversed.
import { createHash } from "node:crypto";
import type pg from "pg";
import { audit, type Actor } from "../audit";
import { badRequest } from "../http";
import { createMarketplace } from "../routes/marketplaces";
import { partnerKey, hostKey, isClosed, CATEGORIES, CONTACT_ROLES, CHANNEL_MODELS } from "./partners";

// ---------------------------------------------------------------------- CSV
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

const COLUMNS: Record<string, RegExp> = {
  partner_id: /^partner id$/i, priority: /^priority$/i, company: /^company$/i, category: /^category$/i, channel: /^channel model/i,
  parent: /^parent company$/i, contact_apply: /^contact \/ apply$/i, contact_type: /^contact type$/i, requirements: /^requirements/i,
  ordering: /^partner ordering/i, capability: /^sb capability/i, show_up: /^how succulents box could show up$/i, verification: /^verification$/i,
  sources: /^source urls$/i, checked: /^last checked$/i, next_action: /^next action$/i, p_name: /^primary contact name$/i,
  p_title: /^primary contact title/i, p_why: /^why this person fits$/i, p_profile: /^primary contact profile url$/i,
  p_published: /^published business email/i, backup: /^backup contact$/i, c_sources: /^contact sources/i,
  c_confidence: /^contact confidence$/i, c_next: /^contact next step$/i, status: /^status$/i, aliases: /^aliases$/i, website: /^website$/i,
};
type Col = keyof typeof COLUMNS;

// ------------------------------------------------------------------ mapping
const URL_RE = /https?:\/\/[^\s'"<>)·,;]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/;
const urls = (t: string) => [...new Set((t.match(URL_RE) ?? []).map((u) => u.replace(/[.]+$/, "")))];
const hash = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);
const clip = (t: string | null | undefined, n: number) => (t ? (t.length > n ? t.slice(0, n - 1) + "…" : t) : null);
const blank = (t: string | undefined | null) => !t || !t.trim() || /^(-|—|n\/a|none)$/i.test(t.trim());

/** Research category text → primary category. Order matters (promo before recognition, pet before memorial). */
export function mapCategory(t: string): string {
  const v = t.trim().toLowerCase();
  if ((CATEGORIES as readonly string[]).includes(v)) return v;
  const rules: [RegExp, string][] = [
    [/promo/, "events_promo"],
    [/\bpet\b|veterinar/, "veterinary_pet_memorial"],
    [/hospital|health/, "healthcare_hospital_retail"],
    [/caregiv|community support/, "caregiving_community"],
    [/funeral|obituar|sympathy|memorial/, "sympathy_memorial"],
    [/wedding|registr/, "weddings_registries"],
    [/real estate|brokerage|mortgage|realty/, "real_estate_mortgage"],
    [/relocation|moving|resident|property/, "relocation_resident"],
    [/event|\bdmc\b|conference|meeting/, "events_promo"],
    [/recognition|employee|benefit|reward/, "employee_recognition"],
    [/gifting platform|corporate gift/, "corporate_gifting_platforms"],
    [/retail marketplace|marketplace network|distribution/, "retail_marketplaces"],
    [/direct corporate/, "direct_corporate_buyers"],
  ];
  return rules.find(([re]) => re.test(v))?.[1] ?? "uncategorized";
}

export function mapChannelModels(t: string): string[] {
  const v = t.toLowerCase();
  const out = new Set<string>();
  for (const k of CHANNEL_MODELS) if (v.split(/[,;/|]/).map((x) => x.trim()).includes(k)) out.add(k);
  if (/catalog|dropship|drop-ship/.test(v)) out.add("catalog_dropship");
  if (/wholesale/.test(v)) out.add("wholesale");
  if (/direct corporate|event buyer|direct purchas/.test(v)) out.add("direct_purchasing");
  if (/referral/.test(v)) out.add("referral");
  if (/employee discount/.test(v)) out.add("employee_discount");
  if (/vendor directory|lead gen/.test(v)) out.add("vendor_directory");
  if (/integration/.test(v)) out.add("integration");
  return [...out];
}

function mapPurpose(contactType: string): string {
  const v = contactType.toLowerCase();
  if (/self-serve app/.test(v)) return "self_serve_app";
  if (/^supplier application/.test(v)) return "supplier_application";
  if (/^partnership/.test(v)) return "partnership";
  if (/^general contact/.test(v)) return "general_contact";
  if (/^customer sales/.test(v)) return "customer_sales";
  if (/^support/.test(v)) return "support";
  if (/^press/.test(v)) return "press";
  if (/invoice|portal/.test(v)) return "portal_admin";
  return "other";
}

/** Role of a named contact from the research text. Shown in the preview; the reviewer can change it. */
export function inferRole(title: string, context: string): string {
  const all = `${title} ${context}`.toLowerCase();
  const t = title.toLowerCase();
  if (/advertising only|paid advertising/.test(all)) return "advertising_only";
  if (/^former\b|\bformer (vp|vice|director|head|manager)/.test(t)) return "historical";
  if (/routing/.test(all)) return "routing";
  if (/fallback|\bco-?founder\b|\bfounder\b|\bceo\b|chief executive/.test(all)) return "executive_fallback";
  if (/supplier|sourcing|procurement|merchandis|buyer|purchas/.test(t)) return "supplier_sourcing";
  if (/\bpress\b|\bmedia\b|public relations/.test(t)) return "press";
  if (/customer support|support (team|desk|line)/.test(t)) return "support";
  if (/\bsales\b|\brevenue\b/.test(t)) return "customer_sales";
  return "relevant_partnerships";
}

const looksLikePerson = (n: string) => n.length >= 3 && n.length <= 60 && !/\d|@|http/.test(n) && /^[A-Z][\p{L}'’.-]+(\s+[A-Z][\p{L}'’.-]*){1,4}$/u.test(n);

export type ImportContact = { key: string; name: string; title: string | null; role: string; rank: "primary" | "backup" | "other"; email: string | null; phone: string | null;
  profile_url: string | null; source_urls: string[]; checked_on: string | null; role_verification: string; confidence: string | null; note: string | null };
export type ImportRoute = { key: string; purpose: string; label: string | null; url: string | null; detail: string; checked_on: string | null };
export type ImportRequirement = { key: string; kind: string; category: string; requirement: string; source_ref: string | null; verified_on: string | null; verification: string | null; applicability: string | null };
export type ImportRow = {
  line: number; company: string; key: string; partner_id: string | null; errors: string[]; warnings: string[];
  fields: { priority: string; category: string; channel_models: string[]; parent_company: string | null; opportunity_summary: string | null; next_action: string | null;
    contact_next_step: string | null; research_state: string | null; website_url: string | null };
  provider_type: "marketplace" | "supplier_opportunity";
  aliases: string[]; former_names: string[]; category_source: string; host: string | null;
  contacts: ImportContact[]; routes: ImportRoute[]; requirements: ImportRequirement[];
};

const STANDARD_CAPABILITY = [/^SB can fulfill one gift per order\.?$/i, /^Partner pricing and fulfillment terms (are )?to be agreed separately\.?$/i, /^Product-specific shipping restrictions apply\.?$/i];
const sentences = (t: string) => t.split(/(?<=\.)\s+(?=[A-Z])/).map((x) => x.trim()).filter(Boolean);

export function mapRows(csv: string): { rows: ImportRow[]; headerErrors: string[]; unknownColumns: string[] } {
  const table = parseCsv(csv);
  if (!table.length) return { rows: [], headerErrors: ["The file is empty."], unknownColumns: [] };
  const header = table[0].map((h) => h.trim());
  const idx: Partial<Record<Col, number>> = {};
  const unknownColumns: string[] = [];
  header.forEach((h, i) => {
    const k = (Object.keys(COLUMNS) as Col[]).find((c) => COLUMNS[c].test(h));
    if (k && idx[k] === undefined) idx[k] = i; else if (!k) unknownColumns.push(h);
  });
  if (idx.company === undefined) return { rows: [], headerErrors: ["A Company column is required."], unknownColumns };
  const rows: ImportRow[] = [];
  for (let r = 1; r < table.length; r++) {
    const raw = table[r];
    const g = (c: Col) => (idx[c] === undefined ? "" : (raw[idx[c]!] ?? "").trim());
    const errors: string[] = [], warnings: string[] = [];
    const companyFull = g("company").replace(/\s+/g, " ");
    if (!companyFull) errors.push("Company is empty");
    if (/^[=+\-@]/.test(companyFull)) errors.push("Company must not start with = + - or @");
    if (companyFull.length > 120) errors.push("Company is longer than 120 characters");
    const formerNames = [...companyFull.matchAll(/\((?:formerly|previously|aka|also known as)\s+([^)]+)\)/gi)].map((m) => m[1].trim());
    const aliases = g("aliases") ? g("aliases").split(/[;,]/).map((x) => x.trim()).filter(Boolean) : [];
    const checked = /^\d{4}-\d{2}-\d{2}$/.test(g("checked")) ? g("checked") : null;
    const contactChecked = header[idx.c_sources ?? -1]?.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? checked;
    const pr = g("priority").toUpperCase();
    const priority = ["A", "B", "C"].includes(pr) ? pr.toLowerCase() : "not_assessed";
    if (g("priority") && priority === "not_assessed") warnings.push(`Priority “${g("priority")}” not recognised; recorded as Not assessed`);
    const category = mapCategory(g("category"));
    if (g("category") && category === "uncategorized") warnings.push(`Category “${g("category")}” not recognised; recorded as Uncategorized`);
    const channel_models = mapChannelModels(g("channel"));
    const partnerId = g("partner_id") || null;
    if (partnerId && !/^[0-9a-f-]{36}$/i.test(partnerId)) errors.push("Partner ID is not a record ID");

    // Research state and contacts
    const pName = g("p_name");
    let research_state: string | null = null;
    const contacts: ImportContact[] = [];
    const confText = g("c_confidence");
    const confidence = /confirmed responsibility/i.test(confText) ? "high" : /likely relevant/i.test(confText) ? "medium" : /needs verification/i.test(confText) ? "low" : null;
    const published = g("p_published");
    const pubEmail = /^none/i.test(published) ? null : published.match(EMAIL_RE)?.[0] ?? null;
    const pubPhone = /^(none|company|consumer)/i.test(published) ? null : published.match(PHONE_RE)?.[0] ?? null;
    const contactSources = urls(g("c_sources"));
    const profile = urls(g("p_profile"))[0] ?? null;
    const former = pName.match(/^replacement needed\s*\(former contact:\s*([^)]+)\)/i);
    if (/^not researched\s*-\s*supplier\/partnership route already published/i.test(pName)) research_state = "route_published";
    else if (/^not researched/i.test(pName)) research_state = "not_researched";
    else if (/^responsible person not identified/i.test(pName)) research_state = "responsible_not_identified";
    else if (/^not applicable/i.test(pName)) research_state = "no_contact_needed";
    else if (former) {
      research_state = "contact_needed";
      const name = former[1].trim();
      if (looksLikePerson(name)) contacts.push({ key: `p:${partnerKey(name)}`, name, title: clip(g("p_title"), 500), role: "historical", rank: "other", email: null, phone: null,
        profile_url: profile, source_urls: contactSources, checked_on: contactChecked, role_verification: "former", confidence: null,
        note: clip([g("p_why"), "Former contact; a replacement is needed."].filter(Boolean).join(" "), 2000) });
    } else if (pName) {
      if (looksLikePerson(pName)) {
        const role = inferRole(g("p_title"), [g("p_why"), confText, g("c_next")].join(" "));
        contacts.push({ key: `p:${partnerKey(pName)}`, name: pName, title: clip(g("p_title"), 500), role, rank: "primary", email: pubEmail, phone: pubPhone,
          profile_url: profile, source_urls: contactSources, checked_on: contactChecked,
          role_verification: role === "historical" ? "historical" : confidence === "high" ? "current_verified" : "needs_verification", confidence,
          note: clip(g("p_why"), 2000) });
        research_state = confidence === "high" ? "contact_identified" : "verify_contact";
      } else warnings.push(`Primary contact “${clip(pName, 60)}” is not a person's name; kept as research text only`);
    }
    const backup = g("backup");
    if (!blank(backup)) {
      const stripped = backup.replace(/^[^:]{0,40}\bonly:\s*/i, "");
      const name = stripped.split(/,|\s\(|\s-\s|\s–\s/)[0].trim();
      if (looksLikePerson(name)) {
        const rest = stripped.slice(name.length).replace(/^[,\s]+/, "");
        const role = inferRole(rest, backup);
        const dash = rest.search(/\s[-–]\s/);
        const title = (dash >= 0 ? rest.slice(0, dash) : rest).replace(/^\(|\)$/g, "").trim();
        contacts.push({ key: `p:${partnerKey(name)}`, name, title: clip(title, 500) || null, role, rank: "backup", email: null, phone: null, profile_url: urls(backup)[0] ?? null,
          source_urls: contactSources, checked_on: contactChecked, role_verification: role === "historical" ? "historical" : "needs_verification", confidence: null,
          note: clip(`Backup (as researched): ${backup}`, 2000) });
      } else warnings.push(`Backup contact text not recognised as a person; not added as a contact`);
    }

    // Published contact route / application
    const routes: ImportRoute[] = [];
    if (!blank(g("contact_apply"))) {
      const detail = g("contact_apply");
      routes.push({ key: `r:${hash(detail)}`, purpose: mapPurpose(g("contact_type")), label: clip(g("contact_type"), 200) || null, url: urls(detail)[0] ?? null,
        detail: clip(detail, 2000)!, checked_on: checked });
    }

    // Requirements & terms
    const requirements: ImportRequirement[] = [];
    const src = clip(urls(g("sources")).join(" ; ") || g("sources"), 2000);
    const add = (kind: string, category: string, text: string, extra: Partial<ImportRequirement> = {}) => {
      if (blank(text)) return;
      requirements.push({ key: `${kind}:${hash(text)}`, kind, category, requirement: clip(text, 4000)!, source_ref: src, verified_on: checked, verification: null, applicability: null, ...extra });
    };
    add("published", "other", g("requirements"), { verification: clip(g("verification"), 2000) });
    const ord = g("ordering");
    const ex = ord.search(/expected ordering pattern/i);
    if (ex >= 0) { add("published", "fulfillment", ord.slice(0, ex).trim()); add("ordering_assumption", "fulfillment", ord.slice(ex).trim()); }
    else add("published", "fulfillment", ord);
    const capRest = sentences(g("capability")).filter((x) => !STANDARD_CAPABILITY.some((re) => re.test(x)));
    add("sb_capability", "pricing", capRest.filter((x) => /pricing|price/i.test(x)).join(" "), { applicability: "Bulk pricing (separate from fulfillment capability)" });
    add("sb_capability", "fulfillment", capRest.filter((x) => !/pricing|price/i.test(x)).join(" "));

    const host = hostKey(g("website")) ?? hostKey(urls(g("contact_apply"))[0]);
    rows.push({
      line: r + 1, company: companyFull, key: partnerKey(companyFull), partner_id: partnerId, errors, warnings,
      fields: { priority, category, channel_models, parent_company: clip(g("parent"), 500), opportunity_summary: clip(g("show_up"), 4000) || null,
        next_action: clip(g("next_action"), 2000) || null, contact_next_step: clip(g("c_next"), 2000) || null, research_state,
        website_url: urls(g("website"))[0] ?? null },
      provider_type: channel_models.length === 1 && channel_models[0] === "direct_purchasing" ? "supplier_opportunity" : "marketplace",
      aliases, former_names: formerNames, category_source: g("category"), host,
      contacts, routes, requirements,
    });
  }
  return { rows, headerErrors: [], unknownColumns };
}

// ---------------------------------------------------------------- decisions
export type Decision = {
  action?: "import" | "exclude";
  merge_into?: string;          // possible duplicate → this existing record
  create_new?: boolean;         // possible duplicate → a separate new record
  stage?: "skipped";            // import (or set) as Skipped
  stage_reason?: string;        // required with stage
  category?: string;            // reviewer's category for this row
  fields?: Record<string, "import" | "keep">;   // conflicting fields
  contact_roles?: Record<string, string>;       // contact key → role
};

const FILL_FIELDS = ["priority", "category", "channel_models", "parent_company", "opportunity_summary", "next_action", "contact_next_step", "research_state", "website_url"] as const;
const emptyValue = (f: string, v: any) => v == null || v === "" || (Array.isArray(v) && v.length === 0) || (f === "priority" && v === "not_assessed") || (f === "category" && v === "uncategorized");
const same = (a: any, b: any) => JSON.stringify(Array.isArray(a) ? [...a].sort() : a ?? null) === JSON.stringify(Array.isArray(b) ? [...b].sort() : b ?? null);

export type PreviewRow = {
  line: number; company: string; key: string; outcome: string; reasons: string[]; errors: string[]; warnings: string[];
  match: { id: string; name: string; status: string; how: string } | null;
  candidates: { id: string; name: string; status: string; why: string }[];
  fills: { field: string; before: unknown; after: unknown }[];
  conflicts: { field: string; existing: unknown; imported: unknown; resolution: "keep" | "import" }[];
  kept: string[];                 // informational: values intentionally not changed (stage, sales role …)
  add: { contacts: ImportContact[]; routes: ImportRoute[]; requirements: ImportRequirement[] };
  already: { contacts: number; routes: number; requirements: number };
  create: null | { name: string; provider_type: string; stage: string; stage_reason: string | null; sales_role: "unclear" };
  fields: ImportRow["fields"]; category_source: string;
  needs_decision: boolean;
  decision: Decision | null;
};

async function existingRecords(c: pg.PoolClient) {
  const parts = (await c.query("select id, name, aliases, status, website_url, portal_url, sales_role, owner, " + FILL_FIELDS.filter((f) => f !== "website_url").join(", ") + " from marketplaces")).rows;
  const channels = (await c.query("select c.name from channels c where not exists (select 1 from marketplaces m where m.channel_id = c.id)")).rows.map((r) => r.name as string);
  return { parts, channelKeys: new Set(channels.map(partnerKey)) };
}

/** Compute the preview. Pure reads; safe to run any time. */
export async function previewImport(c: pg.PoolClient, csv: string, decisions: Record<string, Decision> = {}) {
  const { rows, headerErrors, unknownColumns } = mapRows(csv);
  if (headerErrors.length) throw badRequest(headerErrors.join(" "));
  const { parts, channelKeys } = await existingRecords(c);
  const byId = new Map(parts.map((p) => [p.id, p]));
  const seen = new Map<string, number>();
  const out: PreviewRow[] = [];
  for (const row of rows) {
    const d = decisions[row.key] ?? null;
    const pr: PreviewRow = { line: row.line, company: row.company, key: row.key, outcome: "new", reasons: [], errors: [...row.errors], warnings: [...row.warnings],
      match: null, candidates: [], fills: [], conflicts: [], kept: [], add: { contacts: [], routes: [], requirements: [] }, already: { contacts: 0, routes: 0, requirements: 0 },
      create: null, fields: { ...row.fields, category: d?.category ?? row.fields.category }, category_source: row.category_source, needs_decision: false, decision: d };
    if (row.key && seen.has(row.key)) pr.errors.push(`Repeated (same company as line ${seen.get(row.key)})`);
    else if (row.key) seen.set(row.key, row.line);
    if (d?.category && !(CATEGORIES as readonly string[]).includes(d.category)) pr.errors.push("Unknown category in decision");
    if (d?.stage && !d.stage_reason?.trim()) pr.errors.push("A reason is required to import as Skipped");
    for (const [k, role] of Object.entries(d?.contact_roles ?? {})) if (!(CONTACT_ROLES as readonly string[]).includes(role)) pr.errors.push(`Unknown contact role for ${k}`);
    if (pr.errors.length) { pr.outcome = "invalid"; out.push(pr); continue; }
    if (d?.action === "exclude") { pr.outcome = "not_imported"; pr.reasons.push("Excluded by decision: nothing is written for this row"); out.push(pr); continue; }

    // Matching
    let match: any = null;
    let how = "";
    if (row.partner_id) {
      match = byId.get(row.partner_id) ?? null;
      if (!match) { pr.errors.push("Partner ID not found"); pr.outcome = "invalid"; out.push(pr); continue; }
      how = "record ID";
    }
    const exact = parts.filter((p) => partnerKey(p.name) === row.key);
    const viaAlias = parts.filter((p) => !exact.includes(p) && (p.aliases ?? []).some((a: string) => partnerKey(a) === row.key));
    if (!match) {
      const hits = [...exact, ...viaAlias];
      if (hits.length === 1) { match = hits[0]; how = exact.length ? "same name" : `verified alias of ${hits[0].name}`; }
      else if (hits.length > 1) for (const h of hits) pr.candidates.push({ id: h.id, name: h.name, status: h.status, why: "Name or alias matches more than one record" });
    }
    if (!match) {
      for (const p of parts) {
        if (pr.candidates.some((x) => x.id === p.id)) continue;
        const pk = partnerKey(p.name);
        const keys = [pk, ...(p.aliases ?? []).map(partnerKey)];
        const why: string[] = [];
        if (row.former_names.some((f) => keys.includes(partnerKey(f)))) why.push(`Research says formerly “${row.former_names.join(", ")}”`);
        if (row.aliases.some((a) => keys.includes(partnerKey(a)))) why.push("Alias in the file matches this record");
        const wb = (a: string, b: string) => a.length >= 4 && new RegExp(`(^| )${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(b);
        if (row.key && (wb(pk, row.key) || wb(row.key, pk))) why.push("Similar name");
        const hosts = [hostKey(p.website_url), hostKey(p.portal_url)].filter(Boolean);
        if (row.host && hosts.includes(row.host)) why.push(`Same website (${row.host}) — supporting evidence only`);
        if (why.length) pr.candidates.push({ id: p.id, name: p.name, status: p.status, why: why.join("; ") });
      }
      if (channelKeys.has(row.key)) pr.errors.push("Name is already used by a non-partner channel");
    }
    if (pr.errors.length) { pr.outcome = "invalid"; out.push(pr); continue; }

    if (!match && pr.candidates.length) {
      if (d?.merge_into) {
        match = byId.get(d.merge_into);
        if (!match || !pr.candidates.some((x) => x.id === d.merge_into)) { pr.errors.push("Chosen record is not one of the candidates"); pr.outcome = "invalid"; out.push(pr); continue; }
        how = "reviewer decision";
      } else if (!d?.create_new) {
        pr.outcome = "possible_duplicate"; pr.needs_decision = true;
        pr.reasons.push("Possible duplicate: choose the record to update, create a separate partner, or exclude the row");
      }
    }

    const category = d?.category ?? row.fields.category;
    const imported: Record<string, unknown> = { ...row.fields, category };
    const roleOf = (k: ImportContact) => ({ ...k, role: d?.contact_roles?.[k.key] ?? k.role });
    const contacts = row.contacts.map(roleOf);

    if (match) {
      pr.match = { id: match.id, name: match.name, status: match.status, how };
      const res = d?.fields ?? {};
      for (const f of FILL_FIELDS) {
        const before = match[f], after = imported[f];
        if (emptyValue(f, after) || same(before, after)) continue;
        if (emptyValue(f, before)) pr.fills.push({ field: f, before, after });
        else pr.conflicts.push({ field: f, existing: before, imported: after, resolution: res[f] === "import" ? "import" : "keep" });
      }
      pr.kept.push(`Stage kept: ${match.status}${match.status !== "prospect" ? " (the file's status is not applied to existing records)" : ""}`);
      pr.kept.push(`Sales role kept: ${match.sales_role}`);
      if (match.owner) pr.kept.push(`Owner kept: ${match.owner}`);
      // Research to add (stable keys; anything already recorded is skipped)
      const haveC = new Set((await c.query("select source_key, name from partner_contacts where marketplace_id = $1", [match.id])).rows.flatMap((r) => [r.source_key, `p:${partnerKey(r.name)}`]));
      const haveR = new Set((await c.query("select source_key from partner_applications where marketplace_id = $1 and source_key is not null", [match.id])).rows.map((r) => r.source_key));
      const haveQ = new Set((await c.query("select finding_key from requirements where marketplace_id = $1 and finding_key is not null", [match.id])).rows.map((r) => r.finding_key));
      for (const k of contacts) haveC.has(k.key) ? pr.already.contacts++ : pr.add.contacts.push(k);
      for (const k of row.routes) haveR.has(k.key) ? pr.already.routes++ : pr.add.routes.push(k);
      for (const k of row.requirements) haveQ.has(reqKey(match.id, k)) ? pr.already.requirements++ : pr.add.requirements.push(k);
      if (d?.stage === "skipped") {
        if (match.status !== "skipped") pr.reasons.push(`Stage will change ${match.status} → skipped by decision (${d.stage_reason})`);
        pr.outcome = "skipped_by_decision";
      } else if (isClosed(match.status) && match.status === "skipped") pr.outcome = "skipped_by_decision";
      else pr.outcome = pr.conflicts.length ? "conflict" : "existing_match";
      if (pr.outcome === "skipped_by_decision" && !d?.stage) pr.reasons.push("Existing record was already skipped; it stays out of outreach");
    } else if (pr.outcome !== "possible_duplicate") {
      pr.add = { contacts, routes: row.routes, requirements: row.requirements };
      pr.create = { name: row.company, provider_type: row.provider_type, stage: d?.stage ?? "prospect", stage_reason: d?.stage ? d.stage_reason!.trim() : null, sales_role: "unclear" };
      pr.outcome = d?.stage ? "skipped_by_decision" : "new";
      if (d?.create_new) pr.reasons.push("Created separately by decision despite similar records");
    }
    out.push(pr);
  }
  const summary: Record<string, number> = { rows: out.length };
  for (const r of out) summary[r.outcome] = (summary[r.outcome] ?? 0) + 1;
  const byPriority: Record<string, number> = {};
  for (const r of out) if (r.outcome !== "invalid" && r.outcome !== "not_imported") {
    const row = rows.find((x) => x.line === r.line)!;
    const k = r.outcome === "skipped_by_decision" ? "skipped" : row.fields.priority;
    byPriority[k] = (byPriority[k] ?? 0) + 1;
  }
  return { rows: out, mapped: rows, summary, by_priority: byPriority, unknown_columns: unknownColumns, blocking: out.filter((r) => r.needs_decision).length, source_hash: hash(csv) };
}

const reqKey = (mid: string, k: ImportRequirement) => `import:${mid}:${k.key}`;

// -------------------------------------------------------------------- apply
/** Test seam: runs after the import is planned and before any partner row is locked. */
export type ApplyHooks = { afterPlan?: () => Promise<void> };

export async function applyImport(c: pg.PoolClient, a: Actor, csv: string, sourceName: string, decisions: Record<string, Decision>, hooks: ApplyHooks = {}) {
  const p = await previewImport(c, csv, decisions);
  await hooks.afterPlan?.();
  if (p.blocking) throw badRequest(`${p.blocking} possible duplicate(s) need a decision before the import can be applied.`, { rows: p.rows.filter((r) => r.needs_decision).map((r) => ({ line: r.line, company: r.company })) });
  const batch = (await c.query(
    `insert into partner_import_batches (source_name, source_hash, row_count, summary, created_by, auth_subject) values ($1,$2,$3,$4,$5,$6) returning *`,
    [sourceName, p.source_hash, p.rows.length, JSON.stringify({ outcomes: p.summary, by_priority: p.by_priority }), a.signer, a.sub])).rows[0];
  const totals = { created: 0, filled: 0, contacts: 0, routes: 0, requirements: 0, stage_changes: 0, late_conflicts: 0 };
  const lateConflicts: { line: number; company: string; field: string; planned_before: unknown; now: unknown; imported: unknown }[] = [];
  for (const r of p.rows) {
    const mapped = p.mapped.find((x) => x.line === r.line)!;
    const created: { contacts: string[]; applications: string[]; requirements: string[] } = { contacts: [], applications: [], requirements: [] };
    const fieldChanges: { field: string; before: unknown; after: unknown }[] = [];
    let mid: string | null = r.match?.id ?? null;
    let createdPartner = false;
    const conflicts: any[] = [...r.conflicts];
    if (r.outcome === "invalid" || r.outcome === "not_imported") {
      await c.query("insert into partner_import_items (batch_id, line, company, outcome, decision, row_data) values ($1,$2,$3,$4,$5,$6)",
        [batch.id, r.line, r.company.slice(0, 200), r.outcome, r.decision ? JSON.stringify(r.decision) : null, JSON.stringify({ errors: r.errors })]);
      continue;
    }
    if (r.create) {
      const f = mapped.fields;
      const m = await createMarketplace(c, { name: r.create.name, provider_type: r.create.provider_type, status: "prospect", sales_role: "unclear", aliases: mapped.aliases.slice(0, 10),
        category: r.decision?.category ?? f.category, channel_models: f.channel_models, priority: f.priority, research_state: f.research_state, parent_company: f.parent_company,
        opportunity_summary: f.opportunity_summary, next_action: f.next_action, contact_next_step: f.contact_next_step, website_url: f.website_url }, a);
      mid = m.id; createdPartner = true; totals.created++;
    } else if (mid) {
      // The plan was made without a lock. Re-check every planned change against the LOCKED record: a field someone
      // filled or changed in the meantime is kept and reported as a conflict, never overwritten.
      const planned: { field: string; expect: unknown; after: unknown }[] = [
        ...r.fills.map((x) => ({ field: x.field, expect: x.before, after: x.after })),
        ...r.conflicts.filter((x) => x.resolution === "import").map((x) => ({ field: x.field, expect: x.existing, after: x.imported })),
      ];
      const locked = (await c.query(`select * from marketplaces where id = $1 for update`, [mid])).rows[0];
      const sets: Record<string, unknown> = {};
      for (const x of planned) {
        if (same(locked[x.field], x.expect)) { sets[x.field] = x.after; continue; }
        if (same(locked[x.field], x.after)) continue;   // already holds the imported value
        const lc = { line: r.line, company: r.company, field: x.field, planned_before: x.expect, now: locked[x.field], imported: x.after };
        lateConflicts.push(lc);
        conflicts.push({ field: x.field, existing: locked[x.field], imported: x.after, resolution: "keep", changed_during_import: true });
        totals.late_conflicts++;
      }
      const keys = Object.keys(sets);
      if (keys.length) {
        const before = Object.fromEntries(keys.map((k) => [k, locked[k]]));
        await c.query(`update marketplaces set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now(), version = version + 1 where id = $1`, [mid, ...keys.map((k) => sets[k])]);
        for (const k of keys) fieldChanges.push({ field: k, before: before[k], after: sets[k] });
        totals.filled += keys.length;
        await audit(c, a, { entityType: "marketplace", entityId: mid, marketplaceId: mid, action: "import_update", before, after: { ...sets, import_batch_id: batch.id } });
      }
    }
    if (!mid) continue;
    if (r.decision?.stage === "skipped") {
      const cur = (await c.query("select status from marketplaces where id = $1 for update", [mid])).rows[0];
      if (cur.status !== "skipped") {
        await c.query("update marketplaces set status = 'skipped', status_evidence_at = now(), updated_at = now(), version = version + 1 where id = $1", [mid]);
        await c.query(`insert into status_history (marketplace_id, from_status, to_status, reason, detail, signer_name, auth_subject) values ($1,$2,'skipped','other',$3,$4,$5)`,
          [mid, cur.status, r.decision.stage_reason!.trim().slice(0, 2000), a.signer, a.sub]);
        await audit(c, a, { entityType: "marketplace", entityId: mid, marketplaceId: mid, action: "status_change", before: { status: cur.status }, after: { status: "skipped", import_batch_id: batch.id } });
        fieldChanges.push({ field: "status", before: cur.status, after: "skipped" });
        totals.stage_changes++;
      }
    }
    for (const k of r.add.contacts) {
      const ins = await c.query(
        `insert into partner_contacts (marketplace_id, name, title, role, rank, email, phone, profile_url, source_urls, checked_on, role_verification, confidence, note, source_key, import_batch_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) on conflict do nothing returning id`,
        [mid, k.name, k.title, k.role, k.rank, k.email, k.phone, k.profile_url, k.source_urls.slice(0, 12), k.checked_on, k.role_verification, k.confidence, k.note, k.key, batch.id, a.signer]);
      if (ins.rowCount) created.contacts.push(ins.rows[0].id);
    }
    for (const k of r.add.routes) {
      const ins = await c.query(
        `insert into partner_applications (marketplace_id, purpose, label, url, detail, checked_on, source_key, import_batch_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing returning id`,
        [mid, k.purpose, k.label, k.url, k.detail, k.checked_on, k.key, batch.id, a.signer]);
      if (ins.rowCount) created.applications.push(ins.rows[0].id);
    }
    for (const k of r.add.requirements) {
      const ins = await c.query(
        `insert into requirements (marketplace_id, category, requirement, confirmation_state, source_ref, verified_on, created_by, kind, applicability, verification, finding_key, import_batch_id)
         values ($1,$2,$3,'unverified',$4,$5,$6,$7,$8,$9,$10,$11) on conflict (finding_key) do nothing returning id`,
        [mid, k.category, k.requirement, k.source_ref, k.verified_on, a.signer, k.kind, k.applicability, k.verification, reqKey(mid, k), batch.id]);
      if (ins.rowCount) created.requirements.push(ins.rows[0].id);
    }
    totals.contacts += created.contacts.length; totals.routes += created.applications.length; totals.requirements += created.requirements.length;
    // The partner's version once this import has finished with it: reversal deletes a partner it created only if the
    // record is still at exactly this version (any later edit, even one, preserves it).
    const postVersion = (await c.query("select version from marketplaces where id = $1", [mid])).rows[0].version;
    await c.query(
      `insert into partner_import_items (batch_id, line, company, outcome, marketplace_id, created_partner, field_changes, created_rows, conflicts, decision, row_data, post_import_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [batch.id, r.line, r.company.slice(0, 200), r.outcome, mid, createdPartner, JSON.stringify(fieldChanges), JSON.stringify(created), JSON.stringify(conflicts),
        r.decision ? JSON.stringify(r.decision) : null, JSON.stringify(mapped), postVersion]);
  }
  await c.query("update partner_import_batches set summary = summary || $2 where id = $1", [batch.id, JSON.stringify({ totals })]);
  await audit(c, a, { entityType: "partner_import_batch", entityId: batch.id, action: "apply", after: { source_name: sourceName, outcomes: p.summary, totals } });
  if (lateConflicts.length) await c.query("update partner_import_batches set summary = summary || $2 where id = $1", [batch.id, JSON.stringify({ late_conflicts: lateConflicts })]);
  return { batch_id: batch.id, summary: p.summary, by_priority: p.by_priority, totals, late_conflicts: lateConflicts };
}

// ------------------------------------------------------------------ reverse
/** Undo one batch: removes what it created (unless edited since), restores filled fields (unless changed since),
 *  deletes partners it created only when nothing else has been attached to them. Everything kept is reported. */
export async function reverseImport(c: pg.PoolClient, a: Actor, batchId: string) {
  const b = (await c.query("select * from partner_import_batches where id = $1 for update", [batchId])).rows[0];
  if (!b) throw badRequest("Import batch not found.");
  if (b.status === "reversed") throw badRequest("This import was already reversed.");
  const items = (await c.query("select * from partner_import_items where batch_id = $1 and marketplace_id is not null order by line desc", [batchId])).rows;
  const kept: { line: number; company: string; what: string }[] = [];
  let removed = 0, restored = 0, partnersRemoved = 0;
  for (const it of items) {
    const cr = it.created_rows ?? {};
    for (const [table, ids] of [["partner_contacts", cr.contacts], ["partner_applications", cr.applications], ["requirements", cr.requirements]] as const) {
      for (const id of (ids ?? []) as string[]) {
        const del = await c.query(`delete from ${table} where id = $1 and version = 1 and removed_at is null returning id`, [id]);
        if (del.rowCount) removed++;
        else if ((await c.query(`select 1 from ${table} where id = $1`, [id])).rowCount) kept.push({ line: it.line, company: it.company, what: `${table.replace("partner_", "")} row edited since the import` });
      }
    }
    const cur = (await c.query("select * from marketplaces where id = $1 for update", [it.marketplace_id])).rows[0];
    if (it.created_partner && cur && await removeIfUntouched(c, cur, batchId, b.created_by, it.post_import_version)) { partnersRemoved++; continue; }
    if (it.created_partner && cur) kept.push({ line: it.line, company: it.company, what: "partner kept: other records or edits were added after the import" });
    for (const ch of [...(it.field_changes ?? [])].reverse()) {
      if (!cur) break;
      if (ch.field === "status") {
        if (cur.status === "skipped") {
          await c.query("update marketplaces set status = $2, updated_at = now(), version = version + 1 where id = $1", [cur.id, ch.before]);
          await c.query(`insert into status_history (marketplace_id, from_status, to_status, reason, detail, signer_name, auth_subject) values ($1,'skipped',$2,null,$3,$4,$5)`,
            [cur.id, ch.before, `Import reversed (${b.source_name})`, a.signer, a.sub]);
          restored++;
        } else kept.push({ line: it.line, company: it.company, what: `stage changed since the import (now ${cur.status})` });
        continue;
      }
      if (same(cur[ch.field], ch.after)) {
        await c.query(`update marketplaces set ${ch.field} = $2, updated_at = now(), version = version + 1 where id = $1`, [cur.id, ch.before]);
        restored++;
      } else kept.push({ line: it.line, company: it.company, what: `${ch.field} changed since the import` });
    }
  }
  await c.query("update partner_import_batches set status = 'reversed', reversed_at = now(), reversed_by = $2 where id = $1", [batchId, a.signer]);
  await audit(c, a, { entityType: "partner_import_batch", entityId: batchId, action: "reverse", after: { removed, restored, partners_removed: partnersRemoved, kept } });
  return { removed, restored, partners_removed: partnersRemoved, kept };
}

async function removeIfUntouched(c: pg.PoolClient, cur: any, batchId: string, importer: string, postImportVersion: number | null) {
  const n = (await c.query(
    `select (select count(*) from partner_contacts where marketplace_id = $1)
          + (select count(*) from partner_applications where marketplace_id = $1)
          + (select count(*) from requirements where marketplace_id = $1)
          + (select count(*) from communications where marketplace_id = $1)
          + (select count(*) from marketplace_products where marketplace_id = $1)
          + (select count(*) from corporate_actions where marketplace_id = $1)
          + (select count(*) from supplier_resources where marketplace_id = $1)
          + (select count(*) from sample_requests where marketplace_id = $1)
          + (select count(*) from review_items where marketplace_id = $1)
          + (select count(*) from corporate_task_requests where $1 = any(marketplace_ids))
          + (select count(*) from pricing_records where channel_id = $2)
          + (select count(*) from monthly_revenue where channel_id = $2)
          + (select count(*) from status_history where marketplace_id = $1 and signer_name <> $3)
          + (select count(*) from setup_milestones where marketplace_id = $1 and (state <> 'pending' or not is_default or removed_at is not null))
          + (select count(*) from partner_import_items i join partner_import_batches pb on pb.id = i.batch_id
             where i.marketplace_id = $1 and i.batch_id <> $4 and pb.status = 'applied') as n`,
    [cur.id, cur.channel_id, importer, batchId])).rows[0].n;
  // The record must be exactly as the import left it: any later edit (owner, opportunity, stage…) bumps the version,
  // and an item without a recorded version is never deleted.
  if (Number(n) !== 0 || postImportVersion == null || cur.version !== postImportVersion) return false;
  await c.query("delete from setup_milestones where marketplace_id = $1", [cur.id]);
  await c.query("delete from status_history where marketplace_id = $1", [cur.id]);
  await c.query("update partner_import_items set marketplace_id = null where marketplace_id = $1", [cur.id]);
  await c.query("delete from marketplaces where id = $1", [cur.id]);
  await c.query("delete from channels where id = $1", [cur.channel_id]);
  return true;
}
