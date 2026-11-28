cmake_minimum_required(VERSION 3.22)
project(LinkShellMedia LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT WIN32)
  message(FATAL_ERROR "LinkShell native Windows binaries require WIN32.")
endif()

option(LINKSHELL_BUILD_SCREEN "Build LinkShell.Screen.exe native helper" ON)
option(LINKSHELL_BUILD_MEDIA "Build LinkShell.Media.exe native libwebrtc media engine" ON)
option(LINKSHELL_BUILD_QA "Build LinkShell.InputQA.exe development input probe" OFF)

# Match upstream Chromium/LiveKit static release CRT (/MT) so shipped binaries have zero MSVC redist dependencies.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(LINKSHELL_COMMON_DEFS
  NOMINMAX
  WIN32_LEAN_AND_MEAN
  _WIN32_WINNT=0x0A00
  WINVER=0x0A00
  NTDDI_VERSION=0x0A00000C
  UNICODE
  _UNICODE
  _CRT_SECURE_NO_WARNINGS
  _CRT_NONSTDC_NO_WARNINGS
  JSON_USE_IMPLICIT_CONVERSIONS=0
)

if(LINKSHELL_BUILD_SCREEN)
  # Standalone C++20 Win32 helper (`LinkShell.Screen.exe`).
  # Security invariant: LinkShellScreenService copies ONLY `LinkShell.Screen.exe` into Program Files to run as
  # LocalSystem; it MUST NOT link `webrtc.lib`, Node, or Chromium.
  add_executable(LinkShell.Screen
    src/helper/screen_main.cpp
    src/helper/screen_common.cpp
    src/helper/jpeg_capture.cpp
    src/helper/vdd_installer.cpp
    src/helper/screen_service.cpp
    src/helper/fusion_helper.cpp
    LinkShell.Screen.manifest
  )

  set_target_properties(LinkShell.Screen PROPERTIES
    OUTPUT_NAME "LinkShell.Screen"
  )

  target_include_directories(LinkShell.Screen PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${CMAKE_CURRENT_SOURCE_DIR}/third_party"
  )

  target_compile_definitions(LinkShell.Screen PRIVATE
    ${LINKSHELL_COMMON_DEFS}
  )

  target_compile_options(LinkShell.Screen PRIVATE
    /utf-8
    /EHsc
    /W3
    /wd4100
    /wd4244
    /wd4267
    $<$<CONFIG:Release>:/O2>
  )

  target_link_options(LinkShell.Screen PRIVATE
    /OPT:REF
    /OPT:ICF
    /SUBSYSTEM:CONSOLE
  )

  target_link_libraries(LinkShell.Screen PRIVATE
    d3d11.lib
    dxgi.lib
    dxguid.lib
    ole32.lib
    oleaut32.lib
    uuid.lib
    propsys.lib
    gdi32.lib
    gdiplus.lib
    user32.lib
    shell32.lib
    shlwapi.lib
    dwmapi.lib
    shcore.lib
    avrt.lib
    crypt32.lib
    advapi32.lib
    setupapi.lib
    cfgmgr32.lib
    bcrypt.lib
  )
endif()

if(LINKSHELL_BUILD_QA)
  add_executable(LinkShell.InputQA WIN32
    src/helper/input_probe.cpp
    LinkShell.Screen.manifest
  )

  set_target_properties(LinkShell.InputQA PROPERTIES
    OUTPUT_NAME "LinkShell.InputQA"
  )

  target_compile_definitions(LinkShell.InputQA PRIVATE
    ${LINKSHELL_COMMON_DEFS}
  )

  target_compile_options(LinkShell.InputQA PRIVATE
    /utf-8
    /EHsc
    /W3
    $<$<CONFIG:Release>:/O2>
  )

  target_link_options(LinkShell.InputQA PRIVATE
    /OPT:REF
    /OPT:ICF
    /SUBSYSTEM:WINDOWS
  )

  target_link_libraries(LinkShell.InputQA PRIVATE
    user32.lib
    gdi32.lib
  )
endif()

if(LINKSHELL_BUILD_MEDIA)
set(WEBRTC_ROOT "" CACHE PATH "Path to unpacked LiveKit libwebrtc Windows release directory")
if(NOT WEBRTC_ROOT OR NOT EXISTS "${WEBRTC_ROOT}/lib/webrtc.lib")
  message(FATAL_ERROR "WEBRTC_ROOT must point to a directory containing lib/webrtc.lib and include/")
endif()

add_executable(LinkShell.Media
  src/main.cpp
  src/lan_floor.cpp
  src/d3d_context.cpp
  src/display_info.cpp
  src/wgc_capturer.cpp
  src/dxgi_capturer.cpp
  src/capture_source.cpp
  src/mf_encoder.cpp
  src/audio_capturer.cpp
  src/input_cursor.cpp
  src/vdd_control.cpp
  src/screen_session.cpp
  src/fusion_session.cpp
  LinkShell.Media.manifest
)

set_target_properties(LinkShell.Media PROPERTIES
  OUTPUT_NAME "LinkShell.Media"
)

file(GLOB WEBRTC_GEN_DIRS LIST_DIRECTORIES true "${WEBRTC_ROOT}/include/out-*/gen")
set(WEBRTC_EXTRA_INCLUDES "")
foreach(_gen_dir ${WEBRTC_GEN_DIRS})
  list(APPEND WEBRTC_EXTRA_INCLUDES
    "${_gen_dir}"
    "${_gen_dir}/third_party/perfetto/build_config"
    "${_gen_dir}/third_party/perfetto"
  )
endforeach()

target_include_directories(LinkShell.Media PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
  "${CMAKE_CURRENT_SOURCE_DIR}/third_party"
  "${WEBRTC_ROOT}/include"
  ${WEBRTC_EXTRA_INCLUDES}
  "${WEBRTC_ROOT}/include/third_party/abseil-cpp"
  "${WEBRTC_ROOT}/include/third_party/libyuv/include"
  "${WEBRTC_ROOT}/include/third_party/perfetto/include"
  "${WEBRTC_ROOT}/include/third_party/zlib"
)

target_compile_definitions(LinkShell.Media PRIVATE
  WEBRTC_WIN
  NOMINMAX
  WIN32_LEAN_AND_MEAN
  _WIN32_WINNT=0x0A00
  WINVER=0x0A00
  NTDDI_VERSION=0x0A00000C
  UNICODE
  _UNICODE
  _CRT_SECURE_NO_WARNINGS
  _CRT_NONSTDC_NO_WARNINGS
  _WINSOCK_DEPRECATED_NO_WARNINGS
  _ENABLE_EXTENDED_ALIGNED_STORAGE
  WEBRTC_ENABLE_PROTOBUF=0
  WEBRTC_STRICT_FIELD_TRIALS=0
  WEBRTC_INCLUDE_INTERNAL_AUDIO_DEVICE
  WEBRTC_NON_STATIC_TRACE_EVENT_HANDLERS=0
  WEBRTC_DEPRECATE_PLAN_B
  WEBRTC_USE_H264
  RTC_ENABLE_H265
  WEBRTC_HAVE_SCTP
  RTC_ENABLE_VP9
  RTC_USE_LIBAOM_AV1_ENCODER
  RTC_DAV1D_IN_INTERNAL_DECODER_FACTORY
  RTC_ENABLE_WIN_WGC
  ABSL_ALLOCATOR_NOTHROW=1
  WINCRYPT_USE_SYMBOL_PREFIX
  JSON_USE_IMPLICIT_CONVERSIONS=0
)

if(CMAKE_GENERATOR_PLATFORM MATCHES "ARM64" OR CMAKE_SYSTEM_PROCESSOR MATCHES "ARM64|aarch64")
  target_compile_definitions(LinkShell.Media PRIVATE
    WEBRTC_ARCH_ARM64
    WEBRTC_HAS_NEON
  )
endif()

target_compile_options(LinkShell.Media PRIVATE
  /utf-8
  /EHsc
  /bigobj
  /W3
  /wd4068
  /wd4100
  /wd4244
  /wd4267
  /wd4996
  $<$<CONFIG:Release>:/O2>
)

target_link_options(LinkShell.Media PRIVATE
  /OPT:REF
  /OPT:ICF
  /SUBSYSTEM:CONSOLE
)

target_link_libraries(LinkShell.Media PRIVATE
  "${WEBRTC_ROOT}/lib/webrtc.lib"
  d3d11.lib
  dxgi.lib
  dxguid.lib
  mf.lib
  mfplat.lib
  mfuuid.lib
  mfreadwrite.lib
  strmiids.lib
  wmcodecdspuuid.lib
  dmoguids.lib
  msdmo.lib
  ole32.lib
  oleaut32.lib
  uuid.lib
  gdi32.lib
  gdiplus.lib
  user32.lib
  shell32.lib
  shlwapi.lib
  comctl32.lib
  dwmapi.lib
  shcore.lib
  winmm.lib
  avrt.lib
  ws2_32.lib
  iphlpapi.lib
  dnsapi.lib
  wininet.lib
  version.lib
  secur32.lib
  crypt32.lib
  advapi32.lib
  setupapi.lib
  cfgmgr32.lib
  bcrypt.lib
  powrprof.lib
  runtimeobject.lib
)
endif()
