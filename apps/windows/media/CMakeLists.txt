cmake_minimum_required(VERSION 3.22)
project(LinkShellMedia LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT WIN32)
  message(FATAL_ERROR "LinkShell.Media is a Windows-only native media engine.")
endif()

set(WEBRTC_ROOT "" CACHE PATH "Path to unpacked LiveKit libwebrtc Windows release directory")
if(NOT WEBRTC_ROOT OR NOT EXISTS "${WEBRTC_ROOT}/lib/webrtc.lib")
  message(FATAL_ERROR "WEBRTC_ROOT must point to a directory containing lib/webrtc.lib and include/")
endif()

# Match upstream Chromium/LiveKit static release CRT (/MT) so LinkShell.Media.exe has zero MSVC redist dependencies.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

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
