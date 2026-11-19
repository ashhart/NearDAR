Pod::Spec.new do |s|
  s.name = 'TensorFoldVoice'
  s.version = '1.0.0'
  s.summary = 'Offline speech recognition, speech synthesis, and headset audio routing'
  s.description = s.summary
  s.license = { :type => 'UNLICENSED' }
  s.author = 'TensorFold'
  s.homepage = 'https://example.com'
  s.source = { :git => 'https://example.com/tensorfold-mobile.git' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFAudio', 'Speech', 'UIKit'
  s.source_files = '**/*.swift'
end
