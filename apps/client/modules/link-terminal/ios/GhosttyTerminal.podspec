Pod::Spec.new do |s|
  s.name = 'GhosttyTerminal'
  s.version = '2.2.0'
  s.summary = 'Pinned Ghostty mobile terminal component'
  s.author = 'Lakr233'
  s.homepage = 'https://github.com/Lakr233/libghostty-spm'
  s.license = { :type => 'MIT', :file => 'vendor/LICENSE-libghostty-spm.txt' }
  s.source = { :git => s.homepage + '.git' }
  s.static_framework = true
  s.ios.deployment_target = '16.4'
  s.swift_version = '6.0'
  s.pod_target_xcconfig = { 'SWIFT_VERSION' => '6.0', 'OTHER_SWIFT_FLAGS' => '$(inherited) -enable-upcoming-feature NonisolatedNonsendingByDefault -enable-upcoming-feature InferIsolatedConformances -enable-upcoming-feature MemberImportVisibility -enable-upcoming-feature ExistentialAny' }
  s.source_files = 'vendor/GhosttyTerminal/**/*.swift'
  s.dependency 'GhosttyKit'
  s.dependency 'DisplayLink'

  s.resource_bundles = { 'LinkGhosttyResources' => ['vendor/GhosttyTerminal/Resources/Ghostty', 'vendor/GhosttyTerminal/Resources/terminfo', 'vendor/GhosttyTerminal/Resources/Localizable.xcstrings'] }
end
