const { withAndroidManifest, withInfoPlist } = require('@expo/config-plugins');

const DEFAULT_CAMERA_REASON =
  'The camera measures nearby obstacles, finds seating geometry, and reads text on your device.';

function ensureApplicationEntry(manifest, name, value) {
  const application = manifest.manifest.application?.[0];
  if (!application) return;
  application['meta-data'] = application['meta-data'] || [];
  const entries = application['meta-data'];
  const existing = entries.find((entry) => entry.$?.['android:name'] === name);
  if (existing) existing.$['android:value'] = value;
  else entries.push({ $: { 'android:name': name, 'android:value': value } });
}

function withTensorFoldPerception(config, options = {}) {
  config = withInfoPlist(config, (plistConfig) => {
    plistConfig.modResults.NSCameraUsageDescription =
      options.cameraPermission ||
      plistConfig.modResults.NSCameraUsageDescription ||
      DEFAULT_CAMERA_REASON;
    return plistConfig;
  });
  return withAndroidManifest(config, (androidConfig) => {
    const manifest = androidConfig.modResults;
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    if (!manifest['uses-permission'].some((entry) => entry.$?.['android:name'] === 'android.permission.CAMERA')) {
      manifest['uses-permission'].push({ $: { 'android:name': 'android.permission.CAMERA' } });
    }
    ensureApplicationEntry(manifest, 'com.google.ar.core', 'required');
    return androidConfig;
  });
}

module.exports = withTensorFoldPerception;
