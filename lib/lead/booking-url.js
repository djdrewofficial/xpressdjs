/** Contact fields that must not be copied into a third-party booking URL. */
const CONTACT_KEYS = /^(first_name|last_name|email|phone|name|full_name|firstname|lastname)$/i;

/**
 * Booking widget URL with any contact query parameters removed.
 * Name, email, and phone belong in the visitor's own entry on the widget, not in the address.
 */
export function bookingFrameSrc(bookingUrl) {
  const u = new URL(bookingUrl);
  const kept = new URLSearchParams();
  for (const [key, value] of u.searchParams) {
    if (!CONTACT_KEYS.test(key)) kept.append(key, value);
  }
  u.search = kept.toString();
  return u.toString();
}

export function queryHasContact(url) {
  const u = new URL(url);
  for (const key of u.searchParams.keys()) {
    if (CONTACT_KEYS.test(key)) return true;
  }
  return false;
}
