Pod::Spec.new do |s|
  s.name           = 'ShareConfigModule'
  s.version        = '1.0.0'
  s.summary        = 'Writes the share key into the App Group for the Share Extension.'
  s.description    = 'Local Expo module. See mobile/modules/share-config/ios/ShareConfigModule.swift.'
  s.license        = 'UNLICENSED'
  s.author         = 'Findable'
  s.homepage       = 'https://github.com/LeoPrasanna/findable'
  s.platform       = :ios, '15.1'
  s.swift_version  = '5.0'
  s.source         = { git: 'https://github.com/LeoPrasanna/findable' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
