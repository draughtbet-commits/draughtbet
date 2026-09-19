import {
  resolveAppVersionPolicy,
  isVersionSupported,
  formatPolicyForResponse
} from '../utils/appVersion.js';

const APP_VERSION_SOURCES = [
  (req) => req.get('x-app-version'),
  (req) => req.body?.appVersion,
  (req) => req.body?.deviceInfo?.appVersion,
  (req) => req.query?.appVersion
];

export const extractAppVersion = (req) => {
  for (const source of APP_VERSION_SOURCES) {
    const value = source(req);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

export const requireAppVersion = (req, res, next) => {
  const policy = resolveAppVersionPolicy();
  if (!policy) return next();

  const version = extractAppVersion(req);
  if (!version || !isVersionSupported(version)) {
    return res.status(426).json({
      error: 'UPGRADE_REQUIRED',
      message: 'This version of the app is no longer supported. Update the app to continue.',
      ...formatPolicyForResponse(policy)
    });
  }
  return next();
};