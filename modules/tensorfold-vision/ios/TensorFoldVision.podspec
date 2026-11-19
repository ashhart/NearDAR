Pod::Spec.new do |s|
  s.name = 'TensorFoldVision'
  s.version = '1.0.0'
  s.summary = 'Explicit on-device SmolVLM2 scene queries through LiteRT-LM'
  s.description = s.summary
  s.license = { :type => 'UNLICENSED' }
  s.author = 'TensorFold'
  s.homepage = 'https://example.com'
  s.source = { :git => 'https://example.com/tensorfold-mobile.git' }
  s.platforms = { :ios => '15.0' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Foundation', 'ImageIO', 'Metal', 'UIKit'
  s.source_files = '*.swift', 'LiteRTLM/*.swift'
  s.vendored_frameworks = 'vendor/CLiteRTLM.xcframework'
end
