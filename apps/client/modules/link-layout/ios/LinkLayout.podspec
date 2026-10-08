Pod::Spec.new do |s|
  s.name = 'LinkLayout'
  s.version = '1.0.0'
  s.summary = 'Window-local layout regions for LinkShell'
  s.description = 'Reports safe areas and folding regions without identifying a device model'
  s.author = ''
  s.homepage = 'https://docs.expo.dev/modules/'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  xcconfig = { 'DEFINES_MODULE' => 'YES' }
  # Older Xcode installations can still build the ordinary adaptive layout.
  sdk = `xcrun --sdk iphonesimulator --show-sdk-version`.strip
  if Gem::Version.new(sdk) >= Gem::Version.new('27.1')
    xcconfig['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = '$(inherited) LINK_LAYOUT_RESERVED_REGIONS'
  end
  s.pod_target_xcconfig = xcconfig
end
