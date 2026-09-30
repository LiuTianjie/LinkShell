Pod::Spec.new do |s|
  s.name           = 'LinkSocket'
  s.version        = '1.0.0'
  s.summary        = 'WebSocket transport for LinkShell'
  s.description    = 'URLSessionWebSocketTask connections that bypass proxies for local hosts'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
