const UK = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
export async function lookupPostcode(input) {
    const pc = input.trim().toUpperCase();
    if (!UK.test(pc))
        return { ok: false, message: "That doesn't look like a UK postcode. Check it and try again." };
    const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`);
    if (res.status === 404)
        return { ok: false, message: "We couldn't find that postcode. Check it and try again." };
    if (!res.ok)
        return { ok: false, message: "Postcode lookup is unavailable. Type the town yourself." };
    const { result } = (await res.json());
    return {
        ok: true,
        postcode: result.postcode,
        town: result.admin_district ?? result.parish ?? "",
        county: result.admin_county ?? result.region ?? "",
        country: result.country === "England" || result.country === "Wales" || result.country === "Scotland" || result.country === "Northern Ireland"
            ? "United Kingdom" : result.country,
    };
}
