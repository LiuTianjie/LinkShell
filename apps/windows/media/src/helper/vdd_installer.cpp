#include "helper/screen_common.hpp"

#include <cfgmgr32.h>
#include <setupapi.h>
#include <wincrypt.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cwctype>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace linkshell::helper {

namespace {

// GUID_DEVCLASS_DISPLAY ({4d36e968-e325-11ce-bfc1-08002be10318}) defined inline to avoid INITGUID collisions.
constexpr GUID kGuidDevClassDisplay = {
    0x4d36e968, 0xe325, 0x11ce, {0xbf, 0xc1, 0x08, 0x00, 0x2b, 0xe1, 0x03, 0x18}};
constexpr wchar_t kVddHardwareId[] = L"Root\\MttVDD";
constexpr wchar_t kVddSettingsDir[] = L"C:\\VirtualDisplayDriver";

struct VddQueryResult {
  bool installed = false;
  bool enabled = false;
  bool active = false;
  std::string device_id;
  int virtual_monitors = 0;
  bool driver_bundled = false;
};

bool ContainsWideIgnoreCase(const std::wstring& hay, const wchar_t* needle) {
  std::wstring h = hay;
  std::wstring n = needle;
  for (auto& c : h) c = static_cast<wchar_t>(towlower(c));
  for (auto& c : n) c = static_cast<wchar_t>(towlower(c));
  return h.find(n) != std::wstring::npos;
}

std::wstring BundledVddDir() {
  std::wstring exe = CurrentExePathWide();
  size_t slash = exe.find_last_of(L"\\/");
  if (slash != std::wstring::npos) {
    std::wstring beside = exe.substr(0, slash) + L"\\vdd";
    if (FileExistsWide(beside + L"\\MttVDD.inf")) return beside;
  }
  std::wstring bundle = GetEnvWide(L"LINKSHELL_APP_BUNDLE");
  if (!bundle.empty()) {
    std::wstring in_bundle = bundle + L"\\vdd";
    if (FileExistsWide(in_bundle + L"\\MttVDD.inf")) return in_bundle;
  }
  return {};
}

std::wstring ReadDevicePropString(HDEVINFO info_set, PSP_DEVINFO_DATA dev, DWORD prop) {
  DWORD reg_type = 0, needed = 0;
  std::vector<wchar_t> buf(512, L'\0');
  if (!SetupDiGetDeviceRegistryPropertyW(
          info_set, dev, prop, &reg_type, reinterpret_cast<PBYTE>(buf.data()),
          static_cast<DWORD>(buf.size() * sizeof(wchar_t)), &needed)) {
    return {};
  }
  size_t count = std::min<size_t>(buf.size(), needed / sizeof(wchar_t));
  for (size_t i = 0; i < count; ++i) {
    if (buf[i] == L'\0') buf[i] = L' ';
  }
  return std::wstring(buf.data(), count);
}

bool IsMttVddDevice(HDEVINFO info_set, PSP_DEVINFO_DATA dev) {
  std::wstring hwid = ReadDevicePropString(info_set, dev, SPDRP_HARDWAREID);
  if (ContainsWideIgnoreCase(hwid, L"MttVDD")) return true;
  std::wstring desc = ReadDevicePropString(info_set, dev, SPDRP_DEVICEDESC);
  return ContainsWideIgnoreCase(desc, L"Virtual Display Driver") ||
         ContainsWideIgnoreCase(desc, L"IddSampleDriver");
}

VddQueryResult QueryVddStatusInternal() {
  VddQueryResult res;
  res.driver_bundled = !BundledVddDir().empty();

  HDEVINFO info_set = SetupDiGetClassDevsW(&kGuidDevClassDisplay, nullptr, nullptr, DIGCF_PRESENT);
  if (info_set != INVALID_HANDLE_VALUE) {
    SP_DEVINFO_DATA dev{};
    dev.cbSize = sizeof(dev);
    for (DWORD i = 0; SetupDiEnumDeviceInfo(info_set, i, &dev); ++i) {
      if (!IsMttVddDevice(info_set, &dev)) continue;
      res.installed = true;
      wchar_t id_buf[256] = {};
      if (CM_Get_Device_IDW(dev.DevInst, id_buf, ARRAYSIZE(id_buf), 0) == CR_SUCCESS) {
        res.device_id = WideToUtf8(id_buf);
      }
      ULONG status = 0, problem = 0;
      if (CM_Get_DevNode_Status(&status, &problem, dev.DevInst, 0) == CR_SUCCESS) {
        res.enabled = (problem == 0) && ((status & DN_STARTED) != 0);
      }
      break;
    }
    SetupDiDestroyDeviceInfoList(info_set);
  }

  auto displays = EnumerateHelperDisplays(true);
  for (const auto& d : displays) {
    DISPLAY_DEVICEW adapter{};
    adapter.cb = sizeof(adapter);
    for (DWORD ai = 0; EnumDisplayDevicesW(nullptr, ai, &adapter, 0); ++ai) {
      if (_wcsicmp(adapter.DeviceName, d.device_name.c_str()) == 0) {
        std::wstring name = adapter.DeviceString;
        if (ContainsWideIgnoreCase(name, L"Virtual Display") ||
            ContainsWideIgnoreCase(name, L"IddSampleDriver") ||
            ContainsWideIgnoreCase(name, L"MttVDD")) {
          res.virtual_monitors += 1;
          res.active = true;
        }
        break;
      }
    }
  }
  return res;
}

void WriteVddSettingsXmlFile(int width, int height, int hz, int count) {
  EnsureDirectoryTreeWide(kVddSettingsDir);
  std::string xml = BuildVddSettingsXml(width, height, hz, count);
  WriteUtf8FileWide(std::wstring(kVddSettingsDir) + L"\\vdd_settings.xml", xml);
}

// Trusts ONLY leaf publisher certificates from mttvdd.cat inside LocalMachine\TrustedPublisher.
// Security invariant: NEVER installs certificates into LocalMachine\Root.
void TrustDriverPublisherCert(const std::wstring& cat_path) {
  if (!FileExistsWide(cat_path)) return;
  HCERTSTORE cat_store = nullptr;
  DWORD encoding = 0, content_type = 0, format_type = 0;
  if (!CryptQueryObject(
          CERT_QUERY_OBJECT_FILE,
          cat_path.c_str(),
          CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED | CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED | CERT_QUERY_CONTENT_FLAG_CERT,
          CERT_QUERY_FORMAT_FLAG_ALL,
          0,
          &encoding,
          &content_type,
          &format_type,
          &cat_store,
          nullptr,
          nullptr) ||
      !cat_store) {
    return;
  }

  HCERTSTORE pub_store = CertOpenStore(
      CERT_STORE_PROV_SYSTEM_W,
      0,
      0,
      CERT_SYSTEM_STORE_LOCAL_MACHINE,
      L"TrustedPublisher");
  if (pub_store) {
    PCCERT_CONTEXT cert = nullptr;
    while ((cert = CertEnumCertificatesInStore(cat_store, cert)) != nullptr) {
      if (cert->pCertInfo &&
          !CertCompareCertificateName(X509_ASN_ENCODING | PKCS_7_ASN_ENCODING,
                                      &cert->pCertInfo->Subject,
                                      &cert->pCertInfo->Issuer)) {
        CertAddCertificateContextToStore(pub_store, cert, CERT_STORE_ADD_REPLACE_EXISTING, nullptr);
      }
    }
    CertCloseStore(pub_store, 0);
  }
  CertCloseStore(cat_store, 0);
}

int RunPnpUtilCapture(const std::wstring& args, DWORD timeout_ms, std::string* out_text) {
  if (out_text) out_text->clear();
  SECURITY_ATTRIBUTES sa{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE read_pipe = nullptr, write_pipe = nullptr;
  if (!CreatePipe(&read_pipe, &write_pipe, &sa, 0)) return -1;
  SetHandleInformation(read_pipe, HANDLE_FLAG_INHERIT, 0);

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdOutput = write_pipe;
  si.hStdError = write_pipe;
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);

  wchar_t sys_dir[MAX_PATH] = {};
  GetSystemDirectoryW(sys_dir, ARRAYSIZE(sys_dir));
  std::wstring exe = std::wstring(sys_dir) + L"\\pnputil.exe";
  std::wstring cmd = L"\"" + exe + L"\" " + args;

  PROCESS_INFORMATION pi{};
  BOOL ok = CreateProcessW(exe.c_str(), cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
  CloseHandle(write_pipe);
  if (!ok) {
    CloseHandle(read_pipe);
    return -1;
  }
  CloseHandle(pi.hThread);

  std::string captured;
  std::thread reader([&]() {
    char buf[4096];
    DWORD got = 0;
    while (ReadFile(read_pipe, buf, sizeof(buf), &got, nullptr) && got > 0) {
      captured.append(buf, got);
    }
  });

  WaitForSingleObject(pi.hProcess, timeout_ms);
  DWORD exit_code = static_cast<DWORD>(-1);
  GetExitCodeProcess(pi.hProcess, &exit_code);
  if (exit_code == STILL_ACTIVE) {
    TerminateProcess(pi.hProcess, 1);
    exit_code = static_cast<DWORD>(-1);
  }
  CloseHandle(pi.hProcess);
  if (reader.joinable()) reader.join();
  CloseHandle(read_pipe);
  if (out_text) *out_text = std::move(captured);
  return static_cast<int>(exit_code);
}

bool CallUpdateDriverForPlugAndPlayDevices(const wchar_t* hwid, const wchar_t* inf_path, DWORD* out_err) {
  using Fn = BOOL(WINAPI*)(HWND, LPCWSTR, LPCWSTR, DWORD, PBOOL);
  HMODULE mod = LoadLibraryExW(L"newdev.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!mod) {
    if (out_err) *out_err = GetLastError();
    return false;
  }
  auto fn = reinterpret_cast<Fn>(GetProcAddress(mod, "UpdateDriverForPlugAndPlayDevicesW"));
  BOOL reboot = FALSE;
  BOOL ok = fn ? fn(nullptr, hwid, inf_path, 0x00000001 /* INSTALLFLAG_FORCE */, &reboot) : FALSE;
  if (!ok && out_err) *out_err = GetLastError();
  FreeLibrary(mod);
  return ok != FALSE;
}

}  // namespace

void PrintVddStatus() {
  auto st = QueryVddStatusInternal();
  WriteStdoutJson({
      {"installed", st.installed},
      {"enabled", st.enabled},
      {"active", st.active},
      {"deviceId", st.device_id},
      {"virtualMonitors", st.virtual_monitors},
      {"driverBundled", st.driver_bundled},
  });
}

bool SetVddNodeEnabled(bool enable) {
  HDEVINFO info_set = SetupDiGetClassDevsW(&kGuidDevClassDisplay, nullptr, nullptr, DIGCF_PRESENT);
  if (info_set == INVALID_HANDLE_VALUE) return false;
  bool touched = false;
  SP_DEVINFO_DATA dev{};
  dev.cbSize = sizeof(dev);
  for (DWORD i = 0; SetupDiEnumDeviceInfo(info_set, i, &dev); ++i) {
    if (!IsMttVddDevice(info_set, &dev)) continue;
    CONFIGRET rc = enable ? CM_Enable_DevNode(dev.DevInst, 0) : CM_Disable_DevNode(dev.DevInst, 0);
    if (rc == CR_SUCCESS) touched = true;
  }
  SetupDiDestroyDeviceInfoList(info_set);
  return touched;
}

bool ConfigureVddFromService(const std::string& mode, int width, int height, int hz, int count) {
  try {
    if (mode == "vdd-disable") {
      return SetVddNodeEnabled(false);
    }
    if (mode == "vdd-enable") {
      if (!FileExistsWide(std::wstring(kVddSettingsDir) + L"\\vdd_settings.xml")) {
        WriteVddSettingsXmlFile(width, height, hz, std::max(1, count));
      }
      return SetVddNodeEnabled(true);
    }
    if (mode == "vdd-configure") {
      WriteVddSettingsXmlFile(width, height, hz, std::max(1, count));
      SetVddNodeEnabled(false);
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
      return SetVddNodeEnabled(true);
    }
  } catch (const std::exception& err) {
    LogServiceEvent("vdd action failed (" + mode + "): " + err.what());
  }
  return false;
}

void InstallVddDriver(const std::wstring& vdd_dir) {
  if (!IsRunningAsAdministrator()) {
    throw std::runtime_error("安装虚拟显示器驱动需要管理员权限");
  }
  std::wstring dir = vdd_dir.empty() ? BundledVddDir() : vdd_dir;
  if (dir.empty() || !DirectoryExistsWide(dir)) {
    throw std::runtime_error("未找到内置虚拟显示器驱动文件（vdd）");
  }
  std::wstring inf_path = dir + L"\\MttVDD.inf";
  std::wstring cat_path = dir + L"\\mttvdd.cat";
  std::wstring dll_path = dir + L"\\MttVDD.dll";
  if (!FileExistsWide(inf_path) || !FileExistsWide(dll_path)) {
    throw std::runtime_error("虚拟显示器驱动包不完整（缺少 MttVDD.inf 或 MttVDD.dll）");
  }

  TrustDriverPublisherCert(cat_path);
  WriteVddSettingsXmlFile(1920, 1080, 60, 1);

  auto current = QueryVddStatusInternal();
  if (!current.installed) {
    HDEVINFO info_set = SetupDiCreateDeviceInfoList(&kGuidDevClassDisplay, nullptr);
    if (info_set == INVALID_HANDLE_VALUE) {
      throw std::runtime_error("SetupDiCreateDeviceInfoList 失败：" + std::to_string(GetLastError()));
    }
    SP_DEVINFO_DATA dev{};
    dev.cbSize = sizeof(dev);
    if (!SetupDiCreateDeviceInfoW(info_set, L"Display", &kGuidDevClassDisplay, L"Virtual Display Driver",
                                  nullptr, DICD_GENERATE_ID, &dev)) {
      DWORD err = GetLastError();
      SetupDiDestroyDeviceInfoList(info_set);
      throw std::runtime_error("创建虚拟显示设备节点失败：" + std::to_string(err));
    }
    // Multi-SZ UTF-16 string terminated by two NUL characters.
    std::wstring hwid_msz(kVddHardwareId);
    hwid_msz.push_back(L'\0');
    hwid_msz.push_back(L'\0');
    if (!SetupDiSetDeviceRegistryPropertyW(
            info_set, &dev, SPDRP_HARDWAREID,
            reinterpret_cast<const BYTE*>(hwid_msz.data()),
            static_cast<DWORD>(hwid_msz.size() * sizeof(wchar_t)))) {
      DWORD err = GetLastError();
      SetupDiDestroyDeviceInfoList(info_set);
      throw std::runtime_error("设置虚拟显示硬件 ID 失败：" + std::to_string(err));
    }
    if (!SetupDiCallClassInstaller(DIF_REGISTERDEVICE, info_set, &dev)) {
      DWORD err = GetLastError();
      SetupDiDestroyDeviceInfoList(info_set);
      throw std::runtime_error("注册虚拟显示设备失败：" + std::to_string(err));
    }
    SetupDiDestroyDeviceInfoList(info_set);
  }

  DWORD update_err = 0;
  if (!CallUpdateDriverForPlugAndPlayDevices(kVddHardwareId, inf_path.c_str(), &update_err)) {
    std::string pnp_out;
    int pnp_code = RunPnpUtilCapture(L"/add-driver \"" + inf_path + L"\" /install", 30000, &pnp_out);
    if (pnp_code != 0 && pnp_code != 3010) {
      char hex_err[16];
      std::snprintf(hex_err, sizeof(hex_err), "0x%08lX", static_cast<unsigned long>(update_err));
      throw std::runtime_error("安装虚拟显示器驱动失败（错误码 " + std::string(hex_err) + "）：" + TrimAscii(pnp_out));
    }
  }
  SetVddNodeEnabled(true);
  std::this_thread::sleep_for(std::chrono::milliseconds(600));
}

void UninstallVddDriver() {
  if (!IsRunningAsAdministrator()) {
    throw std::runtime_error("卸载虚拟显示器驱动需要管理员权限");
  }
  HDEVINFO info_set = SetupDiGetClassDevsW(&kGuidDevClassDisplay, nullptr, nullptr, DIGCF_PRESENT);
  if (info_set != INVALID_HANDLE_VALUE) {
    SP_DEVINFO_DATA dev{};
    dev.cbSize = sizeof(dev);
    for (DWORD i = 0; SetupDiEnumDeviceInfo(info_set, i, &dev); ++i) {
      if (!IsMttVddDevice(info_set, &dev)) continue;
      SetupDiCallClassInstaller(DIF_REMOVE, info_set, &dev);
    }
    SetupDiDestroyDeviceInfoList(info_set);
  }

  std::string enum_out;
  if (RunPnpUtilCapture(L"/enum-drivers", 10000, &enum_out) == 0) {
    for (const auto& oem : ExtractMttVddOemInfs(enum_out)) {
      std::string ignored;
      RunPnpUtilCapture(L"/delete-driver " + Utf8ToWide(oem) + L" /uninstall /force", 10000, &ignored);
    }
  }
}

}  // namespace linkshell::helper
