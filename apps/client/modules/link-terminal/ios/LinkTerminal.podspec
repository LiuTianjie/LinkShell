Pod::Spec.new do |s|
  s.name           = 'LinkTerminal'
  s.version        = '1.0.0'
  s.summary        = 'Native terminal view for LinkShell'
  s.description    = 'Ghostty Metal terminal driven by a remote shell'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  s.dependency 'GhosttyTerminal'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_STRICT_CONCURRENCY' => 'minimal',
  }

  s.source_files = "*.swift"
end
