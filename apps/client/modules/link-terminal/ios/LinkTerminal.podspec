Pod::Spec.new do |s|
  s.name           = 'LinkTerminal'
  s.version        = '1.0.0'
  s.summary        = 'Native terminal view for LinkShell'
  s.description    = 'SwiftTerm (MIT, vendored) driven by a remote shell'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # SwiftTerm is vendored into this module; its sources compile unoptimized-safe.
    'SWIFT_STRICT_CONCURRENCY' => 'minimal',
  }

  s.source_files = "**/*.swift"
  s.exclude_files = ["SwiftTerm/Mac/**/*"]
end
