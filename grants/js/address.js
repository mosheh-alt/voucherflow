/* =====================================================================
   Toirem – UK address lookup (Google Places API (New), PlaceAutocompleteElement).
   Used only by the pages with an address form (/grants/apply.html, /grants/individual.html).

   The API key is NOT in this file: it is the Cloudflare setting GOOGLE_MAPS_KEY, read from
   /api/grants/config. With no key, or if Google fails, nothing is shown and the normal
   address boxes work as before.

   Usage:  mountAddressLookup(slotElement, 'person', (a) => { ...fill your fields... })
           a = { line1, line2, town, county, postcode }
   ===================================================================== */

let loading = null;        // one shared load of the Google script
const widgets = {};        // one search box per address on the page, kept across re-renders

/** Load the Maps JavaScript API once (loading=async + callback), then the "places" library. Resolves to the library or null. */
function loadPlaces() {
  if (loading) return loading;
  loading = (async () => {
    let key = '';
    try {
      const r = await fetch('/api/grants/config', { headers: { Accept: 'application/json' } });
      key = (await r.json()).mapsKey || '';
    } catch (e) { return null; }
    if (!key) return null; // not set up: keep the manual form
    const ready = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 12000);           // slow or blocked network
      window.__toiremMapsReady = () => { clearTimeout(timer); resolve(true); };
    });
    // A rejected key (wrong website, API not enabled, billing): Google calls this. Remove the boxes.
    window.gm_authFailure = () => { Object.values(widgets).forEach((w) => w.el.closest('.addr-find')?.remove()); widgets.failed = true; };
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({ key, loading: 'async', callback: '__toiremMapsReady', v: 'weekly', region: 'GB', language: 'en-GB' });
    document.head.appendChild(s);
    const ok = await Promise.race([ready, new Promise((res) => { s.onerror = () => res(false); })]);
    if (!ok || !window.google || !google.maps || !google.maps.importLibrary) return null;
    try { return await google.maps.importLibrary('places'); } catch (e) { return null; }
  })();
  return loading;
}

/** Pull the parts we need out of the Place's address components. */
function toAddress(components) {
  const get = (type) => ((components || []).find((c) => (c.types || []).includes(type)) || {}).longText || '';
  return {
    // e.g. "Flat 2, 10 High Street": the flat, then house number and street
    line1: [get('subpremise'), [get('street_number'), get('route')].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    line2: get('sublocality_level_1') || get('neighborhood'),
    town: get('postal_town') || get('locality'),
    county: get('administrative_area_level_2'),
    postcode: get('postal_code').toUpperCase(),
  };
}

/**
 * Put a "Find your address" search box into `slot` (an empty element in the form).
 * The pages re-draw their HTML often, so the same box is moved into the new slot each time.
 */
export async function mountAddressLookup(slot, id, onPick) {
  if (!slot) return;
  if (widgets[id]) { widgets[id].onPick = onPick; slot.appendChild(widgets[id].wrap); return; }
  const lib = await loadPlaces();
  if (!lib || !lib.PlaceAutocompleteElement || widgets.failed) return;
  if (widgets[id]) { widgets[id].onPick = onPick; slot.appendChild(widgets[id].wrap); return; } // created while we waited
  let el;
  try {
    el = new lib.PlaceAutocompleteElement({ includedRegionCodes: ['gb'], includedPrimaryTypes: ['street_address', 'premise'] });
  } catch (e) { return; }
  el.id = 'addr-' + id;
  const wrap = document.createElement('div');
  wrap.className = 'addr-find';
  wrap.innerHTML = '<span class="lab">Find your address <span class="opt">(start typing, then pick it – or fill in the boxes below)</span></span>';
  wrap.appendChild(el);
  const w = widgets[id] = { el, wrap, onPick };
  // gmp-select is the current event (it replaced gmp-placeselect in 2025).
  el.addEventListener('gmp-select', async ({ placePrediction }) => {
    try {
      const place = placePrediction.toPlace();
      await place.fetchFields({ fields: ['addressComponents'] });   // only this field: cheapest billing tier
      w.onPick(toAddress(place.addressComponents));
    } catch (e) { /* leave the form as it is; the person can type the address */ }
  });
  // Older versions of the widget (just in case): same handling.
  el.addEventListener('gmp-placeselect', async (ev) => {
    try { await ev.place.fetchFields({ fields: ['addressComponents'] }); w.onPick(toAddress(ev.place.addressComponents)); } catch (e) { /* */ }
  });
  el.addEventListener('gmp-error', () => { wrap.remove(); delete widgets[id]; });
  slot.appendChild(wrap);
}
