#include "helper/screen_common.hpp"

#include <aclapi.h>
#include <knownfolders.h>
#include <sddl.h>
#include <shlobj.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <climits>
#include <cmath>
#include <cstring>
#include <ctime>
#include <deque>
#include <iostream>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace linkshell::helper {

namespace {

constexpr wchar_t kElevatedServiceName[] = L"LinkShellScreenService";
constexpr wchar_t kElevatedServiceDisplayName[] = L"LinkShell Elevated Screen Service";
constexpr wchar_t kElevatedPipePath[] = L"\\\\.\\pipe\\LinkShellScreenServiceV1";

struct ServiceAuthConfig {
  std::string sid;
  std::string token;
  std::wstring home;
  std::string sha256;
};

std::wstring KnownFolderOrEnv(const KNOWNFOLDERID& folder_id, const wchar_t* env_name, const wchar_t* fallback) {
  PWSTR known = nullptr;
  if (SUCCEEDED(SHGetKnownFolderPath(folder_id, 0, nullptr, &known)) && known) {
    std::wstring out(known);
    CoTaskMemFree(known);
    if (!out.empty()) return out;
  }
  std::wstring env = GetEnvWide(env_name);
  return !env.empty() ? env : std::wstring(fallback);
}

std::wstring ServiceInstallDir() {
  return KnownFolderOrEnv(FOLDERID_ProgramFiles, L"ProgramFiles", L"C:\\Program Files") + L"\\LinkShell\\ScreenService";
}

std::wstring ServiceExePath() {
  return ServiceInstallDir() + L"\\LinkShell.Screen.exe";
}

std::wstring ServiceDataDir() {
  return KnownFolderOrEnv(FOLDERID_ProgramData, L"ProgramData", L"C:\\ProgramData") + L"\\LinkShell\\ScreenService";
}

std::wstring ServiceAuthPath() {
  return ServiceDataDir() + L"\\auth.json";
}

std::wstring UserServiceTokenPath(const std::wstring& home) {
  return home + L"\\windows-service-token";
}

std::wstring UserServiceErrorPath(const std::wstring& home) {
  return home + L"\\windows-service-last-error.txt";
}

bool ValidateSidString(const std::wstring& sid_str) {
  if (sid_str.empty()) return false;
  PSID sid = nullptr;
  if (!ConvertStringSidToSidW(sid_str.c_str(), &sid) || !sid) return false;
  bool valid = IsValidSid(sid) != FALSE;
  LocalFree(sid);
  return valid;
}

void ApplyProtectedSddlToPath(const std::wstring& path, const std::wstring& sddl) {
  PSECURITY_DESCRIPTOR sd = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &sd, nullptr) || !sd) {
    throw std::runtime_error("转换安全描述符失败：" + std::to_string(GetLastError()));
  }
  BOOL dacl_present = FALSE, dacl_defaulted = FALSE;
  PACL dacl = nullptr;
  DWORD rc = ERROR_INVALID_PARAMETER;
  if (GetSecurityDescriptorDacl(sd, &dacl_present, &dacl, &dacl_defaulted) && dacl_present) {
    rc = SetNamedSecurityInfoW(
        const_cast<LPWSTR>(path.c_str()),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr,
        nullptr,
        dacl,
        nullptr);
  }
  LocalFree(sd);
  if (rc != ERROR_SUCCESS) {
    throw std::runtime_error("设置目录或文件访问控制失败：" + std::to_string(rc));
  }
}

void ApplyServiceBinaryDirectoryAcl(const std::wstring& dir) {
  // LocalSystem: FullControl; Builtin Admins: FullControl; Builtin Users: ReadAndExecute (0x1200a9) so
  // unprivileged `--service-status` can verify the binary SHA-256 without write permission.
  ApplyProtectedSddlToPath(dir, L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)");
}

void ApplyAdminOnlyDirectoryAcl(const std::wstring& dir) {
  ApplyProtectedSddlToPath(dir, L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
}

void ApplyUserTokenFileAcl(const std::wstring& file_path, const std::wstring& user_sid) {
  if (!ValidateSidString(user_sid)) {
    throw std::runtime_error("无效的 Windows 用户 SID");
  }
  ApplyProtectedSddlToPath(file_path, L"D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;" + user_sid + L")");
}

struct ScopedSddlSecurity {
  PSECURITY_DESCRIPTOR sd = nullptr;
  SECURITY_ATTRIBUTES sa{};

  bool Init(const std::wstring& sddl) {
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &sd, nullptr) || !sd) {
      return false;
    }
    sa.nLength = sizeof(SECURITY_ATTRIBUTES);
    sa.lpSecurityDescriptor = sd;
    sa.bInheritHandle = FALSE;
    return true;
  }

  ~ScopedSddlSecurity() {
    if (sd) LocalFree(sd);
  }
};

// Overlapped full-duplex Named Pipe I/O helpers (required so concurrent reader/writer threads on the
// same duplex pipe handle never serialize or deadlock).
bool PipeReadSome(HANDLE pipe, void* buf, DWORD max_len, DWORD* out_got, HANDLE cancel_event = nullptr, DWORD timeout_ms = INFINITE) {
  if (out_got) *out_got = 0;
  if (!pipe || pipe == INVALID_HANDLE_VALUE) return false;
  HANDLE ev = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!ev) return false;
  OVERLAPPED ov{};
  ov.hEvent = ev;

  DWORD got = 0;
  BOOL ok = ReadFile(pipe, buf, max_len, &got, &ov);
  if (!ok) {
    DWORD err = GetLastError();
    if (err != ERROR_IO_PENDING) {
      CloseHandle(ev);
      return false;
    }
    HANDLE waits[2] = {ev, cancel_event};
    DWORD count = cancel_event ? 2 : 1;
    DWORD w = WaitForMultipleObjects(count, waits, FALSE, timeout_ms);
    if (w != WAIT_OBJECT_0) {
      CancelIoEx(pipe, &ov);
      GetOverlappedResult(pipe, &ov, &got, TRUE);
      CloseHandle(ev);
      return false;
    }
    if (!GetOverlappedResult(pipe, &ov, &got, FALSE)) {
      CloseHandle(ev);
      return false;
    }
  }
  CloseHandle(ev);
  if (got == 0) return false;
  if (out_got) *out_got = got;
  return true;
}

bool PipeReadExact(HANDLE pipe, void* buf, size_t len, HANDLE cancel_event = nullptr, DWORD timeout_ms = INFINITE) {
  auto* dst = static_cast<uint8_t*>(buf);
  size_t off = 0;
  while (off < len) {
    DWORD chunk = static_cast<DWORD>(std::min<size_t>(len - off, 256 * 1024));
    DWORD got = 0;
    if (!PipeReadSome(pipe, dst + off, chunk, &got, cancel_event, timeout_ms) || got == 0) return false;
    off += got;
  }
  return true;
}

bool PipeReadLine(HANDLE pipe, std::string* out_line, size_t max_bytes = 32768, HANDLE cancel_event = nullptr, DWORD timeout_ms = INFINITE) {
  if (!out_line) return false;
  out_line->clear();
  char ch = 0;
  while (out_line->size() < max_bytes) {
    DWORD got = 0;
    if (!PipeReadSome(pipe, &ch, 1, &got, cancel_event, timeout_ms) || got == 0) {
      return !out_line->empty();
    }
    if (ch == '\n') return true;
    if (ch != '\r') out_line->push_back(ch);
  }
  return true;
}

bool PipeWriteAll(HANDLE pipe, const void* buf, size_t len, HANDLE cancel_event = nullptr, DWORD timeout_ms = 10000) {
  if (!pipe || pipe == INVALID_HANDLE_VALUE) return false;
  const auto* src = static_cast<const uint8_t*>(buf);
  size_t off = 0;
  while (off < len) {
    HANDLE ev = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!ev) return false;
    OVERLAPPED ov{};
    ov.hEvent = ev;
    DWORD chunk = static_cast<DWORD>(std::min<size_t>(len - off, 256 * 1024));
    DWORD written = 0;
    BOOL ok = WriteFile(pipe, src + off, chunk, &written, &ov);
    if (!ok) {
      DWORD err = GetLastError();
      if (err != ERROR_IO_PENDING) {
        CloseHandle(ev);
        return false;
      }
      HANDLE waits[2] = {ev, cancel_event};
      DWORD count = cancel_event ? 2 : 1;
      DWORD w = WaitForMultipleObjects(count, waits, FALSE, timeout_ms);
      if (w != WAIT_OBJECT_0 || !GetOverlappedResult(pipe, &ov, &written, FALSE)) {
        CancelIoEx(pipe, &ov);
        GetOverlappedResult(pipe, &ov, &written, TRUE);
        CloseHandle(ev);
        return false;
      }
    }
    CloseHandle(ev);
    if (written == 0) return false;
    off += written;
  }
  return true;
}

bool QueryElevatedServiceState(bool* out_installed, bool* out_running) {
  if (out_installed) *out_installed = false;
  if (out_running) *out_running = false;
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
  if (!scm) return false;
  SC_HANDLE svc = OpenServiceW(scm, kElevatedServiceName, SERVICE_QUERY_STATUS);
  if (!svc) {
    CloseServiceHandle(scm);
    return true;
  }
  SERVICE_STATUS_PROCESS ssp{};
  DWORD bytes_needed = 0;
  bool valid = QueryServiceStatusEx(svc, SC_STATUS_PROCESS_INFO, reinterpret_cast<LPBYTE>(&ssp), sizeof(ssp), &bytes_needed) != FALSE;
  CloseServiceHandle(svc);
  CloseServiceHandle(scm);
  if (valid) {
    if (out_installed) *out_installed = true;
    if (out_running) *out_running = (ssp.dwCurrentState == SERVICE_RUNNING);
  }
  return true;
}

std::string ReadUserServiceToken() {
  std::string raw = TrimAscii(ReadUtf8FileWide(UserServiceTokenPath(UserHomeDirWide())));
  return raw.size() == 64 ? raw : std::string{};
}

void StopServiceAndWaitForExit(SC_HANDLE svc) {
  SERVICE_STATUS_PROCESS ssp{};
  DWORD needed = 0;
  if (!QueryServiceStatusEx(svc, SC_STATUS_PROCESS_INFO, reinterpret_cast<LPBYTE>(&ssp), sizeof(ssp), &needed)) return;
  DWORD prev_pid = ssp.dwProcessId;
  if (ssp.dwCurrentState != SERVICE_STOPPED) {
    SERVICE_STATUS ignored{};
    ControlService(svc, SERVICE_CONTROL_STOP, &ignored);
    int64_t t0 = MonotonicMs();
    while (MonotonicMs() - t0 < 10000) {
      if (QueryServiceStatusEx(svc, SC_STATUS_PROCESS_INFO, reinterpret_cast<LPBYTE>(&ssp), sizeof(ssp), &needed) &&
          ssp.dwCurrentState == SERVICE_STOPPED) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
  }
  if (prev_pid != 0) {
    HANDLE proc = OpenProcess(SYNCHRONIZE, FALSE, prev_pid);
    if (proc) {
      WaitForSingleObject(proc, 5000);
      CloseHandle(proc);
    }
  }
}

void RemoveDirectoryRecursiveWide(const std::wstring& dir) {
  if (!DirectoryExistsWide(dir)) return;
  WIN32_FIND_DATAW fd{};
  HANDLE find = FindFirstFileW((dir + L"\\*").c_str(), &fd);
  if (find != INVALID_HANDLE_VALUE) {
    do {
      if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
      std::wstring child = dir + L"\\" + fd.cFileName;
      if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
          (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) {
        RemoveDirectoryRecursiveWide(child);
      } else {
        SetFileAttributesW(child.c_str(), FILE_ATTRIBUTE_NORMAL);
        DeleteFileW(child.c_str());
      }
    } while (FindNextFileW(find, &fd));
    FindClose(find);
  }
  SetFileAttributesW(dir.c_str(), FILE_ATTRIBUTE_NORMAL);
  RemoveDirectoryW(dir.c_str());
}

std::optional<ServiceAuthConfig> LoadServiceAuthConfig() {
  std::string text = ReadUtf8FileWide(ServiceAuthPath());
  if (text.empty()) return std::nullopt;
  auto parsed = json::parse(text, nullptr, false);
  if (!parsed.is_object()) return std::nullopt;
  ServiceAuthConfig cfg;
  cfg.sid = parsed.value("sid", "");
  cfg.token = parsed.value("token", "");
  cfg.home = Utf8ToWide(parsed.value("home", ""));
  cfg.sha256 = parsed.value("sha256", "");
  if (cfg.sid.empty() || cfg.token.empty() || cfg.home.empty()) return std::nullopt;
  if (!ValidateSidString(Utf8ToWide(cfg.sid))) return std::nullopt;
  return cfg;
}

HANDLE LaunchSessionSystemProcess(const std::wstring& exe_path, const std::wstring& arguments, DWORD session_id) {
  HANDLE proc_token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &proc_token)) return nullptr;
  HANDLE dup_token = nullptr;
  if (!DuplicateTokenEx(proc_token, MAXIMUM_ALLOWED, nullptr, SecurityIdentification, TokenPrimary, &dup_token)) {
    CloseHandle(proc_token);
    return nullptr;
  }
  if (!SetTokenInformation(dup_token, TokenSessionId, &session_id, sizeof(DWORD))) {
    CloseHandle(dup_token);
    CloseHandle(proc_token);
    return nullptr;
  }

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  wchar_t desktop_name[] = L"winsta0\\default";
  si.lpDesktop = desktop_name;

  std::wstring dir = exe_path;
  size_t slash = dir.find_last_of(L"\\/");
  if (slash != std::wstring::npos) dir.resize(slash);

  std::wstring cmd = L"\"" + exe_path + L"\" " + arguments;
  PROCESS_INFORMATION pi{};
  BOOL ok = CreateProcessAsUserW(
      dup_token,
      exe_path.c_str(),
      cmd.data(),
      nullptr,
      nullptr,
      FALSE,
      CREATE_NO_WINDOW,
      nullptr,
      dir.empty() ? nullptr : dir.c_str(),
      &si,
      &pi);
  CloseHandle(dup_token);
  CloseHandle(proc_token);
  if (!ok) return nullptr;
  CloseHandle(pi.hThread);
  return pi.hProcess;
}

void BridgePipes(HANDLE a, HANDLE b, HANDLE stop_event) {
  HANDLE bridge_done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  auto pump = [&](HANDLE src, HANDLE dst) {
    std::vector<uint8_t> buf(65536);
    for (;;) {
      if (stop_event && WaitForSingleObject(stop_event, 0) == WAIT_OBJECT_0) break;
      DWORD got = 0;
      if (!PipeReadSome(src, buf.data(), static_cast<DWORD>(buf.size()), &got, bridge_done, INFINITE) || got == 0) {
        break;
      }
      if (!PipeWriteAll(dst, buf.data(), got, bridge_done, 10000)) {
        break;
      }
    }
    if (bridge_done) SetEvent(bridge_done);
    CancelIoEx(src, nullptr);
    CancelIoEx(dst, nullptr);
  };

  std::thread t1(pump, a, b);
  std::thread t2(pump, b, a);
  if (t1.joinable()) t1.join();
  if (t2.joinable()) t2.join();
  if (bridge_done) CloseHandle(bridge_done);
}

void HandleElevatedServiceClient(HANDLE client_pipe, HANDLE stop_event) {
  auto auth = LoadServiceAuthConfig();
  if (!auth || !IsServiceSharingEnabledWide(auth->home)) return;

  std::string hs_line;
  if (!PipeReadLine(client_pipe, &hs_line, 2048, stop_event, 5000) || hs_line.empty()) return;
  auto req = json::parse(hs_line, nullptr, false);
  if (!req.is_object()) return;
  std::string token = req.value("token", "");
  if (!ConstantTimeEquals(token, auth->token)) return;

  std::string mode = req.value("mode", "");
  if (mode == "vdd-enable" || mode == "vdd-disable" || mode == "vdd-configure") {
    int vw = std::clamp(req.value("w", 0), 0, 3840);
    int vh = std::clamp(req.value("h", 0), 0, 2400);
    int vhz = std::clamp(req.value("fps", 0), 0, 144);
    int vcnt = std::clamp(req.value("count", 0), 0, 2);
    bool ok = ConfigureVddFromService(mode, vw, vh, vhz, vcnt);
    std::string resp = ok ? "{\"ok\":true}\n" : "{\"ok\":false}\n";
    PipeWriteAll(client_pipe, resp.data(), resp.size(), stop_event, 5000);
    FlushFileBuffers(client_pipe);
    return;
  }

  if (mode != "displays" && mode != "control" && mode != "capture-raw" && mode != "capture-jpeg") {
    return;
  }

  int screen = std::clamp(req.value("screen", 0), 0, 15);
  int w = std::clamp(req.value("w", 1920), 320, 3840);
  int h = std::clamp(req.value("h", 1080), 180, 2160);
  int fps = std::clamp(req.value("fps", 30), 1, 30);
  int quality = std::clamp(req.value("quality", 80), 35, 92);

  DWORD session_id = WTSGetActiveConsoleSessionId();
  if (session_id == 0xFFFFFFFF) return;

  std::wstring worker_pipe_short = L"LinkShellScreenWorker-" + Utf8ToWide(GenerateRandomHex(16));
  std::wstring worker_pipe_full = L"\\\\.\\pipe\\" + worker_pipe_short;

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) return;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
  jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli))) {
    CloseHandle(job);
    return;
  }

  ScopedSddlSecurity sys_sec;
  if (!sys_sec.Init(L"D:P(A;;FA;;;SY)")) {
    CloseHandle(job);
    return;
  }

  HANDLE worker_pipe = CreateNamedPipeW(
      worker_pipe_full.c_str(),
      PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
      1,
      256 * 1024,
      256 * 1024,
      0,
      &sys_sec.sa);
  if (worker_pipe == INVALID_HANDLE_VALUE) {
    CloseHandle(job);
    return;
  }

  std::wstring self_exe = ServiceExePath();
  if (!FileExistsWide(self_exe)) {
    CloseHandle(worker_pipe);
    CloseHandle(job);
    return;
  }

  std::string home_utf8 = WideToUtf8(auth->home);
  std::string home_b64 = Base64EncodeBytes(reinterpret_cast<const uint8_t*>(home_utf8.data()), home_utf8.size());

  std::wostringstream wargs;
  wargs << L"--service-worker " << worker_pipe_short << L" " << Utf8ToWide(mode)
        << L" " << screen << L" " << w << L" " << h << L" " << fps << L" " << quality
        << L" " << Utf8ToWide(home_b64);

  HANDLE connect_ev = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  OVERLAPPED ov{};
  ov.hEvent = connect_ev;
  BOOL connected_now = ConnectNamedPipe(worker_pipe, &ov);
  DWORD conn_err = connected_now ? ERROR_PIPE_CONNECTED : GetLastError();
  if (!connected_now && conn_err != ERROR_IO_PENDING && conn_err != ERROR_PIPE_CONNECTED) {
    if (connect_ev) CloseHandle(connect_ev);
    CloseHandle(worker_pipe);
    CloseHandle(job);
    return;
  }

  HANDLE proc = LaunchSessionSystemProcess(self_exe, wargs.str(), session_id);
  if (!proc) {
    CancelIoEx(worker_pipe, &ov);
    if (connect_ev) CloseHandle(connect_ev);
    CloseHandle(worker_pipe);
    CloseHandle(job);
    return;
  }

  if (AssignProcessToJobObject(job, proc)) {
    bool ready = (conn_err == ERROR_PIPE_CONNECTED);
    if (!ready) {
      HANDLE waits[2] = {connect_ev, stop_event};
      DWORD w_rc = WaitForMultipleObjects(stop_event ? 2 : 1, waits, FALSE, 5000);
      DWORD ignored = 0;
      if (w_rc == WAIT_OBJECT_0 && GetOverlappedResult(worker_pipe, &ov, &ignored, FALSE)) {
        ready = true;
      } else {
        CancelIoEx(worker_pipe, &ov);
      }
    }
    if (ready) {
      BridgePipes(client_pipe, worker_pipe, stop_event);
    }
  }

  if (connect_ev) CloseHandle(connect_ev);
  DisconnectNamedPipe(worker_pipe);
  CloseHandle(worker_pipe);
  CloseHandle(proc);
  CloseHandle(job);
}

// Service globals for StartServiceCtrlDispatcherW.
SERVICE_STATUS_HANDLE g_svc_status_handle = nullptr;
HANDLE g_svc_stop_event = nullptr;
std::atomic<int> g_active_clients{0};

void ReportServiceState(DWORD state, DWORD exit_code = NO_ERROR, DWORD wait_hint = 0) {
  if (!g_svc_status_handle) return;
  static DWORD check_point = 1;
  SERVICE_STATUS status{};
  status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  status.dwCurrentState = state;
  status.dwControlsAccepted = (state == SERVICE_START_PENDING) ? 0 : (SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN);
  status.dwWin32ExitCode = exit_code;
  status.dwWaitHint = wait_hint;
  status.dwCheckPoint = (state == SERVICE_RUNNING || state == SERVICE_STOPPED) ? 0 : check_point++;
  SetServiceStatus(g_svc_status_handle, &status);
}

DWORD WINAPI ServiceCtrlHandler(DWORD control, DWORD, LPVOID, LPVOID) {
  if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) {
    LogServiceEvent("service stopping");
    ReportServiceState(SERVICE_STOP_PENDING, NO_ERROR, 5000);
    if (g_svc_stop_event) SetEvent(g_svc_stop_event);
    return NO_ERROR;
  }
  if (control == SERVICE_CONTROL_INTERROGATE) {
    return NO_ERROR;
  }
  return ERROR_CALL_NOT_IMPLEMENTED;
}

void ServiceAcceptLoop() {
  while (WaitForSingleObject(g_svc_stop_event, 0) != WAIT_OBJECT_0) {
    auto auth = LoadServiceAuthConfig();
    if (!auth) {
      WaitForSingleObject(g_svc_stop_event, 1000);
      continue;
    }

    ScopedSddlSecurity pipe_sec;
    std::wstring sddl = L"D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x12019f;;;" + Utf8ToWide(auth->sid) + L")";
    if (!pipe_sec.Init(sddl)) {
      WaitForSingleObject(g_svc_stop_event, 1000);
      continue;
    }

    HANDLE pipe = CreateNamedPipeW(
        kElevatedPipePath,
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        8,
        65536,
        65536,
        0,
        &pipe_sec.sa);
    if (pipe == INVALID_HANDLE_VALUE) {
      WaitForSingleObject(g_svc_stop_event, 250);
      continue;
    }

    HANDLE ev = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    OVERLAPPED ov{};
    ov.hEvent = ev;
    BOOL immediate = ConnectNamedPipe(pipe, &ov);
    DWORD err = immediate ? ERROR_PIPE_CONNECTED : GetLastError();
    bool connected = (err == ERROR_PIPE_CONNECTED);
    if (!connected && err == ERROR_IO_PENDING) {
      HANDLE waits[2] = {ev, g_svc_stop_event};
      DWORD w = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
      DWORD ignored = 0;
      if (w == WAIT_OBJECT_0 && GetOverlappedResult(pipe, &ov, &ignored, FALSE)) {
        connected = true;
      } else {
        CancelIoEx(pipe, &ov);
        GetOverlappedResult(pipe, &ov, &ignored, TRUE);
      }
    }
    if (ev) CloseHandle(ev);

    if (!connected || WaitForSingleObject(g_svc_stop_event, 0) == WAIT_OBJECT_0) {
      CloseHandle(pipe);
      continue;
    }

    if (g_active_clients.fetch_add(1) >= 8) {
      g_active_clients.fetch_sub(1);
      DisconnectNamedPipe(pipe);
      CloseHandle(pipe);
      continue;
    }

    std::thread([pipe]() {
      try {
        HandleElevatedServiceClient(pipe, g_svc_stop_event);
      } catch (...) {}
      DisconnectNamedPipe(pipe);
      CloseHandle(pipe);
      g_active_clients.fetch_sub(1);
    }).detach();
  }
}

void WINAPI ServiceMainEntry(DWORD, LPWSTR*) {
  g_svc_status_handle = RegisterServiceCtrlHandlerExW(kElevatedServiceName, ServiceCtrlHandler, nullptr);
  if (!g_svc_status_handle) return;

  ReportServiceState(SERVICE_START_PENDING, NO_ERROR, 3000);
  g_svc_stop_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!g_svc_stop_event) {
    ReportServiceState(SERVICE_STOPPED, GetLastError());
    return;
  }

  LogServiceEvent("service starting");
  std::thread accept_thread(ServiceAcceptLoop);
  ReportServiceState(SERVICE_RUNNING);

  WaitForSingleObject(g_svc_stop_event, INFINITE);
  if (accept_thread.joinable()) accept_thread.join();

  // Briefly allow in-flight client handlers to unwind.
  for (int i = 0; i < 20 && g_active_clients.load() > 0; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }

  CloseHandle(g_svc_stop_event);
  g_svc_stop_event = nullptr;
  ReportServiceState(SERVICE_STOPPED);
}

// Session-N worker helpers (`--service-worker`):
bool ServiceAttachActiveDesktop(HDESK* current_desktop, std::wstring* current_name) {
  HDESK h_input = OpenInputDesktop(0, FALSE, GENERIC_ALL);
  if (!h_input) return false;
  std::wstring name = DesktopNameOf(h_input);
  if (*current_desktop && _wcsicmp(name.c_str(), current_name->c_str()) == 0) {
    CloseDesktop(h_input);
    return true;
  }
  if (!SetThreadDesktop(h_input)) {
    CloseDesktop(h_input);
    return false;
  }
  if (*current_desktop) CloseDesktop(*current_desktop);
  *current_desktop = h_input;
  *current_name = std::move(name);
  return true;
}

RECT ServiceDisplayBounds(int screen) {
  auto all = EnumerateHelperDisplays(true);
  if (all.empty()) {
    return RECT{0, 0, std::max(640, GetSystemMetrics(SM_CXSCREEN)), std::max(480, GetSystemMetrics(SM_CYSCREEN))};
  }
  if (screen < 0 || screen >= static_cast<int>(all.size())) screen = 0;
  return all[static_cast<size_t>(screen)].bounds;
}

void RunServiceControlWorker(HANDLE pipe, int screen, const std::wstring& home, HDESK* h_desk, std::wstring* desk_name) {
  ServiceAttachActiveDesktop(h_desk, desk_name);
  RECT bounds = ServiceDisplayBounds(screen);
  std::mutex write_mu;
  auto send_json = [&](const json& j) -> bool {
    std::string line = j.dump(-1, ' ', false, json::error_handler_t::replace) + "\n";
    std::lock_guard<std::mutex> lock(write_mu);
    return PipeWriteAll(pipe, line.data(), line.size());
  };

  if (!send_json({{"t", "ready"}, {"trusted", true}, {"app", "LinkShell"}})) return;

  std::mutex q_mu;
  std::deque<std::string> lines;
  bool eof = false;
  HANDLE wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);

  std::thread reader([&]() {
    std::string ln;
    while (PipeReadLine(pipe, &ln, 32768)) {
      {
        std::lock_guard<std::mutex> lock(q_mu);
        lines.push_back(std::move(ln));
      }
      if (wake) SetEvent(wake);
    }
    {
      std::lock_guard<std::mutex> lock(q_mu);
      eof = true;
    }
    if (wake) SetEvent(wake);
  });

  InputState input;
  POINT last{INT_MIN, INT_MIN};
  std::wstring prev_desk = *desk_name;

  for (;;) {
    if (!IsServiceSharingEnabledWide(home)) break;
    ServiceAttachActiveDesktop(h_desk, desk_name);
    if (_wcsicmp(prev_desk.c_str(), desk_name->c_str()) != 0) {
      input.Release(false);
      prev_desk = *desk_name;
    }
    bounds = ServiceDisplayBounds(screen);
    POINT p{};
    if (GetCursorPos(&p) && (p.x != last.x || p.y != last.y)) {
      double bw = std::max(1, static_cast<int>(bounds.right - bounds.left));
      double bh = std::max(1, static_cast<int>(bounds.bottom - bounds.top));
      if (!send_json({
              {"t", "cursor"},
              {"x", std::clamp((p.x - bounds.left) / bw, 0.0, 1.0)},
              {"y", std::clamp((p.y - bounds.top) / bh, 0.0, 1.0)},
          })) {
        break;
      }
      last = p;
    }

    std::string line;
    bool has_line = false;
    {
      std::lock_guard<std::mutex> lock(q_mu);
      if (!lines.empty()) {
        line = std::move(lines.front());
        lines.pop_front();
        has_line = true;
      } else if (eof) {
        break;
      }
    }
    if (!has_line) {
      if (wake) WaitForSingleObject(wake, 16);
      continue;
    }
    if (line.size() > 32000) continue;
    auto parsed = json::parse(line, nullptr, false);
    if (!parsed.is_object()) continue;
    try {
      input.Handle(parsed, bounds);
    } catch (...) {
      input.Release(false);
    }
  }

  input.Release(false);
  CancelIoEx(pipe, nullptr);
  if (reader.joinable()) reader.join();
  if (wake) CloseHandle(wake);
}

void RunServiceCaptureWorkerCommon(
    HANDLE pipe,
    int screen,
    int req_w,
    int req_h,
    int fps,
    int quality,
    bool jpeg_mode,
    const std::wstring& home,
    HDESK* h_desk,
    std::wstring* desk_name) {
  ServiceAttachActiveDesktop(h_desk, desk_name);
  RECT initial = ServiceDisplayBounds(screen);
  int init_bw = std::max(2, static_cast<int>(initial.right - initial.left));
  int init_bh = std::max(2, static_cast<int>(initial.bottom - initial.top));

  int w = jpeg_mode ? std::max(2, std::min(req_w, init_bw)) : std::max(2, (req_w / 2) * 2);
  int h = jpeg_mode ? std::max(2, static_cast<int>(static_cast<int64_t>(init_bh) * w / init_bw))
                    : std::max(2, (req_h / 2) * 2);
  const int row_bytes = w * 3;
  const int dib_stride = ((row_bytes + 3) / 4) * 4;
  std::vector<uint8_t> packed(static_cast<size_t>(row_bytes) * static_cast<size_t>(h));
  std::vector<uint8_t> jpeg_bytes;

  HDC screen_dc = nullptr;
  HDC mem_dc = nullptr;
  HBITMAP dib = nullptr;
  void* bits = nullptr;
  std::wstring dc_desk;
  const int interval_ms = std::max(33, static_cast<int>(std::ceil(1000.0 / std::clamp(fps, 1, 30))));

  auto cleanup_gdi = [&]() {
    if (dib) { DeleteObject(dib); dib = nullptr; bits = nullptr; }
    if (mem_dc) { DeleteDC(mem_dc); mem_dc = nullptr; }
    if (screen_dc) { ReleaseDC(nullptr, screen_dc); screen_dc = nullptr; }
  };

  while (IsServiceSharingEnabledWide(home)) {
    int64_t began = MonotonicMs();
    ServiceAttachActiveDesktop(h_desk, desk_name);
    if (!screen_dc || _wcsicmp(dc_desk.c_str(), desk_name->c_str()) != 0) {
      cleanup_gdi();
      screen_dc = GetDC(nullptr);
      dc_desk = *desk_name;
      if (screen_dc) {
        mem_dc = CreateCompatibleDC(screen_dc);
        BITMAPINFO bmi{};
        bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        bmi.bmiHeader.biWidth = w;
        bmi.bmiHeader.biHeight = -h;
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 24;
        bmi.bmiHeader.biCompression = BI_RGB;
        dib = CreateDIBSection(screen_dc, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
      }
    }
    if (!screen_dc || !mem_dc || !dib || !bits) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      continue;
    }

    RECT b = ServiceDisplayBounds(screen);
    HGDIOBJ old = SelectObject(mem_dc, dib);
    SetStretchBltMode(mem_dc, HALFTONE);
    SetBrushOrgEx(mem_dc, 0, 0, nullptr);
    BOOL ok = StretchBlt(mem_dc, 0, 0, w, h, screen_dc, b.left, b.top, b.right - b.left, b.bottom - b.top, 0x40CC0020);
    GdiFlush();
    SelectObject(mem_dc, old);

    if (!ok) {
      cleanup_gdi();
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
      continue;
    }

    const auto* src = static_cast<const uint8_t*>(bits);
    if (dib_stride == row_bytes) {
      std::memcpy(packed.data(), src, packed.size());
    } else {
      for (int y = 0; y < h; ++y) {
        std::memcpy(packed.data() + static_cast<size_t>(y) * row_bytes, src + static_cast<size_t>(y) * dib_stride, row_bytes);
      }
    }

    if (jpeg_mode) {
      if (!EncodeBgr24ToJpeg(packed.data(), w, h, row_bytes, quality, &jpeg_bytes)) break;
      uint32_t len_le = static_cast<uint32_t>(jpeg_bytes.size());
      if (!PipeWriteAll(pipe, &len_le, 4) || !PipeWriteAll(pipe, jpeg_bytes.data(), jpeg_bytes.size())) break;
    } else {
      if (!PipeWriteAll(pipe, packed.data(), packed.size())) break;
    }
    FlushFileBuffers(pipe);

    int wait = interval_ms - static_cast<int>(MonotonicMs() - began);
    if (wait > 0) std::this_thread::sleep_for(std::chrono::milliseconds(wait));
  }

  cleanup_gdi();
}

}  // namespace

void ClearServiceLastError(const std::wstring& home) {
  if (home.empty()) return;
  DeleteFileW(UserServiceErrorPath(home).c_str());
}

void WriteServiceLastError(const std::wstring& home, std::string_view message) {
  if (home.empty() || message.empty()) return;
  WriteUtf8FileWide(UserServiceErrorPath(home), message);
}

void LogServiceEvent(std::string_view message) {
  std::wstring path = ServiceDataDir() + L"\\service.log";
  HANDLE h = CreateFileW(path.c_str(), FILE_APPEND_DATA | SYNCHRONIZE, FILE_SHARE_READ, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return;
  LARGE_INTEGER sz{};
  if (GetFileSizeEx(h, &sz) && sz.QuadPart > 65536) {
    CloseHandle(h);
    h = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return;
  }
  SYSTEMTIME st{};
  GetSystemTime(&st);
  char ts[64];
  std::snprintf(ts, sizeof(ts), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ ",
                st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
  std::string line = std::string(ts) + std::string(message) + "\r\n";
  WriteAllBytes(h, line.data(), line.size());
  CloseHandle(h);
}

bool IsElevatedServiceAvailable(bool dry_run) {
  if (dry_run) return false;
  bool installed = false, running = false;
  if (!QueryElevatedServiceState(&installed, &running) || !installed || !running) return false;
  return !ReadUserServiceToken().empty();
}

void PrintElevatedServiceStatus() {
  bool installed = false, running = false;
  QueryElevatedServiceState(&installed, &running);
  bool authorized = !ReadUserServiceToken().empty();
  bool outdated = false;
  if (installed) {
    std::wstring svc_exe = ServiceExePath();
    if (!FileExistsWide(svc_exe)) {
      outdated = true;
    } else {
      std::string installed_hash = FileSha256HexWide(svc_exe);
      std::string current_hash = FileSha256HexWide(CurrentExePathWide());
      outdated = !installed_hash.empty() && !current_hash.empty() &&
                 !EqualsIgnoreCaseAscii(installed_hash, current_hash);
    }
  }
  WriteStdoutJson({
      {"installed", installed},
      {"running", running},
      {"authorized", authorized},
      {"outdated", outdated},
  });
}

void InstallElevatedService(const std::wstring& user_sid, const std::wstring& user_home) {
  if (!IsRunningAsAdministrator()) {
    throw std::runtime_error("安装系统控制服务需要管理员权限");
  }
  if (!ValidateSidString(user_sid)) {
    throw std::runtime_error("缺少或无效的用户 SID");
  }
  std::wstring home = user_home.empty() ? UserHomeDirWide() : user_home;
  if (home.size() < 3) {
    throw std::runtime_error("无效的 LinkShell 数据目录");
  }

  std::wstring install_dir = ServiceInstallDir();
  std::wstring target_exe = ServiceExePath();
  std::wstring data_dir = ServiceDataDir();
  std::wstring source_exe = CurrentExePathWide();

  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_ALL_ACCESS);
  if (!scm) {
    throw std::runtime_error("无法打开 Windows 服务管理器：" + std::to_string(GetLastError()));
  }

  SC_HANDLE existing = OpenServiceW(scm, kElevatedServiceName, SERVICE_ALL_ACCESS);
  if (existing) {
    StopServiceAndWaitForExit(existing);
    CloseServiceHandle(existing);
  }

  EnsureDirectoryTreeWide(install_dir);
  ApplyServiceBinaryDirectoryAcl(install_dir);

  if (_wcsicmp(source_exe.c_str(), target_exe.c_str()) != 0) {
    bool copied = false;
    DWORD copy_err = 0;
    for (int attempt = 0; attempt < 15; ++attempt) {
      if (CopyFileW(source_exe.c_str(), target_exe.c_str(), FALSE)) {
        copied = true;
        break;
      }
      copy_err = GetLastError();
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
    if (!copied) {
      CloseServiceHandle(scm);
      throw std::runtime_error("复制系统控制服务组件失败：" + std::to_string(copy_err));
    }
  }

  EnsureDirectoryTreeWide(data_dir);
  ApplyAdminOnlyDirectoryAcl(data_dir);

  std::string token = GenerateRandomHex(32);
  std::string exe_hash = FileSha256HexWide(target_exe);
  json auth_payload = {
      {"sid", WideToUtf8(user_sid)},
      {"token", token},
      {"home", WideToUtf8(home)},
      {"sha256", exe_hash},
  };
  if (!WriteUtf8FileWide(ServiceAuthPath(), auth_payload.dump())) {
    CloseServiceHandle(scm);
    throw std::runtime_error("写入系统控制服务认证配置失败");
  }

  EnsureDirectoryTreeWide(home);
  std::wstring token_path = UserServiceTokenPath(home);
  if (!WriteUtf8FileWide(token_path, token)) {
    CloseServiceHandle(scm);
    throw std::runtime_error("写入用户控制令牌失败");
  }
  ApplyUserTokenFileAcl(token_path, user_sid);

  std::wstring bin_path = L"\"" + target_exe + L"\" --service";
  SC_HANDLE svc = OpenServiceW(scm, kElevatedServiceName, SERVICE_ALL_ACCESS);
  if (!svc) {
    svc = CreateServiceW(
        scm,
        kElevatedServiceName,
        kElevatedServiceDisplayName,
        SERVICE_ALL_ACCESS,
        SERVICE_WIN32_OWN_PROCESS,
        SERVICE_AUTO_START,
        SERVICE_ERROR_NORMAL,
        bin_path.c_str(),
        nullptr,
        nullptr,
        nullptr,
        nullptr,
        nullptr);
    if (!svc) {
      DWORD err = GetLastError();
      CloseServiceHandle(scm);
      throw std::runtime_error("注册系统控制服务失败：" + std::to_string(err));
    }
  } else {
    if (!ChangeServiceConfigW(
            svc,
            SERVICE_WIN32_OWN_PROCESS,
            SERVICE_AUTO_START,
            SERVICE_ERROR_NORMAL,
            bin_path.c_str(),
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            kElevatedServiceDisplayName)) {
      DWORD err = GetLastError();
      CloseServiceHandle(svc);
      CloseServiceHandle(scm);
      throw std::runtime_error("更新系统控制服务配置失败：" + std::to_string(err));
    }
  }

  if (!StartServiceW(svc, 0, nullptr)) {
    DWORD err = GetLastError();
    if (err != ERROR_SERVICE_ALREADY_RUNNING) {
      CloseServiceHandle(svc);
      CloseServiceHandle(scm);
      throw std::runtime_error("启动系统控制服务失败：" + std::to_string(err));
    }
  }

  int64_t t0 = MonotonicMs();
  bool started = false;
  while (MonotonicMs() - t0 < 10000) {
    SERVICE_STATUS st{};
    if (QueryServiceStatus(svc, &st) && st.dwCurrentState == SERVICE_RUNNING) {
      started = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
  }
  CloseServiceHandle(svc);
  CloseServiceHandle(scm);
  if (!started) {
    throw std::runtime_error("系统控制服务启动超时");
  }
}

void UninstallElevatedService(const std::wstring& user_home) {
  if (!IsRunningAsAdministrator()) {
    throw std::runtime_error("卸载系统控制服务需要管理员权限");
  }
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_ALL_ACCESS);
  if (!scm) {
    throw std::runtime_error("无法打开 Windows 服务管理器：" + std::to_string(GetLastError()));
  }
  SC_HANDLE svc = OpenServiceW(scm, kElevatedServiceName, SERVICE_ALL_ACCESS);
  if (svc) {
    StopServiceAndWaitForExit(svc);
    DeleteService(svc);
    CloseServiceHandle(svc);
  }
  CloseServiceHandle(scm);

  std::wstring home = user_home.empty() ? UserHomeDirWide() : user_home;
  DeleteFileW(UserServiceTokenPath(home).c_str());
  RemoveDirectoryRecursiveWide(ServiceDataDir());

  std::wstring install_dir = ServiceInstallDir();
  std::wstring current_exe = CurrentExePathWide();
  if (DirectoryExistsWide(install_dir) && !StartsWithIgnoreCaseAscii(WideToUtf8(current_exe), WideToUtf8(install_dir))) {
    RemoveDirectoryRecursiveWide(install_dir);
  }
}

void RunElevatedWindowsService() {
  wchar_t name[] = L"LinkShellScreenService";
  SERVICE_TABLE_ENTRYW table[] = {
      {name, ServiceMainEntry},
      {nullptr, nullptr},
  };
  StartServiceCtrlDispatcherW(table);
}

void RunElevatedServiceWorker(
    const std::wstring& pipe_name,
    const std::string& mode,
    int screen,
    int w,
    int h,
    int fps,
    int quality,
    const std::string& home_b64) {
  std::vector<uint8_t> home_bytes;
  if (!Base64DecodeBytes(home_b64, &home_bytes) || home_bytes.empty()) return;
  std::wstring home = Utf8ToWide(std::string(reinterpret_cast<const char*>(home_bytes.data()), home_bytes.size()));
  if (!IsServiceSharingEnabledWide(home)) return;

  std::string worker_err;
  // Clean worker thread with zero GUI/COM windows so SetThreadDesktop switches freely across Default & Winlogon.
  std::thread worker([&]() {
    HDESK h_desk = nullptr;
    std::wstring desk_name;
    std::wstring full_pipe = L"\\\\.\\pipe\\" + pipe_name;
    WaitNamedPipeW(full_pipe.c_str(), 5000);
    HANDLE pipe = CreateFileW(
        full_pipe.c_str(),
        GENERIC_READ | GENERIC_WRITE,
        0,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_OVERLAPPED,
        nullptr);
    if (pipe == INVALID_HANDLE_VALUE) {
      worker_err = "connect worker pipe failed: " + std::to_string(GetLastError());
      return;
    }

    try {
      if (mode == "displays") {
        ServiceAttachActiveDesktop(&h_desk, &desk_name);
        auto list = EnumerateHelperDisplays(true);
        json arr = json::array();
        for (size_t i = 0; i < list.size(); ++i) {
          arr.push_back({
              {"screen", static_cast<int>(i)},
              {"name", list[i].primary ? "主屏幕" : ("屏幕 " + std::to_string(i + 1))},
              {"w", list[i].width()},
              {"h", list[i].height()},
              {"main", list[i].primary},
          });
        }
        std::string line = arr.dump() + "\n";
        PipeWriteAll(pipe, line.data(), line.size());
        FlushFileBuffers(pipe);
      } else if (mode == "control") {
        RunServiceControlWorker(pipe, screen, home, &h_desk, &desk_name);
      } else if (mode == "capture-raw") {
        RunServiceCaptureWorkerCommon(pipe, screen, w, h, fps, quality, false, home, &h_desk, &desk_name);
      } else if (mode == "capture-jpeg") {
        RunServiceCaptureWorkerCommon(pipe, screen, w, h, fps, quality, true, home, &h_desk, &desk_name);
      }
    } catch (const std::exception& ex) {
      worker_err = ex.what();
    }
    CloseHandle(pipe);
    if (h_desk) CloseDesktop(h_desk);
  });
  worker.join();
  if (!worker_err.empty()) {
    std::cerr << "[service-worker] " << worker_err << "\n";
  }
}

// ── Unprivileged Client Pipe Helpers ──────────────────────────────────────────

HANDLE ConnectElevatedServicePipe(const std::string& mode, int screen, int w, int h, int fps, int quality) {
  std::string token = ReadUserServiceToken();
  if (token.empty()) return INVALID_HANDLE_VALUE;
  bool installed = false, running = false;
  if (!QueryElevatedServiceState(&installed, &running) || !installed || !running) {
    return INVALID_HANDLE_VALUE;
  }

  WaitNamedPipeW(kElevatedPipePath, 1500);
  HANDLE pipe = CreateFileW(
      kElevatedPipePath,
      GENERIC_READ | GENERIC_WRITE,
      0,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED,
      nullptr);
  if (pipe == INVALID_HANDLE_VALUE) return INVALID_HANDLE_VALUE;

  json hs = {
      {"token", token},
      {"mode", mode},
      {"screen", screen},
      {"w", w},
      {"h", h},
      {"fps", fps},
      {"quality", quality},
  };
  std::string line = hs.dump() + "\n";
  if (!PipeWriteAll(pipe, line.data(), line.size(), nullptr, 2000)) {
    CloseHandle(pipe);
    return INVALID_HANDLE_VALUE;
  }
  return pipe;
}

bool TryServiceDisplaysJson(std::string* out_json) {
  if (!out_json) return false;
  HANDLE pipe = ConnectElevatedServicePipe("displays", 0, 640, 480, 1, 75);
  if (pipe == INVALID_HANDLE_VALUE) return false;
  std::string line;
  bool ok = PipeReadLine(pipe, &line, 65536, nullptr, 3000) && !line.empty() && line.front() == '[';
  CloseHandle(pipe);
  if (ok) *out_json = std::move(line);
  return ok;
}

bool TryServiceDisplayBounds(int screen, RECT* out_rect) {
  if (!out_rect) return false;
  std::string json_str;
  if (!TryServiceDisplaysJson(&json_str)) return false;
  auto list = json::parse(json_str, nullptr, false);
  if (!list.is_array() || list.empty()) return false;
  size_t idx = (screen >= 0 && static_cast<size_t>(screen) < list.size()) ? static_cast<size_t>(screen) : 0;
  const auto& item = list[idx];
  if (!item.is_object()) return false;
  int w = std::max(2, item.value("w", 0));
  int h = std::max(2, item.value("h", 0));
  *out_rect = RECT{0, 0, w, h};
  return true;
}

bool TryRunElevatedControl(int screen, bool dry_run) {
  if (dry_run) return false;
  HANDLE pipe = ConnectElevatedServicePipe("control", screen, 640, 480, 1, 75);
  if (pipe == INVALID_HANDLE_VALUE) return false;

  std::string first_line;
  if (!PipeReadLine(pipe, &first_line, 4096, nullptr, 3000) || first_line.find("\"ready\"") == std::string::npos) {
    CloseHandle(pipe);
    return false;
  }
  WriteStdoutLine(first_line);

  std::atomic<bool> stdin_done{false};
  HANDLE stop_ev = CreateEventW(nullptr, TRUE, FALSE, nullptr);

  std::thread writer([&]() {
    std::string line;
    while (std::getline(std::cin, line)) {
      try {
        EnsureSharingEnabled(false);
      } catch (...) {
        break;
      }
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.size() > 32000) continue;
      line.push_back('\n');
      if (!PipeWriteAll(pipe, line.data(), line.size(), stop_ev, 5000)) break;
    }
    stdin_done.store(true);
    if (stop_ev) SetEvent(stop_ev);
    CancelIoEx(pipe, nullptr);
  });

  std::string out_line;
  bool sharing_aborted = false;
  while (PipeReadLine(pipe, &out_line, 8192, stop_ev, 250)) {
    try {
      EnsureSharingEnabled(false);
    } catch (...) {
      sharing_aborted = true;
      break;
    }
    WriteStdoutLine(out_line);
  }

  if (stop_ev) SetEvent(stop_ev);
  CancelIoEx(pipe, nullptr);
  if (writer.joinable()) writer.join();
  if (stop_ev) CloseHandle(stop_ev);
  CloseHandle(pipe);

  if (sharing_aborted) {
    EnsureSharingEnabled(false);
  }
  return stdin_done.load();
}

bool TryStreamSecureDesktopJpeg(int screen, int width, int fps, int quality, HANDLE stdout_handle, const std::atomic<bool>& ended) {
  HANDLE pipe = ConnectElevatedServicePipe("capture-jpeg", screen, width, 1080, fps, quality);
  if (pipe == INVALID_HANDLE_VALUE) return false;

  uint8_t len_buf[4] = {};
  std::vector<uint8_t> payload;
  bool ok = true;
  while (!ended.load()) {
    EnsureSharingEnabled(false);
    if (IsDefaultDesktopActive(false)) break;
    if (!PipeReadExact(pipe, len_buf, 4, nullptr, 3000)) break;
    uint32_t len = 0;
    std::memcpy(&len, len_buf, 4);
    if (len < 4 || len > 16 * 1024 * 1024) {
      ok = false;
      break;
    }
    payload.resize(len);
    if (!PipeReadExact(pipe, payload.data(), len, nullptr, 5000)) break;
    if (!WriteAllBytes(stdout_handle, len_buf, 4) || !WriteAllBytes(stdout_handle, payload.data(), len)) break;
    FlushFileBuffers(stdout_handle);
  }
  CloseHandle(pipe);
  return ok;
}

bool TryStreamSecureDesktopVideo(
    HANDLE job,
    HANDLE destination,
    const std::wstring& executable,
    int screen,
    int w,
    int h,
    int fps,
    int bitrate,
    const std::string& preferred_encoder,
    bool framed,
    const std::atomic<bool>& ended) {
  HANDLE pipe = ConnectElevatedServicePipe("capture-raw", screen, w, h, fps, 75);
  if (pipe == INVALID_HANDLE_VALUE) return false;

  const size_t frame_bytes = static_cast<size_t>(w) * static_cast<size_t>(h) * 3;
  std::vector<uint8_t> first_frame(frame_bytes);
  if (!PipeReadExact(pipe, first_frame.data(), frame_bytes, nullptr, 5000)) {
    CloseHandle(pipe);
    return false;
  }

  std::vector<std::string> encoders = {preferred_encoder};
  if (preferred_encoder != "h264_mf") encoders.push_back("h264_mf");
  bool baseline = EqualsIgnoreCaseAscii(WideToUtf8(GetEnvWide(L"LINKSHELL_WINDOWS_PROFILE")), "baseline");

  for (const auto& encoder : encoders) {
    if (ended.load()) {
      CloseHandle(pipe);
      return true;
    }
    bool level52 = w * h > 3686400;
    bool level51 = w * h > 2088960;
    std::string nv_lvl = level52 ? "5.2" : (level51 ? "5.1" : "4.2");
    std::string num_lvl = level52 ? "52" : (level51 ? "51" : "42");
    std::string tuning = (encoder == "h264_amf")
                             ? "-usage lowlatency -quality quality -rc vbr_latency -qp_i 18 -qp_p 20 -min_qp_i 14 -max_qp_i 32 -min_qp_p 14 -max_qp_p 34 -async_depth 1 -preanalysis 0"
                         : (encoder == "h264_nvenc")
                             ? "-preset p4 -tune ll -rc vbr -cq 19 -qmin 14 -qmax 32 -zerolatency 1 -delay 0 -rc-lookahead 0 -spatial-aq 1 -aq-strength 10"
                         : (encoder == "h264_qsv")
                             ? "-preset fast -async_depth 1 -look_ahead 0 -qmin 14 -qmax 32"
                             : "-hw_encoding 1 -scenario display_remoting -quality 90";
    std::string prof = (encoder == "h264_nvenc")
                           ? (" -profile:v " + std::string(baseline ? "baseline" : "main") + " -level:v " + nv_lvl)
                       : (encoder == "h264_amf")
                           ? (" -profile:v " + std::string(baseline ? "constrained_baseline" : "main") + " -level:v " + num_lvl)
                       : (encoder == "h264_qsv")
                           ? (" -profile:v " + std::string(baseline ? "baseline" : "main") + " -level:v " + num_lvl)
                           : (" -profile:v " + std::string(baseline ? "66" : "77") + " -level:v " + num_lvl);
    std::string tail = framed
                           ? " -bsf:v h264_metadata=aud=insert,setts=ts=N -flush_packets 1 -f avi pipe:1"
                           : " -bsf:v h264_metadata=aud=insert -flush_packets 1 -f h264 pipe:1";
    std::string args = "-hide_banner -loglevel warning -nostats -f rawvideo -pixel_format bgr24 -video_size " +
                       std::to_string(w) + "x" + std::to_string(h) + " -framerate " + std::to_string(fps) +
                       " -i pipe:0 -vf scale=out_color_matrix=bt709,format=nv12 -an -c:v " + encoder + " " +
                       tuning + prof + " -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 -bf 0 -g " +
                       std::to_string(std::max(15, fps * 2)) + " -b:v " + std::to_string(bitrate) +
                       " -maxrate " + std::to_string(bitrate + bitrate / 4) + " -bufsize " + std::to_string(bitrate) +
                       " -fps_mode passthrough" + tail;

    SECURITY_ATTRIBUTES sa{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE stdin_r = nullptr, stdin_w = nullptr;
    HANDLE stdout_r = nullptr, stdout_w = nullptr;
    CreatePipe(&stdin_r, &stdin_w, &sa, 256 * 1024);
    CreatePipe(&stdout_r, &stdout_w, &sa, 65536);
    SetHandleInformation(stdin_w, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(stdout_r, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = stdin_r;
    si.hStdOutput = stdout_w;
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION pi{};
    std::wstring cmdline = L"\"" + executable + L"\" " + Utf8ToWide(args);
    BOOL started = CreateProcessW(executable.c_str(), cmdline.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
    CloseHandle(stdin_r);
    CloseHandle(stdout_w);
    if (!started) {
      CloseHandle(stdin_w);
      CloseHandle(stdout_r);
      continue;
    }
    if (!AssignProcessToJobObject(job, pi.hProcess)) {
      TerminateProcess(pi.hProcess, 1);
      CloseHandle(pi.hThread);
      CloseHandle(pi.hProcess);
      CloseHandle(stdin_w);
      CloseHandle(stdout_r);
      CloseHandle(pipe);
      return false;
    }
    CloseHandle(pi.hThread);

    std::atomic<bool> stop_sec{false};
    std::atomic<int> received{0};
    HANDLE cancel_ev = CreateEventW(nullptr, TRUE, FALSE, nullptr);

    std::thread feeder([&]() {
      if (WriteAllBytes(stdin_w, first_frame.data(), first_frame.size())) {
        std::vector<uint8_t> buf(frame_bytes);
        while (!ended.load() && !stop_sec.load() && PipeReadExact(pipe, buf.data(), frame_bytes, cancel_ev, 5000)) {
          if (!WriteAllBytes(stdin_w, buf.data(), frame_bytes)) break;
        }
      }
      CloseHandle(stdin_w);
    });

    std::thread copier([&]() {
      std::vector<uint8_t> buf(65536);
      DWORD got = 0;
      while (ReadFile(stdout_r, buf.data(), static_cast<DWORD>(buf.size()), &got, nullptr) && got > 0) {
        if (received.exchange(1) == 0) {
          std::cerr << "[video] secure-desktop encoder=" << encoder << " width=" << w << " height=" << h << " fps=" << fps << "\n";
        }
        if (!WriteAllBytes(destination, buf.data(), got)) break;
        FlushFileBuffers(destination);
      }
    });

    while (!ended.load() && WaitForSingleObject(pi.hProcess, 50) == WAIT_TIMEOUT) {
      EnsureSharingEnabled(false);
      if (IsDefaultDesktopActive(false)) {
        stop_sec.store(true);
        break;
      }
    }
    stop_sec.store(true);
    if (cancel_ev) SetEvent(cancel_ev);
    CancelIoEx(pipe, nullptr);
    if (feeder.joinable()) feeder.join();
    if (WaitForSingleObject(pi.hProcess, 1000) == WAIT_TIMEOUT) {
      TerminateProcess(pi.hProcess, 1);
      WaitForSingleObject(pi.hProcess, 1000);
    }
    CloseHandle(pi.hProcess);
    if (copier.joinable()) copier.join();
    CloseHandle(stdout_r);
    if (cancel_ev) CloseHandle(cancel_ev);

    if (ended.load() || IsDefaultDesktopActive(false) || received.load() != 0) {
      CloseHandle(pipe);
      return true;
    }
  }

  CloseHandle(pipe);
  return false;
}

}  // namespace linkshell::helper
