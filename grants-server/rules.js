/** Business rules shared by the office screens, emails and scheduled jobs. Pure functions, no I/O. */
export const DEFAULT_AGREEMENT_THRESHOLD = 20000; // £; grants at or above this need a signed agreement
export const needsAgreement = (amount, threshold = DEFAULT_AGREEMENT_THRESHOLD) => amount != null && amount >= threshold;
export const paysClubAccount = (g) => !g.registered && g.route === "club" && !g.routeOverride;
export const totalPaid = (g) => Math.round(g.payments.reduce((s, p) => s + p.amount, 0) * 100) / 100;
export function statusOf(g, threshold = DEFAULT_AGREEMENT_THRESHOLD) {
    if (g.openAlerts > 0)
        return "Needs attention";
    if (g.approvedAmount == null)
        return "New application";
    if (needsAgreement(g.approvedAmount, threshold) && g.agreement?.status !== "signed")
        return g.agreement?.status === "sent" ? "Awaiting signature" : "Agreement to send";
    const open = g.breakdowns.find((b) => b.status !== "closed");
    if (open)
        return open.status === "requested" ? "Breakdown requested" : open.status === "submitted" ? "Breakdown to review" : "Proof requested";
    if (paysClubAccount(g) && g.payments.length && g.receiptsOutstanding > 0)
        return "Receipts due";
    if (!g.payments.length)
        return "Approved";
    return totalPaid(g) >= g.approvedAmount ? "Fully paid" : "Active";
}
/** Payments may be recorded only once any required agreement is signed, and never beyond the approved amount. */
export function checkPayment(g, amount, threshold = DEFAULT_AGREEMENT_THRESHOLD) {
    if (g.approvedAmount == null)
        return "Approve the grant first.";
    if (needsAgreement(g.approvedAmount, threshold) && g.agreement?.status !== "signed")
        return "The grant agreement must be signed before payment.";
    if (!(amount > 0))
        return "Enter the amount paid.";
    const left = g.approvedAmount - totalPaid(g);
    if (amount > left + 0.005)
        return `That's more than the £${left.toFixed(2)} remaining.`;
    return null;
}
/** Pick roughly a third of breakdown lines (at least one) at random for a proof spot-check. Trustees can change the pick. */
export function suggestProofLines(count, rand = Math.random) {
    if (count <= 0)
        return [];
    const k = Math.min(count, Math.max(1, Math.round(count / 3)));
    const idx = Array.from({ length: count }, (_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx.slice(0, k).sort((a, b) => a - b);
}
/** Payments falling inside a breakdown period (inclusive). */
export const paymentsInPeriod = (payments, from, to) => payments.filter((p) => p.paidOn >= from && p.paidOn <= to);
