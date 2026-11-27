Pod::Spec.new do |s|
  s.name = 'TensorFoldNavigation'
  s.version = '1.0.0'
  s.summary = 'Native CoreLocation heading and MapKit walking directions for NearDar'
  s.description = s.summary
  s.license = { :type => 'UNLICENSED' }
  s.author = 'NearDar'
  s.homepage = 'https://example.com'
  s.source = { :git => 'https://example.com/neardar.git' }
  s.platforms = { :ios => '17.0' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreLocation', 'MapKit'
  s.source_files = '**/*.swift'
end
