Pod::Spec.new do |s|
  s.name = 'TensorFoldEngine'
  s.version = '1.0.0'
  s.summary = 'On-device TensorFold generation and verified model installation'
  s.license = 'UNLICENSED'
  s.author = 'Sonar'
  s.homepage = 'https://example.com'
  s.source = { git: '' }
  s.platform = :ios, '15.1'
  s.swift_version = '5.10'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.{swift,h,m,mm}'
  s.vendored_frameworks = 'vendor/TensorFoldMobile.xcframework'
  s.frameworks = 'Foundation', 'Metal', 'IOSurface', 'CoreGraphics', 'ImageIO'
  s.libraries = 'objc'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)/../../../engine/include"'
  }
end
