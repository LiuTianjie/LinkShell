#pragma once

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace linkshell::helper {

inline char AsciiLower(char c) {
  return (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c;
}

inline std::string ToLowerAscii(std::string_view s) {
  std::string out(s.size(), '\0');
  for (size_t i = 0; i < s.size(); ++i) out[i] = AsciiLower(s[i]);
  return out;
}

inline bool EqualsIgnoreCaseAscii(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); ++i) {
    if (AsciiLower(a[i]) != AsciiLower(b[i])) return false;
  }
  return true;
}

inline bool StartsWithIgnoreCaseAscii(std::string_view s, std::string_view prefix) {
  if (s.size() < prefix.size()) return false;
  return EqualsIgnoreCaseAscii(s.substr(0, prefix.size()), prefix);
}

inline bool EndsWithIgnoreCaseAscii(std::string_view s, std::string_view suffix) {
  if (s.size() < suffix.size()) return false;
  return EqualsIgnoreCaseAscii(s.substr(s.size() - suffix.size()), suffix);
}

inline bool ContainsIgnoreCaseAscii(std::string_view haystack, std::string_view needle) {
  if (needle.empty()) return true;
  if (haystack.size() < needle.size()) return false;
  std::string h = ToLowerAscii(haystack);
  std::string n = ToLowerAscii(needle);
  return h.find(n) != std::string::npos;
}

inline std::string TrimAscii(std::string_view s) {
  size_t start = 0;
  while (start < s.size() && (s[start] == ' ' || s[start] == '\t' || s[start] == '\r' || s[start] == '\n')) {
    ++start;
  }
  size_t end = s.size();
  while (end > start && (s[end - 1] == ' ' || s[end - 1] == '\t' || s[end - 1] == '\r' || s[end - 1] == '\n')) {
    --end;
  }
  return std::string(s.substr(start, end - start));
}

struct CaseInsensitiveHash {
  size_t operator()(std::string_view s) const noexcept {
    uint64_t h = 14695981039346656037ULL;
    for (unsigned char c : s) {
      unsigned char lc = (c >= 'A' && c <= 'Z') ? static_cast<unsigned char>(c - 'A' + 'a') : c;
      h ^= lc;
      h *= 1099511628211ULL;
    }
    return static_cast<size_t>(h);
  }
};

struct CaseInsensitiveEqual {
  bool operator()(std::string_view a, std::string_view b) const noexcept {
    return EqualsIgnoreCaseAscii(a, b);
  }
};

using CiStringSet = std::unordered_set<std::string, CaseInsensitiveHash, CaseInsensitiveEqual>;
template <typename V>
using CiStringMap = std::unordered_map<std::string, V, CaseInsensitiveHash, CaseInsensitiveEqual>;

// Constant-time string equality for per-install 256-bit service token validation.
inline bool ConstantTimeEquals(std::string_view a, std::string_view b) noexcept {
  if (a.empty() || a.size() != b.size()) return false;
  unsigned char diff = 0;
  for (size_t i = 0; i < a.size(); ++i) {
    diff |= static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i]);
  }
  return diff == 0;
}

inline std::string HexEncode(const uint8_t* data, size_t len) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out;
  out.reserve(len * 2);
  for (size_t i = 0; i < len; ++i) {
    out.push_back(kHex[(data[i] >> 4) & 0x0F]);
    out.push_back(kHex[data[i] & 0x0F]);
  }
  return out;
}

inline std::string Base64EncodeBytes(const uint8_t* data, size_t len) {
  static constexpr char kTable[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  for (size_t i = 0; i < len; i += 3) {
    uint32_t v = static_cast<uint32_t>(data[i]) << 16;
    if (i + 1 < len) v |= static_cast<uint32_t>(data[i + 1]) << 8;
    if (i + 2 < len) v |= static_cast<uint32_t>(data[i + 2]);
    out.push_back(kTable[(v >> 18) & 0x3F]);
    out.push_back(kTable[(v >> 12) & 0x3F]);
    out.push_back(i + 1 < len ? kTable[(v >> 6) & 0x3F] : '=');
    out.push_back(i + 2 < len ? kTable[v & 0x3F] : '=');
  }
  return out;
}

inline bool Base64DecodeBytes(std::string_view encoded, std::vector<uint8_t>* out) {
  if (!out) return false;
  out->clear();
  static constexpr auto kDecodeTable = []() {
    std::array<int8_t, 256> t{};
    t.fill(-1);
    for (int i = 0; i < 26; ++i) {
      t[static_cast<size_t>('A' + i)] = static_cast<int8_t>(i);
      t[static_cast<size_t>('a' + i)] = static_cast<int8_t>(26 + i);
    }
    for (int i = 0; i < 10; ++i) {
      t[static_cast<size_t>('0' + i)] = static_cast<int8_t>(52 + i);
    }
    t[static_cast<size_t>('+')] = 62;
    t[static_cast<size_t>('/')] = 63;
    t[static_cast<size_t>('=')] = -2;
    return t;
  }();

  out->reserve((encoded.size() * 3) / 4);
  uint32_t buf = 0;
  int bits = 0;
  size_t clean_chars = 0;
  size_t pad_chars = 0;
  for (unsigned char ch : encoded) {
    if (ch == ' ' || ch == '\r' || ch == '\n' || ch == '\t') continue;
    int8_t val = kDecodeTable[ch];
    if (val == -1) return false;
    ++clean_chars;
    if (val == -2) {
      if (++pad_chars > 2) return false;
      continue;
    }
    if (pad_chars > 0) return false;
    buf = (buf << 6) | static_cast<uint32_t>(val);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out->push_back(static_cast<uint8_t>((buf >> bits) & 0xFF));
    }
  }
  if ((clean_chars % 4) != 0 || bits == 6) {
    out->clear();
    return false;
  }
  return true;
}

// Generates MttVDD XML configuration (`C:\VirtualDisplayDriver\vdd_settings.xml`).
inline std::string BuildVddSettingsXml(int custom_width, int custom_height, int custom_hz, int count) {
  int safe_count = std::clamp(count, 0, 2);
  struct Mode { int w; int h; int hz; };
  std::vector<Mode> modes = {
      {1920, 1080, 60}, {2560, 1440, 60}, {3840, 2160, 60}, {2560, 1600, 60},
      {2880, 1800, 60}, {3024, 1964, 60}, {3456, 2234, 60}, {1728, 1117, 60},
      {1512, 982, 60},  {1680, 1050, 60}, {1440, 900, 60},  {1280, 800, 60},
      {2388, 1668, 60}, {2732, 2048, 60},
  };
  if (custom_width >= 640 && custom_width <= 3840 && custom_height >= 480 && custom_height <= 2400) {
    int w = (custom_width / 2) * 2;
    int h = (custom_height / 2) * 2;
    int hz = std::clamp(custom_hz > 0 ? custom_hz : 60, 30, 144);
    bool exists = false;
    for (const auto& m : modes) {
      if (m.w == w && m.h == h && m.hz == hz) {
        exists = true;
        break;
      }
    }
    if (!exists) modes.insert(modes.begin(), Mode{w, h, hz});
  }

  std::ostringstream sb;
  sb << "<?xml version='1.0' encoding='utf-8'?>\r\n"
     << "<vdd_settings>\r\n"
     << "    <monitors>\r\n"
     << "        <count>" << safe_count << "</count>\r\n"
     << "    </monitors>\r\n"
     << "    <gpu>\r\n"
     << "        <friendlyname>default</friendlyname>\r\n"
     << "    </gpu>\r\n"
     << "    <global>\r\n"
     << "        <g_refresh_rate>60</g_refresh_rate>\r\n"
     << "        <g_refresh_rate>90</g_refresh_rate>\r\n"
     << "        <g_refresh_rate>120</g_refresh_rate>\r\n"
     << "    </global>\r\n"
     << "    <resolutions>\r\n";
  for (const auto& m : modes) {
    sb << "        <resolution>\r\n"
       << "            <width>" << m.w << "</width>\r\n"
       << "            <height>" << m.h << "</height>\r\n"
       << "            <refresh_rate>" << m.hz << "</refresh_rate>\r\n"
       << "        </resolution>\r\n";
  }
  sb << "    </resolutions>\r\n"
     << "    <logging>\r\n"
     << "        <SendLogsThroughPipe>true</SendLogsThroughPipe>\r\n"
     << "        <logging>false</logging>\r\n"
     << "        <debuglogging>false</debuglogging>\r\n"
     << "    </logging>\r\n"
     << "    <colour>\r\n"
     << "        <SDR10bit>false</SDR10bit>\r\n"
     << "        <HDRPlus>false</HDRPlus>\r\n"
     << "        <ColourFormat>RGB</ColourFormat>\r\n"
     << "    </colour>\r\n"
     << "    <cursor>\r\n"
     << "        <HardwareCursor>true</HardwareCursor>\r\n"
     << "        <CursorMaxX>128</CursorMaxX>\r\n"
     << "        <CursorMaxY>128</CursorMaxY>\r\n"
     << "        <AlphaCursorSupport>true</AlphaCursorSupport>\r\n"
     << "    </cursor>\r\n"
     << "</vdd_settings>\r\n";
  return sb.str();
}

// Extracts staged `oem*.inf` driver names belonging to `mttvdd.inf` from `pnputil /enum-drivers` output.
inline std::vector<std::string> ExtractMttVddOemInfs(std::string_view pnputil_output) {
  std::vector<std::string> result;
  CiStringSet seen;
  std::string last_oem;
  size_t pos = 0;
  while (pos < pnputil_output.size()) {
    size_t nl = pnputil_output.find('\n', pos);
    std::string_view raw = (nl == std::string_view::npos)
                               ? pnputil_output.substr(pos)
                               : pnputil_output.substr(pos, nl - pos);
    pos = (nl == std::string_view::npos) ? pnputil_output.size() : nl + 1;
    std::string line = TrimAscii(raw);
    std::string lower = ToLowerAscii(line);
    size_t oem_idx = lower.find("oem");
    size_t inf_idx = (oem_idx != std::string::npos) ? lower.find(".inf", oem_idx) : std::string::npos;
    if (oem_idx != std::string::npos && inf_idx != std::string::npos && inf_idx > oem_idx) {
      std::string candidate = lower.substr(oem_idx, inf_idx - oem_idx + 4);
      bool valid = candidate.size() > 7;
      for (size_t k = 3; valid && k + 4 < candidate.size(); ++k) {
        if (!std::isdigit(static_cast<unsigned char>(candidate[k]))) valid = false;
      }
      if (valid) last_oem = std::move(candidate);
    } else if (!last_oem.empty() &&
               (lower.find("mttvdd.inf") != std::string::npos ||
                lower.find("iddsampledriver") != std::string::npos)) {
      if (seen.insert(last_oem).second) {
        result.push_back(last_oem);
      }
      last_oem.clear();
    }
  }
  return result;
}

inline bool IsOwnLinkShellEntry(std::string_view id, std::string_view target_exe) {
  if (id.empty()) return true;
  if (EqualsIgnoreCaseAscii(id, "LinkShell") ||
      StartsWithIgnoreCaseAscii(id, "LinkShell.") ||
      EqualsIgnoreCaseAscii(id, "com.bd.linkshell") ||
      StartsWithIgnoreCaseAscii(id, "com.bd.linkshell.")) {
    return true;
  }
  std::string_view check = !target_exe.empty() ? target_exe : id;
  return EndsWithIgnoreCaseAscii(check, "\\LinkShell.exe") ||
         EndsWithIgnoreCaseAscii(check, "\\LinkShell.Screen.exe") ||
         EndsWithIgnoreCaseAscii(check, "\\LinkShell.Media.exe");
}

// Resolves a window's Fusion catalog app ID with exact priority matching Fusion.cs:
// explicit fused window ID / alias -> fused process tree owner -> non-CRX dot prefix -> catalog / process exe.
inline std::string ResolveWindowApp(
    std::string_view window_id,
    std::string_view process_app,
    std::string_view pid_owner,
    const CiStringSet& fused,
    const CiStringSet& catalog_ids,
    const CiStringMap<std::string>& aliases) {
  auto find_in = [](const CiStringSet& set, std::string_view key) -> std::optional<std::string> {
    if (key.empty()) return std::nullopt;
    auto it = set.find(std::string(key));
    if (it == set.end()) return std::nullopt;
    return *it;
  };
  auto find_alias = [&](std::string_view key) -> std::optional<std::string> {
    if (key.empty()) return std::nullopt;
    auto it = aliases.find(std::string(key));
    if (it == aliases.end()) return std::nullopt;
    return it->second;
  };

  if (!window_id.empty()) {
    if (auto f = find_in(fused, window_id)) return *f;
    if (auto a = find_alias(window_id)) {
      if (auto f = find_in(fused, *a)) return *f;
    }
  }
  if (auto owner_fused = find_in(fused, pid_owner)) {
    std::string prefix = *owner_fused + ".";
    bool unrelated_listed =
        (!window_id.empty() && find_in(catalog_ids, window_id).has_value() &&
         !StartsWithIgnoreCaseAscii(window_id, prefix)) ||
        (window_id.empty() && !process_app.empty() && find_in(catalog_ids, process_app).has_value() &&
         !StartsWithIgnoreCaseAscii(process_app, prefix));
    if (!unrelated_listed) return *owner_fused;
  }
  if (!window_id.empty()) {
    size_t dot = window_id.find('.');
    if (dot != std::string_view::npos && dot > 0 && !ContainsIgnoreCaseAscii(window_id, "_crx_")) {
      std::string_view prefix = window_id.substr(0, dot);
      if (auto f = find_in(fused, prefix)) return *f;
    }
    if (auto c = find_in(catalog_ids, window_id)) return *c;
  }
  if (!process_app.empty()) {
    if (auto f = find_in(fused, process_app)) return *f;
    if (auto a = find_alias(process_app)) {
      if (auto f = find_in(fused, *a)) return *f;
    }
    if (auto c = find_in(catalog_ids, process_app)) return *c;
  }
  std::string result = !window_id.empty() ? std::string(window_id) : std::string(process_app);
  if (auto a = find_alias(result)) return *a;
  if (!window_id.empty()) {
    size_t dot = window_id.find('.');
    if (dot != std::string_view::npos && dot > 0 && !ContainsIgnoreCaseAscii(window_id, "_crx_")) {
      std::string_view prefix = window_id.substr(0, dot);
      if (auto c = find_in(catalog_ids, prefix)) return *c;
    }
  }
  return result;
}

inline bool TryMapW3cCodeToScan(std::string_view code, uint16_t* out_scan, bool* out_extended) {
  struct Entry { uint16_t scan; bool ext; };
  static const std::unordered_map<std::string_view, Entry> kMap = {
      {"Escape", {0x01, false}}, {"Digit1", {0x02, false}}, {"Digit2", {0x03, false}}, {"Digit3", {0x04, false}},
      {"Digit4", {0x05, false}}, {"Digit5", {0x06, false}}, {"Digit6", {0x07, false}}, {"Digit7", {0x08, false}},
      {"Digit8", {0x09, false}}, {"Digit9", {0x0A, false}}, {"Digit0", {0x0B, false}}, {"Minus", {0x0C, false}},
      {"Equal", {0x0D, false}}, {"Backspace", {0x0E, false}}, {"Tab", {0x0F, false}},
      {"KeyQ", {0x10, false}}, {"KeyW", {0x11, false}}, {"KeyE", {0x12, false}}, {"KeyR", {0x13, false}},
      {"KeyT", {0x14, false}}, {"KeyY", {0x15, false}}, {"KeyU", {0x16, false}}, {"KeyI", {0x17, false}},
      {"KeyO", {0x18, false}}, {"KeyP", {0x19, false}}, {"BracketLeft", {0x1A, false}}, {"BracketRight", {0x1B, false}},
      {"Enter", {0x1C, false}}, {"ControlLeft", {0x1D, false}},
      {"KeyA", {0x1E, false}}, {"KeyS", {0x1F, false}}, {"KeyD", {0x20, false}}, {"KeyF", {0x21, false}},
      {"KeyG", {0x22, false}}, {"KeyH", {0x23, false}}, {"KeyJ", {0x24, false}}, {"KeyK", {0x25, false}},
      {"KeyL", {0x26, false}}, {"Semicolon", {0x27, false}}, {"Quote", {0x28, false}}, {"Backquote", {0x29, false}},
      {"ShiftLeft", {0x2A, false}}, {"Backslash", {0x2B, false}},
      {"KeyZ", {0x2C, false}}, {"KeyX", {0x2D, false}}, {"KeyC", {0x2E, false}}, {"KeyV", {0x2F, false}},
      {"KeyB", {0x30, false}}, {"KeyN", {0x31, false}}, {"KeyM", {0x32, false}}, {"Comma", {0x33, false}},
      {"Period", {0x34, false}}, {"Slash", {0x35, false}}, {"ShiftRight", {0x36, false}},
      {"NumpadMultiply", {0x37, false}}, {"AltLeft", {0x38, false}}, {"Space", {0x39, false}},
      {"CapsLock", {0x3A, false}}, {"F1", {0x3B, false}}, {"F2", {0x3C, false}}, {"F3", {0x3D, false}},
      {"F4", {0x3E, false}}, {"F5", {0x3F, false}}, {"F6", {0x40, false}}, {"F7", {0x41, false}},
      {"F8", {0x42, false}}, {"F9", {0x43, false}}, {"F10", {0x44, false}}, {"F11", {0x57, false}}, {"F12", {0x58, false}},
      {"ScrollLock", {0x46, false}},
      {"Numpad7", {0x47, false}}, {"Numpad8", {0x48, false}}, {"Numpad9", {0x49, false}}, {"NumpadSubtract", {0x4A, false}},
      {"Numpad4", {0x4B, false}}, {"Numpad5", {0x4C, false}}, {"Numpad6", {0x4D, false}}, {"NumpadAdd", {0x4E, false}},
      {"Numpad1", {0x4F, false}}, {"Numpad2", {0x50, false}}, {"Numpad3", {0x51, false}}, {"Numpad0", {0x52, false}},
      {"NumpadDecimal", {0x53, false}},
      {"NumLock", {0x45, true}}, {"NumpadEnter", {0x1C, true}}, {"NumpadDivide", {0x35, true}},
      {"ControlRight", {0x1D, true}}, {"AltRight", {0x38, true}},
      {"MetaLeft", {0x5B, true}}, {"OSLeft", {0x5B, true}}, {"MetaRight", {0x5C, true}}, {"OSRight", {0x5C, true}},
      {"ContextMenu", {0x5D, true}},
      {"Home", {0x47, true}}, {"ArrowUp", {0x48, true}}, {"PageUp", {0x49, true}},
      {"ArrowLeft", {0x4B, true}}, {"ArrowRight", {0x4D, true}},
      {"End", {0x4F, true}}, {"ArrowDown", {0x50, true}}, {"PageDown", {0x51, true}},
      {"Insert", {0x52, true}}, {"Delete", {0x53, true}}, {"PrintScreen", {0x37, true}},
  };
  auto it = kMap.find(code);
  if (it == kMap.end()) {
    if (out_scan) *out_scan = 0;
    if (out_extended) *out_extended = false;
    return false;
  }
  if (out_scan) *out_scan = it->second.scan;
  if (out_extended) *out_extended = it->second.ext;
  return true;
}

inline uint16_t MapNamedKeyToVk(std::string_view name) {
  std::string lower = ToLowerAscii(name);
  if (lower == "enter" || lower == "return") return 0x0D;
  if (lower == "tab") return 0x09;
  if (lower == "escape" || lower == "esc") return 0x1B;
  if (lower == "backspace") return 0x08;
  if (lower == "delete") return 0x2E;
  if (lower == "arrowleft" || lower == "left") return 0x25;
  if (lower == "arrowup" || lower == "up") return 0x26;
  if (lower == "arrowright" || lower == "right") return 0x27;
  if (lower == "arrowdown" || lower == "down") return 0x28;
  if (lower == "home") return 0x24;
  if (lower == "end") return 0x23;
  if (lower == "pageup") return 0x21;
  if (lower == "pagedown") return 0x22;
  if (lower == "space" || lower == " ") return 0x20;
  if (lower == "insert") return 0x2D;
  if (lower.size() >= 2 && lower.size() <= 3 && lower[0] == 'f') {
    int fn = 0;
    for (size_t i = 1; i < lower.size(); ++i) {
      if (!std::isdigit(static_cast<unsigned char>(lower[i]))) return 0;
      fn = fn * 10 + (lower[i] - '0');
    }
    if (fn >= 1 && fn <= 24) return static_cast<uint16_t>(0x6F + fn);
  }
  return 0;
}

}  // namespace linkshell::helper
