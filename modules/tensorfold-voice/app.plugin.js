const { withInfoPlist } = require('expo/config-plugins');

const withTensorFoldVoice = (config) => withInfoPlist(config, (info) => {
  info.modResults.NSMicrophoneUsageDescription ??=
    'Allows hands-free commands to be recognized on your device.';
  info.modResults.NSSpeechRecognitionUsageDescription ??=
    'Allows your voice commands to be recognized on your device without sending audio to a server.';
  return info;
});

module.exports = withTensorFoldVoice;
