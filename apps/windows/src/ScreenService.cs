using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace LinkShell.Windows {
    // Optional LocalSystem Windows Service for controlling elevated (Administrator) windows
    // and capturing/clicking UAC Secure Desktop (Winlogon) and Lock Screen.
    // Security invariants:
    //  1. Only LinkShell.Screen.exe inside Program Files (Admin/SYSTEM write ACL) runs as SYSTEM.
    //  2. Node.js, Electron, and FFmpeg NEVER run as SYSTEM.
    //  3. The Named Pipe enforces both Windows SID DACL and a 256-bit per-install random token.
    //  4. Only fixed, whitelisted screen/input operations are accepted; zero arbitrary execution.
    internal static partial class ScreenHelper {
        const string ElevatedServiceName = "LinkShellScreenService";
        const string ElevatedServiceDisplayName = "LinkShell Elevated Screen Service";
        const string ElevatedPipeName = "LinkShellScreenServiceV1";

        const uint SC_MANAGER_CONNECT = 0x0001;
        const uint SC_MANAGER_CREATE_SERVICE = 0x0002;
        const uint SC_MANAGER_ALL_ACCESS = 0xF003F;
        const uint SERVICE_QUERY_STATUS = 0x0004;
        const uint SERVICE_START = 0x0010;
        const uint SERVICE_STOP = 0x0020;
        const uint SERVICE_CHANGE_CONFIG = 0x0002;
        const uint SERVICE_ALL_ACCESS = 0xF01FF;
        const uint SERVICE_WIN32_OWN_PROCESS = 0x00000010;
        const uint SERVICE_AUTO_START = 0x00000002;
        const uint SERVICE_ERROR_NORMAL = 0x00000001;
        const uint SERVICE_CONTROL_STOP = 0x00000001;
        const uint SERVICE_STOPPED = 0x00000001;
        const uint SERVICE_RUNNING = 0x00000004;
        const uint SERVICE_NO_CHANGE = 0xFFFFFFFF;

        const uint TOKEN_ALL_ACCESS = 0x000F01FF;
        const uint MAXIMUM_ALLOWED = 0x02000000;
        const int SecurityIdentification = 2;
        const int TokenPrimary = 1;
        const int TokenSessionId = 12;
        const uint CREATE_NO_WINDOW = 0x08000000;
        const uint DESKTOP_ALL_ACCESS = 0x01FF;

        [StructLayout(LayoutKind.Sequential)]
        struct SERVICE_STATUS {
            public uint dwServiceType;
            public uint dwCurrentState;
            public uint dwControlsAccepted;
            public uint dwWin32ExitCode;
            public uint dwServiceSpecificExitCode;
            public uint dwCheckPoint;
            public uint dwWaitHint;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2;
            public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION {
            public IntPtr hProcess, hThread;
            public uint dwProcessId, dwThreadId;
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr OpenSCManager(string machineName, string databaseName, uint desiredAccess);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr OpenService(IntPtr scManager, string serviceName, uint desiredAccess);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateService(
            IntPtr scManager, string serviceName, string displayName, uint desiredAccess,
            uint serviceType, uint startType, uint errorControl, string binaryPathName,
            string loadOrderGroup, IntPtr tagId, string dependencies, string serviceStartName, string password);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool ChangeServiceConfig(
            IntPtr service, uint serviceType, uint startType, uint errorControl,
            string binaryPathName, string loadOrderGroup, IntPtr tagId, string dependencies,
            string serviceStartName, string password, string displayName);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool StartService(IntPtr service, int numServiceArgs, IntPtr serviceArgVectors);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool ControlService(IntPtr service, uint control, out SERVICE_STATUS status);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool DeleteService(IntPtr service);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool QueryServiceStatus(IntPtr service, out SERVICE_STATUS status);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool CloseServiceHandle(IntPtr scObject);

        [DllImport("kernel32.dll")]
        static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("kernel32.dll")]
        static extern IntPtr GetCurrentProcess();
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool DuplicateTokenEx(IntPtr existingToken, uint desiredAccess, IntPtr tokenAttributes, int impersonationLevel, int tokenType, out IntPtr newToken);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool SetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, ref uint tokenInformation, uint tokenInformationLength);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcessAsUser(
            IntPtr token, string applicationName, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
            uint creationFlags, IntPtr environment, string currentDirectory,
            ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

        sealed class ServiceAuthConfig {
            public string Sid;
            public string Token;
            public string Home;
            public string Sha256;
        }

        static string ServiceInstallDir() {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "LinkShell", "ScreenService");
        }

        static string ServiceExePath() {
            return Path.Combine(ServiceInstallDir(), "LinkShell.Screen.exe");
        }

        static string ServiceDataDir() {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "LinkShell", "ScreenService");
        }

        static string ServiceAuthPath() {
            return Path.Combine(ServiceDataDir(), "auth.json");
        }

        static string UserHomeDir() {
            return Environment.GetEnvironmentVariable("LINKSHELL_HOME") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".linkshell");
        }

        static string UserServiceTokenPath(string home) {
            return Path.Combine(home, "windows-service-token");
        }

        static string UserServiceErrorPath(string home) {
            return Path.Combine(home, "windows-service-last-error.txt");
        }

        static void ClearServiceLastError(string home) {
            try {
                if (String.IsNullOrEmpty(home)) return;
                string path = UserServiceErrorPath(home);
                if (File.Exists(path)) File.Delete(path);
            } catch { }
        }

        static void WriteServiceLastError(string home, string message) {
            try {
                if (String.IsNullOrEmpty(home) || String.IsNullOrEmpty(message)) return;
                Directory.CreateDirectory(home);
                File.WriteAllText(UserServiceErrorPath(home), message, new UTF8Encoding(false));
            } catch { }
        }

        static void LogServiceEvent(string message) {
            try {
                string path = Path.Combine(ServiceDataDir(), "service.log");
                if (File.Exists(path) && new FileInfo(path).Length > 65536) File.WriteAllText(path, "", new UTF8Encoding(false));
                File.AppendAllText(path, DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture) + " " + message + "\r\n", new UTF8Encoding(false));
            } catch { }
        }

        static string CurrentExePath() {
            return Process.GetCurrentProcess().MainModule.FileName;
        }

        static string FileSha256Hex(string path) {
            if (!File.Exists(path)) return "";
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(path)) {
                byte[] hash = sha.ComputeHash(stream);
                var sb = new StringBuilder(hash.Length * 2);
                for (int i = 0; i < hash.Length; i++) sb.Append(hash[i].ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
        }

        static string GenerateRandomHex(int numBytes) {
            byte[] data = new byte[numBytes];
            using (var rng = new RNGCryptoServiceProvider()) rng.GetBytes(data);
            var sb = new StringBuilder(numBytes * 2);
            for (int i = 0; i < data.Length; i++) sb.Append(data[i].ToString("x2", CultureInfo.InvariantCulture));
            return sb.ToString();
        }

        static bool ConstantTimeEquals(string a, string b) {
            if (a == null || b == null || a.Length != b.Length || a.Length == 0) return false;
            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }

        static void ApplyServiceBinaryDirectoryAcl(string dir) {
            var sec = new DirectorySecurity();
            sec.SetAccessRuleProtection(true, false);
            var systemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            var adminsSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            var usersSid = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
            sec.AddAccessRule(new FileSystemAccessRule(systemSid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            sec.AddAccessRule(new FileSystemAccessRule(adminsSid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            // Users may read/hash the service binary to verify up-to-date status, but can never modify it.
            sec.AddAccessRule(new FileSystemAccessRule(usersSid, FileSystemRights.ReadAndExecute, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(dir, sec);
        }

        static void ApplyAdminOnlyDirectoryAcl(string dir) {
            var sec = new DirectorySecurity();
            sec.SetAccessRuleProtection(true, false);
            var systemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            var adminsSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            sec.AddAccessRule(new FileSystemAccessRule(systemSid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            sec.AddAccessRule(new FileSystemAccessRule(adminsSid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(dir, sec);
        }

        static void ApplyUserTokenFileAcl(string filePath, string userSid) {
            var sec = new FileSecurity();
            sec.SetAccessRuleProtection(true, false);
            var systemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            var adminsSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            sec.AddAccessRule(new FileSystemAccessRule(systemSid, FileSystemRights.FullControl, AccessControlType.Allow));
            sec.AddAccessRule(new FileSystemAccessRule(adminsSid, FileSystemRights.FullControl, AccessControlType.Allow));
            if (!String.IsNullOrEmpty(userSid)) {
                sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(userSid), FileSystemRights.FullControl, AccessControlType.Allow));
            }
            File.SetAccessControl(filePath, sec);
        }

        static bool IsRunningAsAdministrator() {
            using (var identity = WindowsIdentity.GetCurrent()) {
                return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
            }
        }

        static bool QueryElevatedServiceState(out bool installed, out bool running) {
            installed = false;
            running = false;
            IntPtr scm = OpenSCManager(null, null, SC_MANAGER_CONNECT);
            if (scm == IntPtr.Zero) return false;
            try {
                IntPtr svc = OpenService(scm, ElevatedServiceName, SERVICE_QUERY_STATUS);
                if (svc == IntPtr.Zero) return true;
                installed = true;
                try {
                    SERVICE_STATUS status;
                    if (QueryServiceStatus(svc, out status)) {
                        running = status.dwCurrentState == SERVICE_RUNNING;
                    }
                } finally { CloseServiceHandle(svc); }
                return true;
            } finally { CloseServiceHandle(scm); }
        }

        static string ReadUserServiceToken() {
            try {
                string path = UserServiceTokenPath(UserHomeDir());
                if (!File.Exists(path)) return null;
                string token = File.ReadAllText(path, Encoding.UTF8).Trim();
                return token.Length == 64 ? token : null;
            } catch {
                return null;
            }
        }

        static bool IsElevatedServiceAvailable() {
            if (dryRun) return false;
            bool installed, running;
            if (!QueryElevatedServiceState(out installed, out running) || !installed || !running) return false;
            return ReadUserServiceToken() != null;
        }

        static void PrintElevatedServiceStatus() {
            bool installed, running;
            QueryElevatedServiceState(out installed, out running);
            bool authorized = ReadUserServiceToken() != null;
            bool outdated = false;
            if (installed) {
                try {
                    string svcExe = ServiceExePath();
                    if (!File.Exists(svcExe)) outdated = true;
                    else {
                        string installedHash = FileSha256Hex(svcExe);
                        string currentHash = FileSha256Hex(CurrentExePath());
                        outdated = !String.IsNullOrEmpty(installedHash) && !String.IsNullOrEmpty(currentHash)
                            && !String.Equals(installedHash, currentHash, StringComparison.OrdinalIgnoreCase);
                    }
                } catch {
                    outdated = false;
                }
            }
            Write(new { installed = installed, running = running, authorized = authorized, outdated = outdated });
        }

        static void StopServiceIfRunning(IntPtr svc) {
            SERVICE_STATUS status;
            if (!QueryServiceStatus(svc, out status) || status.dwCurrentState == SERVICE_STOPPED) return;
            ControlService(svc, SERVICE_CONTROL_STOP, out status);
            var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < 10000) {
                if (QueryServiceStatus(svc, out status) && status.dwCurrentState == SERVICE_STOPPED) return;
                Thread.Sleep(150);
            }
        }

        static void InstallElevatedService(string userSid, string userHome) {
            if (!IsRunningAsAdministrator()) throw new InvalidOperationException("安装系统控制服务需要管理员权限");
            if (String.IsNullOrWhiteSpace(userSid)) throw new ArgumentException("缺少用户 SID");
            new SecurityIdentifier(userSid);
            string home = String.IsNullOrWhiteSpace(userHome) ? UserHomeDir() : userHome;
            if (!Path.IsPathRooted(home)) throw new ArgumentException("无效的 LinkShell 数据目录");

            string installDir = ServiceInstallDir();
            string targetExe = ServiceExePath();
            string dataDir = ServiceDataDir();
            string sourceExe = CurrentExePath();

            IntPtr scm = OpenSCManager(null, null, SC_MANAGER_ALL_ACCESS);
            if (scm == IntPtr.Zero) throw new InvalidOperationException("无法打开 Windows 服务管理器：" + Marshal.GetLastWin32Error());
            try {
                IntPtr existing = OpenService(scm, ElevatedServiceName, SERVICE_ALL_ACCESS);
                if (existing != IntPtr.Zero) {
                    try { StopServiceIfRunning(existing); }
                    finally { CloseServiceHandle(existing); }
                }

                Directory.CreateDirectory(installDir);
                ApplyServiceBinaryDirectoryAcl(installDir);
                if (!String.Equals(Path.GetFullPath(sourceExe), Path.GetFullPath(targetExe), StringComparison.OrdinalIgnoreCase)) {
                    for (int attempt = 0; attempt < 10; attempt++) {
                        try { File.Copy(sourceExe, targetExe, true); break; }
                        catch (IOException) { if (attempt == 9) throw; Thread.Sleep(200); }
                    }
                }

                Directory.CreateDirectory(dataDir);
                ApplyAdminOnlyDirectoryAcl(dataDir);

                string token = GenerateRandomHex(32);
                string exeHash = FileSha256Hex(targetExe);
                var authPayload = new Dictionary<string, object> {
                    { "sid", userSid },
                    { "token", token },
                    { "home", home },
                    { "sha256", exeHash },
                };
                File.WriteAllText(ServiceAuthPath(), Json.Serialize(authPayload), new UTF8Encoding(false));

                Directory.CreateDirectory(home);
                string tokenPath = UserServiceTokenPath(home);
                File.WriteAllText(tokenPath, token, new UTF8Encoding(false));
                ApplyUserTokenFileAcl(tokenPath, userSid);

                string binPath = "\"" + targetExe + "\" --service";
                IntPtr svc = OpenService(scm, ElevatedServiceName, SERVICE_ALL_ACCESS);
                if (svc == IntPtr.Zero) {
                    svc = CreateService(
                        scm, ElevatedServiceName, ElevatedServiceDisplayName, SERVICE_ALL_ACCESS,
                        SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL,
                        binPath, null, IntPtr.Zero, null, null, null);
                    if (svc == IntPtr.Zero) throw new InvalidOperationException("注册系统控制服务失败：" + Marshal.GetLastWin32Error());
                } else {
                    if (!ChangeServiceConfig(svc, SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL, binPath, null, IntPtr.Zero, null, null, null, ElevatedServiceDisplayName)) {
                        int err = Marshal.GetLastWin32Error();
                        CloseServiceHandle(svc);
                        throw new InvalidOperationException("更新系统控制服务配置失败：" + err);
                    }
                }
                try {
                    if (!StartService(svc, 0, IntPtr.Zero)) {
                        int err = Marshal.GetLastWin32Error();
                        if (err != 1056) throw new InvalidOperationException("启动系统控制服务失败：" + err);
                    }
                    var clock = Stopwatch.StartNew();
                    bool started = false;
                    while (clock.ElapsedMilliseconds < 10000) {
                        SERVICE_STATUS st;
                        if (QueryServiceStatus(svc, out st) && st.dwCurrentState == SERVICE_RUNNING) { started = true; break; }
                        Thread.Sleep(150);
                    }
                    if (!started) throw new InvalidOperationException("系统控制服务启动超时");
                } finally { CloseServiceHandle(svc); }
            } finally { CloseServiceHandle(scm); }
        }

        static void UninstallElevatedService(string userHome) {
            if (!IsRunningAsAdministrator()) throw new InvalidOperationException("卸载系统控制服务需要管理员权限");
            IntPtr scm = OpenSCManager(null, null, SC_MANAGER_ALL_ACCESS);
            if (scm == IntPtr.Zero) throw new InvalidOperationException("无法打开 Windows 服务管理器：" + Marshal.GetLastWin32Error());
            try {
                IntPtr svc = OpenService(scm, ElevatedServiceName, SERVICE_ALL_ACCESS);
                if (svc != IntPtr.Zero) {
                    try {
                        StopServiceIfRunning(svc);
                        DeleteService(svc);
                    } finally { CloseServiceHandle(svc); }
                }
            } finally { CloseServiceHandle(scm); }

            string home = String.IsNullOrWhiteSpace(userHome) ? UserHomeDir() : userHome;
            try {
                string tokenPath = UserServiceTokenPath(home);
                if (File.Exists(tokenPath)) File.Delete(tokenPath);
            } catch { }
            try {
                if (Directory.Exists(ServiceDataDir())) Directory.Delete(ServiceDataDir(), true);
            } catch { }
            try {
                string installDir = ServiceInstallDir();
                string currentExe = Path.GetFullPath(CurrentExePath());
                if (Directory.Exists(installDir) && !currentExe.StartsWith(Path.GetFullPath(installDir), StringComparison.OrdinalIgnoreCase)) {
                    Directory.Delete(installDir, true);
                }
            } catch { }
        }

        static ServiceAuthConfig LoadServiceAuthConfig() {
            string path = ServiceAuthPath();
            if (!File.Exists(path)) return null;
            var raw = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
            if (raw == null) return null;
            var cfg = new ServiceAuthConfig {
                Sid = Str(raw, "sid"),
                Token = Str(raw, "token"),
                Home = Str(raw, "home"),
                Sha256 = Str(raw, "sha256"),
            };
            if (String.IsNullOrEmpty(cfg.Sid) || String.IsNullOrEmpty(cfg.Token) || String.IsNullOrEmpty(cfg.Home)) return null;
            return cfg;
        }

        static bool IsServiceSharingEnabled(string home) {
            if (String.IsNullOrEmpty(home)) return false;
            return !File.Exists(Path.Combine(home, "windows-screen-disabled"));
        }

        sealed class ElevatedScreenWindowsService : ServiceBase {
            Thread serverThread;
            volatile bool stopping;
            int activeClients;

            public ElevatedScreenWindowsService() {
                ServiceName = ElevatedServiceName;
                CanStop = true;
                CanShutdown = true;
            }

            protected override void OnStart(string[] args) {
                LogServiceEvent("service starting");
                stopping = false;
                serverThread = new Thread(AcceptLoop) { IsBackground = true };
                serverThread.Start();
            }

            protected override void OnStop() {
                LogServiceEvent("service stopping");
                stopping = true;
                try {
                    using (var wake = new NamedPipeClientStream(".", ElevatedPipeName, PipeDirection.InOut)) {
                        wake.Connect(200);
                    }
                } catch { }
                if (serverThread != null && serverThread.IsAlive) serverThread.Join(3000);
            }

            protected override void OnShutdown() {
                OnStop();
            }

            void AcceptLoop() {
                while (!stopping) {
                    var auth = LoadServiceAuthConfig();
                    if (auth == null) {
                        Thread.Sleep(1000);
                        continue;
                    }
                    PipeSecurity pipeSec = BuildClientPipeSecurity(auth.Sid);
                    NamedPipeServerStream clientPipe = null;
                    try {
                        clientPipe = new NamedPipeServerStream(
                            ElevatedPipeName, PipeDirection.InOut, 8,
                            PipeTransmissionMode.Byte, PipeOptions.Asynchronous,
                            65536, 65536, pipeSec);
                        clientPipe.WaitForConnection();
                        if (stopping) {
                            clientPipe.Dispose();
                            break;
                        }
                        if (Interlocked.Increment(ref activeClients) > 8) {
                            Interlocked.Decrement(ref activeClients);
                            clientPipe.Dispose();
                            continue;
                        }
                        var accepted = clientPipe;
                        clientPipe = null;
                        ThreadPool.QueueUserWorkItem(_ => {
                            try { HandleClient(accepted); }
                            catch { }
                            finally {
                                try { accepted.Dispose(); } catch { }
                                Interlocked.Decrement(ref activeClients);
                            }
                        });
                    } catch {
                        if (clientPipe != null) { try { clientPipe.Dispose(); } catch { } }
                        if (!stopping) Thread.Sleep(250);
                    }
                }
            }

            static PipeSecurity BuildClientPipeSecurity(string userSid) {
                var ps = new PipeSecurity();
                ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
                ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
                ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(userSid), PipeAccessRights.ReadWrite, AccessControlType.Allow));
                return ps;
            }

            static PipeSecurity BuildSystemOnlyPipeSecurity() {
                var ps = new PipeSecurity();
                ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
                return ps;
            }

            static string ReadHandshakeLine(Stream stream, int maxBytes) {
                var buf = new List<byte>(256);
                while (buf.Count < maxBytes) {
                    int b = stream.ReadByte();
                    if (b < 0) return null;
                    if (b == '\n') break;
                    if (b != '\r') buf.Add((byte)b);
                }
                return Encoding.UTF8.GetString(buf.ToArray());
            }

            void HandleClient(NamedPipeServerStream clientPipe) {
                var auth = LoadServiceAuthConfig();
                if (auth == null || !IsServiceSharingEnabled(auth.Home)) return;

                string handshakeLine = ReadHandshakeLine(clientPipe, 2048);
                if (String.IsNullOrEmpty(handshakeLine)) return;
                Dictionary<string, object> req;
                try { req = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(handshakeLine); }
                catch { return; }
                if (req == null) return;
                if (!ConstantTimeEquals(Str(req, "token"), auth.Token)) return;

                string mode = Str(req, "mode");
                if (mode != "displays" && mode != "control" && mode != "capture-raw" && mode != "capture-jpeg") return;
                int screen = Math.Max(0, Math.Min(15, (int)Number(req, "screen")));
                int w = Math.Max(320, Math.Min(3840, (int)Number(req, "w")));
                int h = Math.Max(180, Math.Min(2160, (int)Number(req, "h")));
                int fps = Math.Max(1, Math.Min(30, (int)Number(req, "fps")));
                int quality = Math.Max(35, Math.Min(92, (int)Number(req, "quality")));

                uint sessionId = WTSGetActiveConsoleSessionId();
                if (sessionId == 0xFFFFFFFF) return;

                string workerPipeName = "LinkShellScreenWorker-" + GenerateRandomHex(16);
                IntPtr job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) return;
                try {
                    var limits = new JobLimits { Basic = new BasicLimits { Flags = 0x2000 } };
                    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits)))) return;

                    using (var workerPipe = new NamedPipeServerStream(
                        workerPipeName, PipeDirection.InOut, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous,
                        256 * 1024, 256 * 1024, BuildSystemOnlyPipeSecurity())) {
                        string selfExe = ServiceExePath();
                        if (!File.Exists(selfExe)) return;
                        string homeB64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(auth.Home));
                        string workerArgs = String.Format(
                            CultureInfo.InvariantCulture,
                            "--service-worker {0} {1} {2} {3} {4} {5} {6} {7}",
                            workerPipeName, mode, screen, w, h, fps, quality, homeB64);

                        IntPtr procHandle = LaunchSessionSystemProcess(selfExe, workerArgs, sessionId);
                        if (procHandle == IntPtr.Zero) return;
                        try {
                            if (!AssignProcessToJobObject(job, procHandle)) return;
                            var connectAsync = workerPipe.BeginWaitForConnection(null, null);
                            if (!connectAsync.AsyncWaitHandle.WaitOne(5000)) return;
                            workerPipe.EndWaitForConnection(connectAsync);

                            BridgeStreams(clientPipe, workerPipe);
                        } finally {
                            CloseHandle(procHandle);
                        }
                    }
                } finally {
                    CloseHandle(job);
                }
            }

            static IntPtr LaunchSessionSystemProcess(string exePath, string arguments, uint sessionId) {
                IntPtr procToken = IntPtr.Zero;
                IntPtr dupToken = IntPtr.Zero;
                try {
                    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, out procToken)) return IntPtr.Zero;
                    if (!DuplicateTokenEx(procToken, MAXIMUM_ALLOWED, IntPtr.Zero, SecurityIdentification, TokenPrimary, out dupToken)) return IntPtr.Zero;
                    if (!SetTokenInformation(dupToken, TokenSessionId, ref sessionId, 4)) return IntPtr.Zero;

                    var si = new STARTUPINFO();
                    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                    si.lpDesktop = "winsta0\\default";
                    var cmd = new StringBuilder("\"" + exePath + "\" " + arguments);
                    PROCESS_INFORMATION pi;
                    if (!CreateProcessAsUser(dupToken, exePath, cmd, IntPtr.Zero, IntPtr.Zero, false, CREATE_NO_WINDOW, IntPtr.Zero, Path.GetDirectoryName(exePath), ref si, out pi)) {
                        return IntPtr.Zero;
                    }
                    CloseHandle(pi.hThread);
                    return pi.hProcess;
                } finally {
                    if (dupToken != IntPtr.Zero) CloseHandle(dupToken);
                    if (procToken != IntPtr.Zero) CloseHandle(procToken);
                }
            }

            static void BridgeStreams(Stream a, Stream b) {
                var t1 = Task.Run(() => {
                    var buf = new byte[65536];
                    try {
                        int n;
                        while ((n = a.Read(buf, 0, buf.Length)) > 0) {
                            b.Write(buf, 0, n);
                            b.Flush();
                        }
                    } catch { }
                    finally { try { b.Dispose(); } catch { } }
                });
                var t2 = Task.Run(() => {
                    var buf = new byte[65536];
                    try {
                        int n;
                        while ((n = b.Read(buf, 0, buf.Length)) > 0) {
                            a.Write(buf, 0, n);
                            a.Flush();
                        }
                    } catch { }
                    finally { try { a.Dispose(); } catch { } }
                });
                Task.WaitAny(t1, t2);
                try { a.Dispose(); } catch { }
                try { b.Dispose(); } catch { }
                try { Task.WaitAll(new[] { t1, t2 }, 1500); } catch { }
            }
        }

        static void RunElevatedWindowsService() {
            ServiceBase.Run(new ElevatedScreenWindowsService());
        }

        static bool ServiceAttachActiveDesktop(ref IntPtr currentDesktop, ref string currentName) {
            IntPtr hInput = OpenInputDesktop(0, false, DESKTOP_ALL_ACCESS);
            if (hInput == IntPtr.Zero) return false;
            string name = DesktopName(hInput);
            if (currentDesktop != IntPtr.Zero && String.Equals(name, currentName, StringComparison.OrdinalIgnoreCase)) {
                CloseDesktop(hInput);
                return true;
            }
            if (!SetThreadDesktop(hInput)) {
                CloseDesktop(hInput);
                return false;
            }
            if (currentDesktop != IntPtr.Zero) CloseDesktop(currentDesktop);
            currentDesktop = hInput;
            currentName = name;
            return true;
        }

        static void RunElevatedServiceWorker(string pipeName, string mode, int screen, int w, int h, int fps, int quality, string homeB64) {
            string home = "";
            try { home = Encoding.UTF8.GetString(Convert.FromBase64String(homeB64)); } catch { return; }
            if (!IsServiceSharingEnabled(home)) return;

            Exception workerError = null;
            // Run on a clean MTA thread with zero WinForms/COM windows so SetThreadDesktop can switch freely
            // between Default and Winlogon (UAC / Lock Screen) on every tick.
            var workerThread = new Thread(() => {
                IntPtr hDesk = IntPtr.Zero;
                string deskName = "";
                try {
                    using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous)) {
                        pipe.Connect(5000);
                        if (mode == "displays") {
                            ServiceAttachActiveDesktop(ref hDesk, ref deskName);
                            var json = Json.Serialize(EnumerateDisplays().Select((s, i) => new {
                                screen = i, name = s.Primary ? "主屏幕" : "屏幕 " + (i + 1),
                                w = s.Bounds.Width, h = s.Bounds.Height, main = s.Primary,
                            }).ToArray());
                            byte[] data = Encoding.UTF8.GetBytes(json + "\n");
                            pipe.Write(data, 0, data.Length);
                            pipe.Flush();
                        } else if (mode == "control") {
                            RunServiceControlWorker(pipe, screen, home, ref hDesk, ref deskName);
                        } else if (mode == "capture-raw") {
                            RunServiceCaptureRawWorker(pipe, screen, w, h, fps, home, ref hDesk, ref deskName);
                        } else if (mode == "capture-jpeg") {
                            RunServiceCaptureJpegWorker(pipe, screen, w, fps, quality, home, ref hDesk, ref deskName);
                        }
                    }
                } catch (Exception ex) {
                    workerError = ex;
                } finally {
                    Release();
                    if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
                }
            });
            workerThread.SetApartmentState(ApartmentState.MTA);
            workerThread.Start();
            workerThread.Join();
            if (workerError != null) Console.Error.WriteLine("[service-worker] " + workerError.Message);
        }

        static Rectangle ServiceDisplayBounds(int screen) {
            var all = EnumerateDisplays();
            if (all.Length == 0) return new Rectangle(0, 0, Math.Max(640, GetSystemMetrics(0)), Math.Max(480, GetSystemMetrics(1)));
            if (screen < 0 || screen >= all.Length) screen = 0;
            return all[screen].Bounds;
        }

        static void WritePipeJson(Stream pipe, object pipeLock, object value) {
            byte[] line = Encoding.UTF8.GetBytes(Json.Serialize(value) + "\n");
            lock (pipeLock) {
                pipe.Write(line, 0, line.Length);
                pipe.Flush();
            }
        }

        static void RunServiceControlWorker(NamedPipeClientStream pipe, int screen, string home, ref IntPtr hDesk, ref string deskName) {
            ServiceAttachActiveDesktop(ref hDesk, ref deskName);
            bounds = ServiceDisplayBounds(screen);
            var pipeLock = new object();
            WritePipeJson(pipe, pipeLock, new { t = "ready", trusted = true, app = "LinkShell" });

            var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true);
            var next = Task.Run(() => {
                try { return reader.ReadLine(); }
                catch { return null; }
            });
            POINT last = new POINT { X = Int32.MinValue, Y = Int32.MinValue };
            string prevDesk = deskName;
            for (;;) {
                if (!IsServiceSharingEnabled(home)) return;
                ServiceAttachActiveDesktop(ref hDesk, ref deskName);
                if (!String.Equals(prevDesk, deskName, StringComparison.OrdinalIgnoreCase)) {
                    Release();
                    prevDesk = deskName;
                }
                bounds = ServiceDisplayBounds(screen);
                POINT p;
                if (GetCursorPos(out p) && (p.X != last.X || p.Y != last.Y)) {
                    WritePipeJson(pipe, pipeLock, new {
                        t = "cursor",
                        x = Math.Max(0, Math.Min(1, (p.X - bounds.Left) / (double)Math.Max(1, bounds.Width))),
                        y = Math.Max(0, Math.Min(1, (p.Y - bounds.Top) / (double)Math.Max(1, bounds.Height))),
                    });
                    last = p;
                }
                if (!next.Wait(16)) continue;
                var line = next.Result;
                if (line == null) return;
                next = Task.Run(() => {
                    try { return reader.ReadLine(); }
                    catch { return null; }
                });
                if (line.Length > 32000) continue;
                Dictionary<string, object> e;
                try { e = Json.Deserialize<Dictionary<string, object>>(line); }
                catch { continue; }
                if (e == null) continue;
                try {
                    Handle(e);
                } catch {
                    Release();
                }
            }
        }

        static void RunServiceCaptureRawWorker(NamedPipeClientStream pipe, int screen, int w, int h, int fps, string home, ref IntPtr hDesk, ref string deskName) {
            w = Math.Max(2, w / 2 * 2);
            h = Math.Max(2, h / 2 * 2);
            int rowBytes = w * 3;
            byte[] packed = new byte[rowBytes * h];
            IntPtr screenDC = IntPtr.Zero;
            string dcDesk = "";
            var clock = Stopwatch.StartNew();
            int intervalMs = Math.Max(33, (int)Math.Ceiling(1000.0 / Math.Max(1, Math.Min(30, fps))));
            try {
                using (var scaled = new Bitmap(w, h, PixelFormat.Format24bppRgb))
                using (var target = Graphics.FromImage(scaled)) {
                    while (pipe.IsConnected && IsServiceSharingEnabled(home)) {
                        long began = clock.ElapsedMilliseconds;
                        ServiceAttachActiveDesktop(ref hDesk, ref deskName);
                        if (screenDC == IntPtr.Zero || !String.Equals(dcDesk, deskName, StringComparison.OrdinalIgnoreCase)) {
                            if (screenDC != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screenDC);
                            screenDC = GetDC(IntPtr.Zero);
                            dcDesk = deskName;
                        }
                        if (screenDC == IntPtr.Zero) { Thread.Sleep(100); continue; }
                        var b = ServiceDisplayBounds(screen);
                        bool ok = false;
                        var dc = target.GetHdc();
                        try {
                            SetStretchBltMode(dc, 4);
                            SetBrushOrgEx(dc, 0, 0, IntPtr.Zero);
                            ok = StretchBlt(dc, 0, 0, w, h, screenDC, b.Left, b.Top, b.Width, b.Height, 0x40cc0020);
                        } finally { target.ReleaseHdc(dc); }
                        if (!ok) {
                            if (screenDC != IntPtr.Zero) { ReleaseDC(IntPtr.Zero, screenDC); screenDC = IntPtr.Zero; }
                            Thread.Sleep(50);
                            continue;
                        }
                        var locked = scaled.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                        try {
                            int stride = Math.Abs(locked.Stride);
                            if (stride == rowBytes) {
                                Marshal.Copy(locked.Scan0, packed, 0, packed.Length);
                            } else {
                                IntPtr ptr = locked.Scan0;
                                for (int y = 0; y < h; y++) {
                                    Marshal.Copy(new IntPtr(ptr.ToInt64() + (long)y * stride), packed, y * rowBytes, rowBytes);
                                }
                            }
                        } finally { scaled.UnlockBits(locked); }
                        pipe.Write(packed, 0, packed.Length);
                        pipe.Flush();
                        int wait = intervalMs - (int)(clock.ElapsedMilliseconds - began);
                        if (wait > 0) Thread.Sleep(wait);
                    }
                }
            } finally {
                if (screenDC != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screenDC);
            }
        }

        static void RunServiceCaptureJpegWorker(NamedPipeClientStream pipe, int screen, int width, int fps, int quality, string home, ref IntPtr hDesk, ref string deskName) {
            var codec = ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg");
            IntPtr screenDC = IntPtr.Zero;
            string dcDesk = "";
            var clock = Stopwatch.StartNew();
            int intervalMs = Math.Max(33, (int)Math.Ceiling(1000.0 / Math.Max(1, Math.Min(30, fps))));
            try {
                ServiceAttachActiveDesktop(ref hDesk, ref deskName);
                var initial = ServiceDisplayBounds(screen);
                int w = Math.Max(2, Math.Min(width, initial.Width));
                int h = Math.Max(2, (int)((long)initial.Height * w / Math.Max(1, initial.Width)));
                using (var scaled = new Bitmap(w, h, PixelFormat.Format24bppRgb))
                using (var target = Graphics.FromImage(scaled))
                using (var frame = new MemoryStream(256 * 1024)) {
                    while (pipe.IsConnected && IsServiceSharingEnabled(home)) {
                        long began = clock.ElapsedMilliseconds;
                        ServiceAttachActiveDesktop(ref hDesk, ref deskName);
                        if (screenDC == IntPtr.Zero || !String.Equals(dcDesk, deskName, StringComparison.OrdinalIgnoreCase)) {
                            if (screenDC != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screenDC);
                            screenDC = GetDC(IntPtr.Zero);
                            dcDesk = deskName;
                        }
                        if (screenDC == IntPtr.Zero) { Thread.Sleep(100); continue; }
                        var b = ServiceDisplayBounds(screen);
                        bool ok = false;
                        var dc = target.GetHdc();
                        try {
                            SetStretchBltMode(dc, 4);
                            SetBrushOrgEx(dc, 0, 0, IntPtr.Zero);
                            ok = StretchBlt(dc, 0, 0, w, h, screenDC, b.Left, b.Top, b.Width, b.Height, 0x40cc0020);
                        } finally { target.ReleaseHdc(dc); }
                        if (!ok) {
                            if (screenDC != IntPtr.Zero) { ReleaseDC(IntPtr.Zero, screenDC); screenDC = IntPtr.Zero; }
                            Thread.Sleep(50);
                            continue;
                        }
                        frame.SetLength(0);
                        using (var parameters = new EncoderParameters(1)) {
                            parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                            scaled.Save(frame, codec, parameters);
                        }
                        byte[] lenBytes = BitConverter.GetBytes(checked((int)frame.Length));
                        pipe.Write(lenBytes, 0, lenBytes.Length);
                        frame.Position = 0;
                        frame.CopyTo(pipe);
                        pipe.Flush();
                        int wait = intervalMs - (int)(clock.ElapsedMilliseconds - began);
                        if (wait > 0) Thread.Sleep(wait);
                    }
                }
            } finally {
                if (screenDC != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screenDC);
            }
        }

        // ── Unprivileged Client Helpers (transparently connect to LinkShellScreenService when installed) ──

        static NamedPipeClientStream ConnectElevatedServicePipe(string mode, int screen, int w, int h, int fps, int quality) {
            string token = ReadUserServiceToken();
            if (token == null) return null;
            bool installed, running;
            if (!QueryElevatedServiceState(out installed, out running) || !installed || !running) return null;
            var pipe = new NamedPipeClientStream(".", ElevatedPipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            try {
                pipe.Connect(1500);
                var handshake = Json.Serialize(new {
                    token = token, mode = mode, screen = screen, w = w, h = h, fps = fps, quality = quality,
                }) + "\n";
                byte[] bytes = Encoding.UTF8.GetBytes(handshake);
                pipe.Write(bytes, 0, bytes.Length);
                pipe.Flush();
                return pipe;
            } catch {
                try { pipe.Dispose(); } catch { }
                return null;
            }
        }

        static bool TryServiceDisplaysJson(out string json) {
            json = null;
            using (var pipe = ConnectElevatedServicePipe("displays", 0, 640, 480, 1, 75)) {
                if (pipe == null) return false;
                try {
                    using (var reader = new StreamReader(pipe, new UTF8Encoding(false))) {
                        string line = reader.ReadLine();
                        if (!String.IsNullOrEmpty(line) && line.StartsWith("[")) {
                            json = line;
                            return true;
                        }
                    }
                } catch { }
            }
            return false;
        }

        static bool TryServiceDisplayBounds(int screen, out Rectangle rect) {
            rect = Rectangle.Empty;
            string json;
            if (!TryServiceDisplaysJson(out json)) return false;
            try {
                var list = Json.Deserialize<List<Dictionary<string, object>>>(json);
                if (list == null || list.Count == 0) return false;
                int idx = screen >= 0 && screen < list.Count ? screen : 0;
                var item = list[idx];
                rect = new Rectangle(0, 0, Math.Max(2, (int)Number(item, "w")), Math.Max(2, (int)Number(item, "h")));
                return true;
            } catch {
                return false;
            }
        }

        static bool TryRunElevatedControl(int screen) {
            if (dryRun) return false;
            var pipe = ConnectElevatedServicePipe("control", screen, 640, 480, 1, 75);
            if (pipe == null) return false;
            try {
                using (pipe) {
                    var pipeReader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true);
                    string firstLine = pipeReader.ReadLine();
                    if (String.IsNullOrEmpty(firstLine) || firstLine.IndexOf("\"ready\"", StringComparison.Ordinal) < 0) return false;
                    lock (OutputLock) { Console.Out.WriteLine(firstLine); Console.Out.Flush(); }

                    var stdinDone = new ManualResetEventSlim(false);
                    var writer = new Thread(() => {
                        try {
                            string line;
                            while ((line = Console.ReadLine()) != null) {
                                EnsureSharingEnabled();
                                if (line.Length > 32000) continue;
                                byte[] data = Encoding.UTF8.GetBytes(line + "\n");
                                pipe.Write(data, 0, data.Length);
                                pipe.Flush();
                            }
                        } catch { }
                        finally {
                            stdinDone.Set();
                            try { pipe.Dispose(); } catch { }
                        }
                    }) { IsBackground = true };
                    writer.Start();

                    string outLine;
                    while ((outLine = pipeReader.ReadLine()) != null) {
                        EnsureSharingEnabled();
                        lock (OutputLock) { Console.Out.WriteLine(outLine); Console.Out.Flush(); }
                    }
                    // If stdin closed cleanly, we are done; otherwise service stopped mid-session so caller may recover.
                    return stdinDone.IsSet;
                }
            } catch {
                return false;
            }
        }

        static bool TryStreamSecureDesktopVideo(IntPtr job, Stream destination, string executable, int screen, int w, int h, int fps, int bitrate, string preferredEncoder, bool framed) {
            var pipe = ConnectElevatedServicePipe("capture-raw", screen, w, h, fps, 75);
            if (pipe == null) return false;
            try {
                using (pipe) {
                    string[] encoders = preferredEncoder == "h264_mf" ? new[] { "h264_mf" } : new[] { preferredEncoder, "h264_mf" };
                    int frameBytes = w * h * 3;
                    byte[] firstFrame = new byte[frameBytes];
                    if (!ReadExactBytes(pipe, firstFrame, frameBytes)) return false;

                    foreach (string encoder in encoders) {
                        if (ended) return true;
                        bool baseline = String.Equals(Environment.GetEnvironmentVariable("LINKSHELL_WINDOWS_PROFILE"), "baseline", StringComparison.OrdinalIgnoreCase);
                        bool level52 = w * h > 3686400;
                        bool level51 = w * h > 2088960;
                        string nvLevel = level52 ? "5.2" : level51 ? "5.1" : "4.2";
                        string numLevel = level52 ? "52" : level51 ? "51" : "42";
                        string tuning = encoder == "h264_amf" ? "-usage lowlatency -quality quality -rc vbr_latency -qp_i 18 -qp_p 20 -min_qp_i 14 -max_qp_i 32 -min_qp_p 14 -max_qp_p 34 -async_depth 1 -preanalysis 0" :
                            encoder == "h264_nvenc" ? "-preset p4 -tune ll -rc vbr -cq 19 -qmin 14 -qmax 32 -zerolatency 1 -delay 0 -rc-lookahead 0 -spatial-aq 1 -aq-strength 10" :
                            encoder == "h264_qsv" ? "-preset fast -async_depth 1 -look_ahead 0 -qmin 14 -qmax 32" : "-hw_encoding 1 -scenario display_remoting -quality 90";
                        string profileOption = encoder == "h264_nvenc"
                            ? " -profile:v " + (baseline ? "baseline" : "main") + " -level:v " + nvLevel
                            : encoder == "h264_amf"
                                ? " -profile:v " + (baseline ? "constrained_baseline" : "main") + " -level:v " + numLevel
                                : encoder == "h264_qsv"
                                    ? " -profile:v " + (baseline ? "baseline" : "main") + " -level:v " + numLevel
                                    : " -profile:v " + (baseline ? "66" : "77") + " -level:v " + numLevel;
                        string args = "-hide_banner -loglevel warning -nostats -f rawvideo -pixel_format bgr24 -video_size " + w + "x" + h +
                            " -framerate " + fps + " -i pipe:0 -vf scale=out_color_matrix=bt709,format=nv12 -an -c:v " + encoder + " " + tuning +
                            profileOption + " -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 -bf 0 -g " + Math.Max(15, fps * 2) + " -b:v " + bitrate + " -maxrate " + (bitrate + bitrate / 4) + " -bufsize " + bitrate +
                            " -fps_mode passthrough" +
                            (framed ? " -bsf:v h264_metadata=aud=insert,setts=ts=N -flush_packets 1 -f avi pipe:1" : " -bsf:v h264_metadata=aud=insert -flush_packets 1 -f h264 pipe:1");

                        using (var process = new Process()) {
                            process.StartInfo = new ProcessStartInfo(executable, args) {
                                UseShellExecute = false, CreateNoWindow = true,
                                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                            };
                            process.ErrorDataReceived += (sender, e) => { if (e.Data != null) Console.Error.WriteLine("[video-secure:" + encoder + "] " + e.Data); };
                            process.Start();
                            if (!AssignProcessToJobObject(job, process.Handle)) { process.Kill(); return false; }
                            process.BeginErrorReadLine();

                            int received = 0;
                            volatileStopSecure = false;
                            var feeder = Task.Run(() => {
                                try {
                                    var stdin = process.StandardInput.BaseStream;
                                    stdin.Write(firstFrame, 0, firstFrame.Length);
                                    stdin.Flush();
                                    byte[] buf = new byte[frameBytes];
                                    while (!ended && !volatileStopSecure && ReadExactBytes(pipe, buf, frameBytes)) {
                                        stdin.Write(buf, 0, frameBytes);
                                        stdin.Flush();
                                    }
                                } catch { }
                                finally { try { process.StandardInput.Close(); } catch { } }
                            });
                            var copier = Task.Run(() => {
                                var buffer = new byte[65536];
                                int count;
                                try {
                                    while ((count = process.StandardOutput.BaseStream.Read(buffer, 0, buffer.Length)) > 0) {
                                        if (Interlocked.Exchange(ref received, 1) == 0) {
                                            Console.Error.WriteLine("[video] secure-desktop encoder=" + encoder + " width=" + w + " height=" + h + " fps=" + fps);
                                        }
                                        destination.Write(buffer, 0, count);
                                        destination.Flush();
                                    }
                                } catch { }
                            });
                            try {
                                while (!ended && !process.WaitForExit(50)) {
                                    EnsureSharingEnabled();
                                    if (IsDefaultDesktopActive()) {
                                        volatileStopSecure = true;
                                        break;
                                    }
                                }
                            } finally {
                                volatileStopSecure = true;
                                try { pipe.Dispose(); } catch { }
                                try { process.StandardInput.Close(); } catch { }
                                if (!process.HasExited && !process.WaitForExit(1000)) { try { process.Kill(); } catch { } }
                                process.WaitForExit();
                                feeder.Wait(1500);
                                copier.Wait(2000);
                            }
                            if (ended || IsDefaultDesktopActive() || received != 0) return true;
                        }
                    }
                    return false;
                }
            } catch {
                return false;
            }
        }

        static volatile bool volatileStopSecure;

        static bool TryStreamSecureDesktopJpeg(int screen, int width, int fps, int quality, Stream output) {
            var pipe = ConnectElevatedServicePipe("capture-jpeg", screen, width, 1080, fps, quality);
            if (pipe == null) return false;
            try {
                using (pipe) {
                    byte[] lenBuf = new byte[4];
                    while (!ended) {
                        EnsureSharingEnabled();
                        if (IsDefaultDesktopActive()) return true;
                        if (!ReadExactBytes(pipe, lenBuf, 4)) return true;
                        int len = BitConverter.ToInt32(lenBuf, 0);
                        if (len < 4 || len > 16 * 1024 * 1024) return false;
                        byte[] payload = new byte[len];
                        if (!ReadExactBytes(pipe, payload, len)) return true;
                        output.Write(lenBuf, 0, 4);
                        output.Write(payload, 0, len);
                        output.Flush();
                    }
                    return true;
                }
            } catch {
                return false;
            }
        }

        static bool ReadExactBytes(Stream stream, byte[] buffer, int count) {
            int offset = 0;
            while (offset < count) {
                int n = stream.Read(buffer, offset, count - offset);
                if (n <= 0) return false;
                offset += n;
            }
            return true;
        }
    }
}
