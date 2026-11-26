using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;

namespace LinkShell.Windows {
    // Offline installer, PnP controller, and XML mode manager for the MIT SignPath-signed
    // Virtual Display Driver (MttVDD, IddCx) bundled in <bundle>\vdd\.
    // Pure C# 5 (.NET Framework 4.8 csc.exe) using official Win32 SetupAPI / NewDev / CfgMgr32 APIs.
    internal static partial class ScreenHelper {
        const string VddHardwareId = @"Root\MttVDD";
        const string VddSettingsDir = @"C:\VirtualDisplayDriver";
        static readonly Guid DisplayClassGuid = new Guid("4D36E968-E325-11CE-BFC1-08002BE10318");

        const uint DIGCF_PRESENT = 0x00000002;
        const uint SPDRP_DEVICEDESC = 0x00000000;
        const uint SPDRP_HARDWAREID = 0x00000001;
        const uint DICD_GENERATE_ID = 0x00000001;
        const uint DIF_REGISTERDEVICE = 0x00000019;
        const uint DIF_REMOVE = 0x00000005;
        const uint INSTALLFLAG_FORCE = 0x00000001;
        const uint CR_SUCCESS = 0;
        const uint DN_STARTED = 0x00000008;

        [StructLayout(LayoutKind.Sequential)]
        struct SP_DEVINFO_DATA {
            public uint cbSize;
            public Guid ClassGuid;
            public uint DevInst;
            public IntPtr Reserved;
        }

        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr SetupDiGetClassDevs(ref Guid classGuid, string enumerator, IntPtr hwndParent, uint flags);
        [DllImport("setupapi.dll", SetLastError = true)]
        static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid classGuid, IntPtr hwndParent);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetupDiCreateDeviceInfo(
            IntPtr deviceInfoSet, string deviceName, ref Guid classGuid, string deviceDescription,
            IntPtr hwndParent, uint creationFlags, ref SP_DEVINFO_DATA deviceInfoData);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetupDiSetDeviceRegistryProperty(
            IntPtr deviceInfoSet, ref SP_DEVINFO_DATA deviceInfoData, uint property,
            byte[] propertyBuffer, uint propertyBufferSize);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetupDiGetDeviceRegistryProperty(
            IntPtr deviceInfoSet, ref SP_DEVINFO_DATA deviceInfoData, uint property,
            out uint propertyRegDataType, byte[] propertyBuffer, uint propertyBufferSize, out uint requiredSize);
        [DllImport("setupapi.dll", SetLastError = true)]
        static extern bool SetupDiCallClassInstaller(uint installFunction, IntPtr deviceInfoSet, ref SP_DEVINFO_DATA deviceInfoData);
        [DllImport("setupapi.dll", SetLastError = true)]
        static extern bool SetupDiEnumDeviceInfo(IntPtr deviceInfoSet, uint memberIndex, ref SP_DEVINFO_DATA deviceInfoData);
        [DllImport("setupapi.dll", SetLastError = true)]
        static extern bool SetupDiDestroyDeviceInfoList(IntPtr deviceInfoSet);

        [DllImport("newdev.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool UpdateDriverForPlugAndPlayDevices(
            IntPtr hwndParent, string hardwareId, string fullInfPath, uint installFlags, out bool rebootRequired);

        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
        static extern uint CM_Get_DevNode_Status(out uint status, out uint problemNumber, uint devInst, uint flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
        static extern uint CM_Disable_DevNode(uint devInst, uint flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
        static extern uint CM_Enable_DevNode(uint devInst, uint flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
        static extern uint CM_Get_Device_ID(uint devInst, StringBuilder buffer, int bufferLen, uint flags);

        sealed class VddQueryResult {
            public bool Installed;
            public bool Enabled;
            public bool Active;
            public string DeviceId;
            public int VirtualMonitors;
            public bool DriverBundled;
        }

        static string BundledVddDir() {
            string exeDir = Path.GetDirectoryName(CurrentExePath());
            if (!String.IsNullOrEmpty(exeDir)) {
                string beside = Path.Combine(exeDir, "vdd");
                if (File.Exists(Path.Combine(beside, "MttVDD.inf"))) return beside;
            }
            string bundle = Environment.GetEnvironmentVariable("LINKSHELL_APP_BUNDLE");
            if (!String.IsNullOrEmpty(bundle)) {
                string inBundle = Path.Combine(bundle, "vdd");
                if (File.Exists(Path.Combine(inBundle, "MttVDD.inf"))) return inBundle;
            }
            return null;
        }

        static string ReadDevicePropString(IntPtr infoSet, ref SP_DEVINFO_DATA dev, uint prop) {
            uint regType, needed;
            byte[] buf = new byte[1024];
            if (!SetupDiGetDeviceRegistryProperty(infoSet, ref dev, prop, out regType, buf, (uint)buf.Length, out needed)) {
                return "";
            }
            int len = Math.Min(buf.Length, (int)needed);
            return Encoding.Unicode.GetString(buf, 0, len).Replace('\0', ' ').Trim();
        }

        static bool IsMttVddDevice(IntPtr infoSet, ref SP_DEVINFO_DATA dev) {
            string hwid = ReadDevicePropString(infoSet, ref dev, SPDRP_HARDWAREID);
            if (hwid.IndexOf("MttVDD", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            string desc = ReadDevicePropString(infoSet, ref dev, SPDRP_DEVICEDESC);
            return desc.IndexOf("Virtual Display Driver", StringComparison.OrdinalIgnoreCase) >= 0
                || desc.IndexOf("IddSampleDriver", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        static VddQueryResult QueryVddStatus() {
            var res = new VddQueryResult {
                DeviceId = "",
                DriverBundled = BundledVddDir() != null,
            };
            Guid cls = DisplayClassGuid;
            IntPtr infoSet = SetupDiGetClassDevs(ref cls, null, IntPtr.Zero, DIGCF_PRESENT);
            if (infoSet != IntPtr.Zero && infoSet != new IntPtr(-1)) {
                try {
                    var dev = new SP_DEVINFO_DATA();
                    dev.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
                    for (uint i = 0; SetupDiEnumDeviceInfo(infoSet, i, ref dev); i++) {
                        if (!IsMttVddDevice(infoSet, ref dev)) continue;
                        res.Installed = true;
                        var idBuf = new StringBuilder(256);
                        if (CM_Get_Device_ID(dev.DevInst, idBuf, idBuf.Capacity, 0) == CR_SUCCESS) {
                            res.DeviceId = idBuf.ToString();
                        }
                        uint status, problem;
                        if (CM_Get_DevNode_Status(out status, out problem, dev.DevInst, 0) == CR_SUCCESS) {
                            res.Enabled = problem == 0 && (status & DN_STARTED) != 0;
                        }
                        break;
                    }
                } finally {
                    SetupDiDestroyDeviceInfoList(infoSet);
                }
            }

            try {
                var displays = EnumerateDisplays();
                for (int i = 0; i < displays.Length; i++) {
                    DISPLAY_DEVICE adapter = new DISPLAY_DEVICE();
                    adapter.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
                    for (uint ai = 0; EnumDisplayDevices(null, ai, ref adapter, 0); ai++) {
                        if (String.Equals(adapter.DeviceName, displays[i].DeviceName, StringComparison.OrdinalIgnoreCase)) {
                            string name = adapter.DeviceString ?? "";
                            if (name.IndexOf("Virtual Display", StringComparison.OrdinalIgnoreCase) >= 0
                                || name.IndexOf("IddSampleDriver", StringComparison.OrdinalIgnoreCase) >= 0
                                || name.IndexOf("MttVDD", StringComparison.OrdinalIgnoreCase) >= 0) {
                                res.VirtualMonitors++;
                                res.Active = true;
                            }
                            break;
                        }
                    }
                }
            } catch { }
            return res;
        }

        static void PrintVddStatus() {
            var st = QueryVddStatus();
            Write(new {
                installed = st.Installed,
                enabled = st.Enabled,
                active = st.Active,
                deviceId = st.DeviceId,
                virtualMonitors = st.VirtualMonitors,
                driverBundled = st.DriverBundled,
            });
        }

        static void WriteVddSettingsXml(int customWidth, int customHeight, int customHz, int count) {
            Directory.CreateDirectory(VddSettingsDir);
            int safeCount = Math.Max(0, Math.Min(2, count));
            var modes = new List<int[]> {
                new[] { 1920, 1080, 60 },
                new[] { 2560, 1440, 60 },
                new[] { 3840, 2160, 60 },
                new[] { 2560, 1600, 60 },
                new[] { 2880, 1800, 60 },
                new[] { 3024, 1964, 60 },
                new[] { 3456, 2234, 60 },
                new[] { 1728, 1117, 60 },
                new[] { 1512, 982, 60 },
                new[] { 1680, 1050, 60 },
                new[] { 1440, 900, 60 },
                new[] { 1280, 800, 60 },
                new[] { 2388, 1668, 60 },
                new[] { 2732, 2048, 60 },
            };
            if (customWidth >= 640 && customWidth <= 3840 && customHeight >= 480 && customHeight <= 2400) {
                int w = (customWidth / 2) * 2;
                int h = (customHeight / 2) * 2;
                int hz = Math.Max(30, Math.Min(144, customHz > 0 ? customHz : 60));
                bool exists = false;
                for (int i = 0; i < modes.Count; i++) {
                    if (modes[i][0] == w && modes[i][1] == h) { exists = true; break; }
                }
                if (!exists) modes.Insert(0, new[] { w, h, hz });
            }

            var sb = new StringBuilder();
            sb.AppendLine("<?xml version='1.0' encoding='utf-8'?>");
            sb.AppendLine("<vdd_settings>");
            sb.AppendLine("    <monitors>");
            sb.AppendLine("        <count>" + safeCount.ToString(CultureInfo.InvariantCulture) + "</count>");
            sb.AppendLine("    </monitors>");
            sb.AppendLine("    <gpu>");
            sb.AppendLine("        <friendlyname>default</friendlyname>");
            sb.AppendLine("    </gpu>");
            sb.AppendLine("    <global>");
            sb.AppendLine("        <g_refresh_rate>60</g_refresh_rate>");
            sb.AppendLine("        <g_refresh_rate>90</g_refresh_rate>");
            sb.AppendLine("        <g_refresh_rate>120</g_refresh_rate>");
            sb.AppendLine("    </global>");
            sb.AppendLine("    <resolutions>");
            for (int i = 0; i < modes.Count; i++) {
                sb.AppendLine("        <resolution>");
                sb.AppendLine("            <width>" + modes[i][0].ToString(CultureInfo.InvariantCulture) + "</width>");
                sb.AppendLine("            <height>" + modes[i][1].ToString(CultureInfo.InvariantCulture) + "</height>");
                sb.AppendLine("            <refresh_rate>" + modes[i][2].ToString(CultureInfo.InvariantCulture) + "</refresh_rate>");
                sb.AppendLine("        </resolution>");
            }
            sb.AppendLine("    </resolutions>");
            sb.AppendLine("    <logging>");
            sb.AppendLine("        <SendLogsThroughPipe>true</SendLogsThroughPipe>");
            sb.AppendLine("        <logging>false</logging>");
            sb.AppendLine("        <debuglogging>false</debuglogging>");
            sb.AppendLine("    </logging>");
            sb.AppendLine("    <colour>");
            sb.AppendLine("        <SDR10bit>false</SDR10bit>");
            sb.AppendLine("        <HDRPlus>false</HDRPlus>");
            sb.AppendLine("        <ColourFormat>RGB</ColourFormat>");
            sb.AppendLine("    </colour>");
            sb.AppendLine("    <cursor>");
            sb.AppendLine("        <HardwareCursor>true</HardwareCursor>");
            sb.AppendLine("        <CursorMaxX>128</CursorMaxX>");
            sb.AppendLine("        <CursorMaxY>128</CursorMaxY>");
            sb.AppendLine("        <AlphaCursorSupport>true</AlphaCursorSupport>");
            sb.AppendLine("    </cursor>");
            sb.AppendLine("</vdd_settings>");
            File.WriteAllText(Path.Combine(VddSettingsDir, "vdd_settings.xml"), sb.ToString(), new UTF8Encoding(false));
        }

        static bool SetVddNodeEnabled(bool enable) {
            Guid cls = DisplayClassGuid;
            IntPtr infoSet = SetupDiGetClassDevs(ref cls, null, IntPtr.Zero, DIGCF_PRESENT);
            if (infoSet == IntPtr.Zero || infoSet == new IntPtr(-1)) return false;
            bool touched = false;
            try {
                var dev = new SP_DEVINFO_DATA();
                dev.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
                for (uint i = 0; SetupDiEnumDeviceInfo(infoSet, i, ref dev); i++) {
                    if (!IsMttVddDevice(infoSet, ref dev)) continue;
                    uint rc = enable ? CM_Enable_DevNode(dev.DevInst, 0) : CM_Disable_DevNode(dev.DevInst, 0);
                    if (rc == CR_SUCCESS) touched = true;
                }
            } finally {
                SetupDiDestroyDeviceInfoList(infoSet);
            }
            return touched;
        }

        static bool ConfigureVddFromService(string mode, int width, int height, int hz, int count) {
            try {
                if (mode == "vdd-disable") {
                    return SetVddNodeEnabled(false);
                }
                if (mode == "vdd-enable") {
                    if (!File.Exists(Path.Combine(VddSettingsDir, "vdd_settings.xml"))) {
                        WriteVddSettingsXml(width, height, hz, Math.Max(1, count));
                    }
                    return SetVddNodeEnabled(true);
                }
                if (mode == "vdd-configure") {
                    WriteVddSettingsXml(width, height, hz, Math.Max(1, count));
                    SetVddNodeEnabled(false);
                    Thread.Sleep(250);
                    return SetVddNodeEnabled(true);
                }
            } catch (Exception err) {
                LogServiceEvent("vdd action failed (" + mode + "): " + err.Message);
            }
            return false;
        }

        static void TrustDriverPublisherCert(string catPath) {
            if (!File.Exists(catPath)) return;
            var certs = new X509Certificate2Collection();
            certs.Import(File.ReadAllBytes(catPath));
            using (var store = new X509Store(StoreName.TrustedPublisher, StoreLocation.LocalMachine)) {
                store.Open(OpenFlags.ReadWrite);
                for (int i = 0; i < certs.Count; i++) {
                    // Only trust the leaf SignPath publisher cert (never install arbitrary roots into LocalMachine\Root).
                    if (certs[i].Subject != certs[i].Issuer) {
                        store.Add(certs[i]);
                    }
                }
            }
        }

        static void InstallVddDriver(string vddDir) {
            if (!IsRunningAsAdministrator()) throw new InvalidOperationException("安装虚拟显示器驱动需要管理员权限");
            string dir = String.IsNullOrWhiteSpace(vddDir) ? BundledVddDir() : vddDir;
            if (String.IsNullOrEmpty(dir) || !Directory.Exists(dir)) throw new InvalidOperationException("未找到内置虚拟显示器驱动文件（vdd）");
            string infPath = Path.Combine(dir, "MttVDD.inf");
            string catPath = Path.Combine(dir, "mttvdd.cat");
            string dllPath = Path.Combine(dir, "MttVDD.dll");
            if (!File.Exists(infPath) || !File.Exists(dllPath)) throw new InvalidOperationException("虚拟显示器驱动包不完整（缺少 MttVDD.inf 或 MttVDD.dll）");

            TrustDriverPublisherCert(catPath);
            WriteVddSettingsXml(1920, 1080, 60, 1);

            var current = QueryVddStatus();
            if (!current.Installed) {
                Guid cls = DisplayClassGuid;
                IntPtr infoSet = SetupDiCreateDeviceInfoList(ref cls, IntPtr.Zero);
                if (infoSet == IntPtr.Zero || infoSet == new IntPtr(-1)) {
                    throw new InvalidOperationException("SetupDiCreateDeviceInfoList 失败：" + Marshal.GetLastWin32Error());
                }
                try {
                    var dev = new SP_DEVINFO_DATA();
                    dev.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
                    if (!SetupDiCreateDeviceInfo(infoSet, "Display", ref cls, "Virtual Display Driver", IntPtr.Zero, DICD_GENERATE_ID, ref dev)) {
                        throw new InvalidOperationException("创建虚拟显示设备节点失败：" + Marshal.GetLastWin32Error());
                    }
                    // Multi-SZ UTF-16 string terminated by two NUL characters.
                    byte[] hwidBytes = Encoding.Unicode.GetBytes(VddHardwareId + "\0\0");
                    if (!SetupDiSetDeviceRegistryProperty(infoSet, ref dev, SPDRP_HARDWAREID, hwidBytes, (uint)hwidBytes.Length)) {
                        throw new InvalidOperationException("设置虚拟显示硬件 ID 失败：" + Marshal.GetLastWin32Error());
                    }
                    if (!SetupDiCallClassInstaller(DIF_REGISTERDEVICE, infoSet, ref dev)) {
                        throw new InvalidOperationException("注册虚拟显示设备失败：" + Marshal.GetLastWin32Error());
                    }
                } finally {
                    SetupDiDestroyDeviceInfoList(infoSet);
                }
            }

            bool reboot = false;
            if (!UpdateDriverForPlugAndPlayDevices(IntPtr.Zero, VddHardwareId, infPath, INSTALLFLAG_FORCE, out reboot)) {
                int err = Marshal.GetLastWin32Error();
                // Fallback to native pnputil.exe (handles ARM64 hosts even if invoked under emulation).
                var psi = new ProcessStartInfo("pnputil.exe", "/add-driver \"" + infPath + "\" /install") {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
                };
                int pnpCode = -1;
                string pnpOut = "";
                try {
                    using (var p = Process.Start(psi)) {
                        pnpOut = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
                        p.WaitForExit(30000);
                        pnpCode = p.ExitCode;
                    }
                } catch { }
                // pnputil exits 0 (success) or 3010 (reboot required, though IddCx activates live).
                if (pnpCode != 0 && pnpCode != 3010) {
                    throw new InvalidOperationException("安装虚拟显示器驱动失败（错误码 0x" + err.ToString("X8", CultureInfo.InvariantCulture) + "）：" + pnpOut.Trim());
                }
            }
            SetVddNodeEnabled(true);
            Thread.Sleep(600);
        }

        static void UninstallVddDriver() {
            if (!IsRunningAsAdministrator()) throw new InvalidOperationException("卸载虚拟显示器驱动需要管理员权限");
            Guid cls = DisplayClassGuid;
            IntPtr infoSet = SetupDiGetClassDevs(ref cls, null, IntPtr.Zero, DIGCF_PRESENT);
            if (infoSet != IntPtr.Zero && infoSet != new IntPtr(-1)) {
                try {
                    var dev = new SP_DEVINFO_DATA();
                    dev.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
                    for (uint i = 0; SetupDiEnumDeviceInfo(infoSet, i, ref dev); i++) {
                        if (!IsMttVddDevice(infoSet, ref dev)) continue;
                        SetupDiCallClassInstaller(DIF_REMOVE, infoSet, ref dev);
                    }
                } finally {
                    SetupDiDestroyDeviceInfoList(infoSet);
                }
            }

            // Clean any staged MttVDD oem*.inf packages from Windows Driver Store.
            try {
                var psi = new ProcessStartInfo("pnputil.exe", "/enum-drivers") {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, StandardOutputEncoding = Encoding.UTF8,
                };
                using (var p = Process.Start(psi)) {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(10000);
                    string lastOem = null;
                    foreach (string rawLine in output.Split('\n')) {
                        string line = rawLine.Trim();
                        if (line.IndexOf(".inf", StringComparison.OrdinalIgnoreCase) >= 0 && line.IndexOf("oem", StringComparison.OrdinalIgnoreCase) >= 0) {
                            int idx = line.IndexOf("oem", StringComparison.OrdinalIgnoreCase);
                            int end = line.IndexOf(".inf", idx, StringComparison.OrdinalIgnoreCase);
                            if (end > idx) lastOem = line.Substring(idx, end - idx + 4);
                        } else if (!String.IsNullOrEmpty(lastOem) && line.IndexOf("mttvdd.inf", StringComparison.OrdinalIgnoreCase) >= 0) {
                            var del = new ProcessStartInfo("pnputil.exe", "/delete-driver " + lastOem + " /uninstall /force") {
                                UseShellExecute = false, CreateNoWindow = true,
                            };
                            using (var dp = Process.Start(del)) { dp.WaitForExit(10000); }
                            lastOem = null;
                        }
                    }
                }
            } catch { }
        }
    }
}
