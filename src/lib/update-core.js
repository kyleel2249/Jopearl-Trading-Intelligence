// Pure, dependency-free update logic shared by the Android WebView (via Vite) and the
// Electron main process (loaded with a dynamic import). Nothing here touches the network,
// the DOM, or Electron, so it is fully unit-testable with `node --test`.

export const DEFAULT_UPDATE_REPO = 'kyleel2249/Jopearl-Trading-Intelligence';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(value) {
  const match = SEMVER.exec(String(value ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : []
  };
}

function comparePre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1; // a release outranks its own pre-release
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) { const d = Number(a[i]) - Number(b[i]); if (d) return d < 0 ? -1 : 1; }
    else if (an) return -1;
    else if (bn) return 1;
    else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Returns <0, 0 or >0. Unparseable versions sort lowest so they can never look "newer".
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch) || comparePre(a.pre, b.pre);
}

// CI tags every build v<MAJOR>.<MINOR>.<run_number> and uses the same run number as the Android
// versionCode, so the patch component is the monotonically increasing build number.
export function buildNumberFromTag(tag) {
  const parsed = parseVersion(tag);
  return parsed ? parsed.patch : null;
}

// Newest usable release: not a draft, strict x.y.z tag, at least one asset. Prereleases are allowed
// because CI publishes every build as a prerelease. Highest semantic version wins (not list order).
export function selectRelease(releases, { allowPrerelease = true } = {}) {
  if (!Array.isArray(releases)) return null;
  let best = null;
  for (const release of releases) {
    if (!release || release.draft) continue;
    if (release.prerelease && !allowPrerelease) continue;
    if (!/^v?\d+\.\d+\.\d+$/.test(String(release.tag_name || ''))) continue;
    if (!Array.isArray(release.assets) || !release.assets.length) continue;
    if (!best || compareVersions(release.tag_name, best.tag_name) > 0) best = release;
  }
  return best;
}

export const ASSET_TARGETS = Object.freeze({
  'android-apk': /\.apk$/i,
  'win-installer': /setup.*\.exe$/i,
  'win-portable': /portable.*\.exe$/i,
  'linux-appimage': /\.AppImage$/i,
  'linux-deb': /\.deb$/i,
  'mac-dmg': /\.dmg$/i
});

export function pickAsset(release, target) {
  const pattern = ASSET_TARGETS[target];
  if (!pattern || !release || !Array.isArray(release.assets)) return null;
  const matches = release.assets.filter((asset) => asset && pattern.test(String(asset.name || '')) && asset.browser_download_url);
  if (!matches.length) return null;
  if (target === 'android-apk') {
    // Prefer the production-signed APK when CI produced both flavours.
    return matches.find((asset) => /release/i.test(asset.name)) || matches[0];
  }
  return matches[0];
}

export function checksumsAsset(release) {
  return (release?.assets || []).find((asset) => /^SHA256SUMS(\.txt)?$/i.test(String(asset?.name || ''))) || null;
}

const HEX64 = /^[0-9a-f]{64}$/i;

// GitHub exposes "sha256:<hex>" in the asset `digest` field for assets uploaded since mid-2025.
export function sha256FromDigest(asset) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(String(asset?.digest || '').trim());
  return match ? match[1].toLowerCase() : null;
}

// Parses `sha256sum` output: "<hex>  <name>" or "<hex> *<name>". GitHub rewrites spaces in asset
// names to dots, so both spellings of a name resolve to the same entry.
export function parseChecksums(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (!match) continue;
    const name = match[2].replace(/^\.\//, '');
    const hash = match[1].toLowerCase();
    map.set(name, hash);
    map.set(name.replace(/ /g, '.'), hash);
  }
  return map;
}

export function lookupChecksum(map, assetName) {
  if (!(map instanceof Map)) return null;
  const hash = map.get(assetName) || map.get(String(assetName).replace(/ /g, '.')) || null;
  return hash && HEX64.test(hash) ? hash.toLowerCase() : null;
}

export function isAllowedDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return host === 'github.com' || host.endsWith('.github.com') || host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com');
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
}

// Release notes are rendered as plain text by React; trim so a huge changelog cannot swamp the UI.
export function summarizeNotes(body, limit = 1200) {
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

export function releasesApiUrl(repo = DEFAULT_UPDATE_REPO) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Update repository must look like owner/name.');
  return `https://api.github.com/repos/${repo}/releases?per_page=20`;
}

export function releasesPageUrl(repo = DEFAULT_UPDATE_REPO) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Update repository must look like owner/name.');
  return `https://github.com/${repo}/releases`;
}
