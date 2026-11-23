// Cloudflare-hosted JPTI does not ship third-party analytics SDKs.
// Cloudflare Web Analytics can be enabled at the Pages project level without
// embedding private credentials in the app. Native clients safely no-op here.
export async function trackEvent() { return false; }
export async function trackScreen() { return false; }
export async function trackAppOpen() { return false; }
