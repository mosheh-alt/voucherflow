/**
 * Charity Commission Register of Charities API (England & Wales).
 * Field names follow the Commission's "API data definition v1.2".
 * Operations: https://api-portal.charitycommission.gov.uk/content/API_GET_operations_v1.1.pdf
 *
 * Server-only: the subscription key must never reach the browser.
 */
const BASE = "https://api.charitycommission.gov.uk/register/api";
const str = (v) => (v == null ? "" : String(v).trim());
const date = (v) => (v ? String(v).slice(0, 10) : null);
const num = (v) => (v == null || v === "" ? null : Number(v));
const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const one = (v) => (Array.isArray(v) ? v[0] ?? null : v ?? null);
export class CharityApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
}
async function get(path, key) {
    if (!key)
        throw new CharityApiError("CHARITY_COMMISSION_API_KEY is not set in Cloudflare.", 0);
    const res = await fetch(`${BASE}/${path}`, {
        headers: { "Ocp-Apim-Subscription-Key": String(key).trim(), "Cache-Control": "no-cache" },
    });
    const text = await res.text();
    // The API answers 404 both for "no such charity" and for a wrong address; an address error comes back as JSON with "Resource not found".
    if (res.status === 404 && !/resource not found/i.test(text))
        return null;
    if (res.status === 401 || res.status === 403)
        throw new CharityApiError("The Charity Commission refused Toirem's API key (" + res.status + ").", res.status);
    if (!res.ok)
        throw new CharityApiError(`Charity Commission API ${path.split("/")[0]} failed: ${res.status}`, res.status);
    if (!text)
        return null;
    try { return JSON.parse(text); }
    catch (e) { throw new CharityApiError("The Charity Commission sent an unexpected reply.", res.status); }
}
/** Raw answer for the office "Check connections" button. Never returns the key. */
export async function probe(apiKey, number = "1141178") {
    if (!apiKey)
        return { ok: false, detail: "CHARITY_COMMISSION_API_KEY is not set in Cloudflare." };
    try {
        const res = await fetch(`${BASE}/charitydetails/${number}/0`, { headers: { "Ocp-Apim-Subscription-Key": String(apiKey).trim() } });
        const text = await res.text();
        let name = "";
        try { const j = JSON.parse(text); name = (Array.isArray(j) ? j[0] : j)?.charity_name || ""; } catch (e) { /* not JSON */ }
        const ok = res.ok && !!name;
        return { ok, status: res.status, detail: ok ? `Found ${name || "charity " + number}.` : `Answer ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 200)}` };
    }
    catch (e) { return { ok: false, detail: "Could not reach the Charity Commission: " + e.message }; }
}
/** Search the register by charity name. Returns registered main charities only. */
export async function searchCharities(query, apiKey) {
    const q = String(query || "").trim().replace(/[\/\\?#%]/g, " ").replace(/\s+/g, " ");
    if (q.length < 3)
        return [];
    const rows = arr(await get(`searchCharityName/${encodeURIComponent(q)}`, apiKey));
    const lower = q.toLowerCase();
    return rows
        .filter((r) => str(r.reg_status).toUpperCase() !== "RM" && Number(r.group_subsid_suffix || 0) === 0)
        .map((r) => ({ number: str(r.reg_charity_number), name: str(r.charity_name), registered: date(r.date_of_registration) }))
        .filter((r) => r.number && r.name)
        .sort((a, b) => (b.name.toLowerCase().startsWith(lower) - a.name.toLowerCase().startsWith(lower)) || a.name.localeCompare(b.name))
        .slice(0, 15);
}
export class CharityNotFound extends Error {
}
/** Look up a registered charity and build the due-diligence snapshot. Suffix 0 = the main charity. */
export async function checkCharity(charityNumber, apiKey) {
    const n = charityNumber.replace(/\D/g, "");
    if (!/^\d{6,8}$/.test(n))
        throw new CharityNotFound("Enter a 6 to 8 digit charity number.");
    const [details, overview, finance, govdoc, arAccounts, regulatory] = await Promise.all([
        get(`allcharitydetailsV2/${n}/0`, apiKey),
        get(`charityoverview/${n}/0`, apiKey).catch(() => null),
        get(`charityfinancialhistory/${n}/0`, apiKey).catch(() => null),
        get(`charitygoverningdocument/${n}/0`, apiKey).catch(() => null),
        get(`charityaraccounts/${n}/0`, apiKey).catch(() => null),
        get(`charityregulatoryreport/${n}/0`, apiKey).catch(() => null),
    ]);
    const d = one(details);
    if (!d)
        throw new CharityNotFound(`Charity ${n} was not found on the register.`);
    const ov = one(overview), g = one(govdoc);
    const raw = { details: d, overview: ov, finance, govdoc: g, arAccounts, regulatory };
    const today = new Date().toISOString().slice(0, 10);
    // --- address: up to five lines; the last filled line is usually the town ---
    const lines = ["address_line_one", "address_line_two", "address_line_three", "address_line_four", "address_line_five"]
        .map((k) => str(d[k])).filter(Boolean);
    const town = lines.length > 1 ? lines[lines.length - 1] : "";
    // --- trustees: trustee_names section of allcharitydetailsV2 ---
    const trustees = [...new Set(arr(d.trustee_names).map((t) => str(t.trustee_name)).filter(Boolean))];
    // --- classifications (who / what / how) ---
    const classifications = arr(d.who_what_where).map((c) => str(c.classification_desc)).filter(Boolean);
    // --- finances: last 5 years ---
    const finances = arr(finance).map((f) => ({
        yearEnd: date(f.financial_period_end_date) ?? "",
        income: num(f.income ?? f.inc_total),
        spending: num(f.expenditure ?? f.exp_total),
    })).filter((f) => f.yearEnd).sort((a, b) => b.yearEnd.localeCompare(a.yearEnd));
    // --- accounts & annual return: one row per document per financial year ---
    // title / document_name = "Accounts and TAR" or "Annual Return"; date_due is 10 months after year end.
    const subs = arr(arAccounts).map((r) => ({
        kind: /annual return/i.test(str(r.title || r.document_name)) ? "ar" : "accounts",
        yearEnd: date(r.reporting_period_year_end),
        received: date(r.date_received),
        due: date(r.date_due),
        qualified: !!r.accounts_qualified,
        suppressed: !!r.suppression_ind,
    })).filter((r) => !r.suppressed).sort((a, b) => (b.yearEnd ?? "").localeCompare(a.yearEnd ?? ""));
    const latest = (kind) => subs.find((s) => s.kind === kind && s.received);
    const overdueRow = (kind) => subs.find((s) => s.kind === kind && !s.received && s.due && s.due < today);
    const accLatest = latest("accounts"), accOverdue = overdueRow("accounts");
    const arLatest = latest("ar"), arOverdue = overdueRow("ar");
    const reportingStatus = str(d.reporting_status);
    const statusOverdue = /overdue|double default/i.test(reportingStatus);
    // --- regulatory reports / inquiries ---
    const regulatoryReports = arr(regulatory).map((r) => ({
        title: str(r.report_name) || "Regulatory report",
        published: date(r.date_published),
        url: str(r.report_location) || null,
    }));
    const removedOn = date(d.date_of_removal);
    const registered = str(d.reg_status).toUpperCase() !== "RM" && !removedOn;
    const insolvent = d.insolvent === true;
    const inAdministration = d.in_administration === true;
    const interimManager = d.interim_manager_ind === true;
    const orgNo = str(d.organisation_number) || null;
    const warnings = [];
    if (!registered)
        warnings.push(`Removed from the register${removedOn ? " on " + removedOn : ""}${str(d.removal_reason) ? ` (${str(d.removal_reason)})` : ""}.`);
    if (accOverdue)
        warnings.push(`Accounts overdue (were due ${accOverdue.due}).`);
    if (arOverdue)
        warnings.push(`Annual return overdue (was due ${arOverdue.due}).`);
    if (statusOverdue && !accOverdue && !arOverdue)
        warnings.push(`Reporting status: ${reportingStatus}.`);
    if (accLatest?.qualified)
        warnings.push("Latest accounts have a qualified audit opinion.");
    if (regulatoryReports.length)
        warnings.push(`${regulatoryReports.length} published regulatory report(s) or inquiry: ${regulatoryReports.map((r) => r.title).join(", ")}.`);
    if (insolvent)
        warnings.push("Marked as insolvent.");
    if (inAdministration)
        warnings.push("In administration.");
    if (interimManager)
        warnings.push("An interim manager has been appointed by the Commission.");
    const check = {
        number: n,
        name: str(d.charity_name),
        organisationNumber: orgNo,
        charityType: str(d.charity_type),
        registered,
        regDate: date(d.date_of_registration),
        removedOn,
        removalReason: str(d.removal_reason),
        address: { lines: lines.length > 1 ? lines.slice(0, -1) : lines, town, postcode: str(d.address_post_code), country: "United Kingdom" },
        phone: str(d.phone),
        email: str(d.email),
        website: str(d.web),
        trustees,
        objects: str(g?.charitable_objects),
        areaOfBenefit: str(g?.area_of_benefit),
        activities: str(ov?.activities),
        grantMaking: ov?.grant_making_main_activity === true,
        classifications,
        finances,
        reportingStatus,
        accounts: {
            lastReceived: accLatest?.received ?? null,
            yearEnd: accLatest?.yearEnd ?? date(d.latest_acc_fin_year_end_date),
            overdue: !!accOverdue,
            dueDate: accOverdue?.due ?? null,
            qualified: !!accLatest?.qualified,
        },
        annualReturn: { lastReceived: arLatest?.received ?? null, overdue: !!arOverdue, dueDate: arOverdue?.due ?? null },
        regulatoryReports,
        insolvent,
        inAdministration,
        interimManager,
        // The API does not hand over the accounts PDF itself; this opens the charity's accounts page on the register.
        accountsPageUrl: orgNo
            ? `https://register-of-charities.charitycommission.gov.uk/charity-search/-/charity-details/${orgNo}/accounts-and-annual-returns`
            : null,
        warnings,
        checkedAt: new Date().toISOString(),
    };
    return { check, raw };
}
export const TOIREM_CHARITY_NUMBER = "1206622";
/**
 * Current trustees with their role, e.g. for "Signed for Toirem by".
 * charitytrusteeinformationV2 returns one row per trustee per OTHER charity they also serve,
 * so rows are de-duplicated by trustee_id.
 */
export async function getTrustees(charityNumber, apiKey) {
    const n = charityNumber.replace(/\D/g, "");
    const info = await get(`charitytrusteeinformationV2/${n}/0`, apiKey).catch(() => null);
    const byId = new Map();
    for (const t of arr(info)) {
        const name = str(t.name);
        if (!name)
            continue;
        const id = str(t.trustee_id) || name;
        const prev = byId.get(id);
        byId.set(id, {
            name,
            position: t.is_chair === true || prev?.position === "Chair" ? "Chair" : "Trustee",
            appointed: date(t.date_of_appointment) ?? prev?.appointed ?? null,
        });
    }
    let rows = [...byId.values()];
    if (!rows.length) { // fall back to names only
        const names = await get(`charitytrusteenamesV2/${n}/0`, apiKey).catch(() => null);
        rows = [...new Set(arr(names).map((t) => str(t.trustee_name)).filter(Boolean))].map((name) => ({ name, position: "Trustee", appointed: null }));
    }
    return rows.sort((a, b) => (a.position === "Chair" ? -1 : b.position === "Chair" ? 1 : a.name.localeCompare(b.name)));
}
/** Compare a fresh check with the one stored at submission; returns new problems only. */
export function newProblems(before, after) {
    const old = new Set(before?.warnings ?? []);
    return after.warnings.filter((w) => !old.has(w));
}
