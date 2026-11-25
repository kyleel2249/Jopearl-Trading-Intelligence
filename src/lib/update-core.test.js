import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion, compareVersions, buildNumberFromTag, selectRelease, pickAsset, checksumsAsset,
  sha256FromDigest, parseChecksums, lookupChecksum, isAllowedDownloadUrl, formatBytes,
  summarizeNotes, releasesApiUrl
} from './update-core.js';

const HASH = 'a'.repeat(64);
const asset = (name, extra = {}) => ({ name, browser_download_url: `https://github.com/o/r/releases/download/v0.3.9/${name}`, ...extra });

test('parseVersion accepts v-prefixed and plain versions and rejects junk', () => {
  assert.deepEqual(parseVersion('v0.3.12'), { major: 0, minor: 3, patch: 12, pre: [] });
  assert.equal(parseVersion('1.0'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(undefined), null);
});

test('compareVersions orders numerically, not lexically', () => {
  assert.ok(compareVersions('0.3.10', '0.3.9') > 0);
  assert.ok(compareVersions('v0.4.1', '0.3.99') > 0);
  assert.equal(compareVersions('v0.3.4', '0.3.4'), 0);
  assert.ok(compareVersions('0.3.4-beta.1', '0.3.4') < 0);
  assert.ok(compareVersions('not-a-version', '0.0.1') < 0);
});

test('buildNumberFromTag returns the CI run number', () => {
  assert.equal(buildNumberFromTag('v0.3.57'), 57);
  assert.equal(buildNumberFromTag('nightly'), null);
});

test('selectRelease picks the highest semver, skipping drafts, bad tags and asset-less releases', () => {
  const releases = [
    { tag_name: 'v0.3.9', assets: [asset('a.apk')] },
    { tag_name: 'v0.3.11', assets: [asset('a.apk')] },
    { tag_name: 'v0.3.20', draft: true, assets: [asset('a.apk')] },
    { tag_name: 'v0.3.15', assets: [] },
    { tag_name: 'nightly', assets: [asset('a.apk')] },
    { tag_name: 'v0.3.10', prerelease: true, assets: [asset('a.apk')] }
  ];
  assert.equal(selectRelease(releases).tag_name, 'v0.3.11');
  assert.equal(selectRelease(releases, { allowPrerelease: false }).tag_name, 'v0.3.11');
  assert.equal(selectRelease([{ tag_name: 'v0.3.10', prerelease: true, assets: [asset('a.apk')] }], { allowPrerelease: false }), null);
  assert.equal(selectRelease(null), null);
});

test('pickAsset chooses the right package per target and prefers the release APK', () => {
  const release = { assets: [
    asset('JPTI-Android-debug.apk'), asset('JPTI-Android-release.apk'),
    asset('JPTI-Portable-0.3.9.exe'), asset('JPTI-Setup-0.3.9.exe'),
    asset('JPTI-0.3.9-x86_64.AppImage'), asset('JPTI-0.3.9.dmg'), asset('SHA256SUMS.txt')
  ] };
  assert.equal(pickAsset(release, 'android-apk').name, 'JPTI-Android-release.apk');
  assert.equal(pickAsset(release, 'win-installer').name, 'JPTI-Setup-0.3.9.exe');
  assert.equal(pickAsset(release, 'win-portable').name, 'JPTI-Portable-0.3.9.exe');
  assert.equal(pickAsset(release, 'linux-appimage').name, 'JPTI-0.3.9-x86_64.AppImage');
  assert.equal(pickAsset(release, 'linux-deb'), null);
  assert.equal(pickAsset(release, 'unknown'), null);
  assert.equal(checksumsAsset(release).name, 'SHA256SUMS.txt');
});

test('checksum helpers read digests and sha256sum files, including dotted names', () => {
  assert.equal(sha256FromDigest({ digest: `sha256:${HASH.toUpperCase()}` }), HASH);
  assert.equal(sha256FromDigest({ digest: 'md5:abc' }), null);
  assert.equal(sha256FromDigest({}), null);
  const map = parseChecksums(`${HASH}  JPTI Setup 0.3.9.exe\n${'b'.repeat(64)} *JPTI-Android-release.apk\ngarbage line\n`);
  assert.equal(lookupChecksum(map, 'JPTI.Setup.0.3.9.exe'), HASH);
  assert.equal(lookupChecksum(map, 'JPTI Setup 0.3.9.exe'), HASH);
  assert.equal(lookupChecksum(map, 'JPTI-Android-release.apk'), 'b'.repeat(64));
  assert.equal(lookupChecksum(map, 'missing.apk'), null);
  assert.equal(lookupChecksum(null, 'x'), null);
});

test('isAllowedDownloadUrl only allows HTTPS GitHub hosts', () => {
  assert.equal(isAllowedDownloadUrl('https://github.com/o/r/releases/download/v1.0.0/a.apk'), true);
  assert.equal(isAllowedDownloadUrl('https://objects.githubusercontent.com/x'), true);
  assert.equal(isAllowedDownloadUrl('http://github.com/o/r'), false);
  assert.equal(isAllowedDownloadUrl('https://evil.example/github.com'), false);
  assert.equal(isAllowedDownloadUrl('https://github.com.evil.example/a'), false);
  assert.equal(isAllowedDownloadUrl('https://user:pw@github.com/a'), false);
  assert.equal(isAllowedDownloadUrl('not a url'), false);
});

test('formatting and API URL helpers', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(52428800), '50.0 MB');
  assert.equal(formatBytes(-1), '');
  assert.equal(summarizeNotes('x'.repeat(2000), 10), `${'x'.repeat(10)}…`);
  assert.match(releasesApiUrl('a/b'), /repos\/a\/b\/releases/);
  assert.throws(() => releasesApiUrl('../../etc'));
});
