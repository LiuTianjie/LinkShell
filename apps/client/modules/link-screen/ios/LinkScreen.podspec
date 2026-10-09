Pod::Spec.new do |s|
  s.name = 'LinkScreen'
  s.version = '1.0.0'
  s.summary = 'Native low-latency screen receiver for LinkShell'
  s.description = 'Receives encrypted WebRTC video and presents the newest decoded frame with Metal'
  s.author = ''
  s.homepage = 'https://docs.expo.dev/modules/'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  # Share the framework already used by react-native-webrtc; never load two libwebrtc builds.
  s.dependency 'JitsiWebRTC', '~> 124.0.0'
  s.frameworks = 'Metal', 'CoreVideo', 'QuartzCore', 'Network'
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
