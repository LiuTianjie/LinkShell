#include "helper/helper_core.hpp"

#include <cassert>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

using namespace linkshell::helper;

int main() {
  // 1. Constant-time token comparison.
  assert(ConstantTimeEquals("abcdef0123456789", "abcdef0123456789"));
  assert(!ConstantTimeEquals("abcdef0123456789", "abcdef0123456788"));
  assert(!ConstantTimeEquals("abcdef", "abcdef0"));
  assert(!ConstantTimeEquals("", "a"));
  assert(!ConstantTimeEquals("", ""));

  // 2. Base64 & hex round-trip.
  const std::string payload = "C:\\Users\\测试\\AppData\\Local\\.linkshell";
  const std::string b64 = Base64EncodeBytes(reinterpret_cast<const uint8_t*>(payload.data()), payload.size());
  std::vector<uint8_t> decoded;
  assert(Base64DecodeBytes("  " + b64 + "\r\n", &decoded));
  assert(std::string(reinterpret_cast<const char*>(decoded.data()), decoded.size()) == payload);
  assert(!Base64DecodeBytes("abc", &decoded));     // invalid length
  assert(!Base64DecodeBytes("ab$=", &decoded));    // invalid character

  const uint8_t sample_hash[4] = {0x00, 0x9a, 0xff, 0x10};
  assert(HexEncode(sample_hash, 4) == "009aff10");

  // 3. VDD settings XML generation & clamping.
  const std::string xml_custom = BuildVddSettingsXml(2880, 1800, 90, 1);
  assert(xml_custom.find("<count>1</count>") != std::string::npos);
  assert(xml_custom.find("<width>2880</width>") != std::string::npos);
  assert(xml_custom.find("<height>1800</height>") != std::string::npos);
  assert(xml_custom.find("<refresh_rate>90</refresh_rate>") != std::string::npos);
  assert(xml_custom.find("<width>1920</width>") != std::string::npos);

  const std::string xml_clamped = BuildVddSettingsXml(801, 601, 500, 9);
  assert(xml_clamped.find("<count>2</count>") != std::string::npos);
  assert(xml_clamped.find("<width>800</width>") != std::string::npos);
  assert(xml_clamped.find("<height>600</height>") != std::string::npos);
  assert(xml_clamped.find("<refresh_rate>144</refresh_rate>") != std::string::npos);

  const std::string xml_ignored_tiny = BuildVddSettingsXml(100, 100, 60, -3);
  assert(xml_ignored_tiny.find("<count>0</count>") != std::string::npos);
  assert(xml_ignored_tiny.find("<width>100</width>") == std::string::npos);

  // Standard 1920x1080 should not duplicate the resolution block.
  const std::string xml_std = BuildVddSettingsXml(1920, 1080, 60, 1);
  const size_t first_1920 = xml_std.find("<width>1920</width>");
  assert(first_1920 != std::string::npos);
  assert(xml_std.find("<width>1920</width>", first_1920 + 1) == std::string::npos);

  // 4. pnputil OEM INF extraction across localized outputs.
  const std::string pnputil_out =
      "Microsoft PnP Utility\r\n\r\n"
      "Published Name:     oem12.inf\r\n"
      "Original Name:      otherdriver.inf\r\n"
      "Provider Name:      Contoso\r\n\r\n"
      "发布名称:           oem47.inf\r\n"
      "原始名称:           MttVDD.inf\r\n"
      "提供程序名称:       MikeTheTech\r\n\r\n"
      "Published Name:     OEM47.INF\r\n"
      "Driver Description: IddSampleDriver\r\n\r\n"
      "Published Name:     oem89.inf\r\n"
      "Driver Description: IddSampleDriver\r\n";
  const auto infs = ExtractMttVddOemInfs(pnputil_out);
  assert(infs.size() == 2);
  assert(infs[0] == "oem47.inf");
  assert(infs[1] == "oem89.inf");

  // 5. Fusion self-exclusion & window->app resolution.
  assert(IsOwnLinkShellEntry("com.bd.linkshell", ""));
  assert(IsOwnLinkShellEntry("SomeApp", "C:\\Program Files\\LinkShell\\ScreenService\\LinkShell.Screen.exe"));
  assert(!IsOwnLinkShellEntry("Microsoft.WindowsNotepad_8wekyb3d8bbwe!App", "C:\\Windows\\notepad.exe"));

  CiStringSet catalog = {"Chrome", "Chrome._crx_abcd", "Notepad", "Code"};
  CiStringSet fused = {"Chrome", "Code"};
  CiStringMap<std::string> aliases = {{"CodeHelper.exe", "Code"}};

  // Direct fused AUMID match (case-insensitive, returns canonical fused casing).
  assert(ResolveWindowApp("chrome", "", "", fused, catalog, aliases) == "Chrome");
  // Separate catalog PWA (`Chrome._crx_abcd`) is NOT conflated with main `Chrome` when unfused.
  assert(ResolveWindowApp("Chrome._crx_abcd", "Chrome", "", fused, catalog, aliases) == "Chrome._crx_abcd");
  // Profile suffix (`Chrome.UserData.Profile1`) folds into fused `Chrome` because it's not a separate catalog entry.
  assert(ResolveWindowApp("Chrome.UserData.Profile1", "Chrome", "", fused, catalog, aliases) == "Chrome");
  // PID owner inherits fused app only when window doesn't identify as another known catalog app.
  assert(ResolveWindowApp("", "unknown.exe", "Code", fused, catalog, aliases) == "Code");
  assert(ResolveWindowApp("", "Notepad", "Code", fused, catalog, aliases) == "Notepad");
  // Learned alias maps helper exe to fused app.
  assert(ResolveWindowApp("", "codehelper.exe", "", fused, catalog, aliases) == "Code");

  // 6. W3C KeyboardEvent.code -> Set-1 ScanCode + extended flag.
  uint16_t scan = 0;
  bool ext = false;
  assert(TryMapW3cCodeToScan("KeyA", &scan, &ext) && scan == 0x1E && !ext);
  assert(TryMapW3cCodeToScan("ArrowRight", &scan, &ext) && scan == 0x4D && ext);
  assert(TryMapW3cCodeToScan("NumpadEnter", &scan, &ext) && scan == 0x1C && ext);
  assert(TryMapW3cCodeToScan("Enter", &scan, &ext) && scan == 0x1C && !ext);
  assert(TryMapW3cCodeToScan("MetaLeft", &scan, &ext) && scan == 0x5B && ext);
  assert(!TryMapW3cCodeToScan("Pause", &scan, &ext));

  assert(MapNamedKeyToVk("Enter") == 0x0D);
  assert(MapNamedKeyToVk("ArrowUp") == 0x26);
  assert(MapNamedKeyToVk("F12") == 0x7B);
  assert(MapNamedKeyToVk("UnknownKey") == 0);

  std::cout << "helper_core_test passed\n";
  return 0;
}
