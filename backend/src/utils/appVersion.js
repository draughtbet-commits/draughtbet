// Minimum app-version enforcement. Policy has three shapes:
//   - neither env var set        -> guard disabled (dev/test default)
//   - MIN_APP_VERSION=2.1.0      -> any version >= 2.1.0 is supported
//   - SUPPORTED_APP_VERSIONS=... -> exact-match allowlist (comma separated)
// When both are set, a version must satisfy the floor AND the allowlist.
// Policy is resolved fresh per call (env-driven, mirrors jwtEnv.js patterns).

export const parseVersion = (value) => {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[+-].*)?$/.exec(value.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0) };
};

export const formatVersion = (v) => `${v.major}.${v.minor}.${v.patch}`;

export const compareVersions = (a, b) => {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
};

export const resolveAppVersionPolicy = () => {
  const minRaw = (process.env.MIN_APP_VERSION || '').trim();
  const listRaw = (process.env.SUPPORTED_APP_VERSIONS || '').trim();

  const min = minRaw ? parseVersion(minRaw) : null;
  const list = listRaw
    ? listRaw.split(',').map((s) => parseVersion(s.trim())).filter(Boolean)
    : null;

  if (!minRaw && !listRaw) return null;
  return { min, list: list && list.length ? list : null };
};

export const isVersionSupported = (version, policy = resolveAppVersionPolicy()) => {
  if (!policy) return true;

  const parsed = parseVersion(version);
  if (!parsed) return false;

  if (policy.min && compareVersions(parsed, policy.min) < 0) return false;
  if (policy.list) return policy.list.some((v) => compareVersions(parsed, v) === 0);
  return true;
};

export const formatPolicyForResponse = (policy) => ({
  minimumVersion: policy?.min ? formatVersion(policy.min) : null,
  supportedVersions: policy?.list ? policy.list.map(formatVersion) : null
});