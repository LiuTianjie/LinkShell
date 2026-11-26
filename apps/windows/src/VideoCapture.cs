using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace LinkShell.Windows {
    internal static partial class ScreenHelper {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref JobLimits limits, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
            public long ProcessTime, JobTime;
            public uint Flags;
            public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            public uint ActiveProcesses;
            public UIntPtr Affinity;
            public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] struct JobLimits {
            public BasicLimits Basic;
            public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }

        sealed class VideoAttempt {
            public string SourceKind; // "ddagrab", "gfxcapture", "gdigrab", or "window"
            public string Encoder;
            public bool Compatible;
            public bool SoftwareFallback;
            public string PathName { get { return SoftwareFallback ? "software" : (Compatible ? "compatible" : "native"); } }
            public string HintKey { get { return SourceKind + ":" + Encoder + ":" + PathName; } }
            public string LegacyHintKey { get { return Encoder + ":" + PathName; } }
        }

        /// <summary>
        /// Fusion: one window (FFmpeg's gfxcapture, Windows.Graphics.Capture) at the top left of a
        /// fixed canvas, so resizing the window never restarts the encoder (docs/v2/fusion.md §8.2).
        /// capture_border=1 keeps the title bar: the default crops to the client area.
        /// </summary>
        static void CaptureWindowVideo(long hwnd, int canvasWidth, int canvasHeight, int fps, int bitrate, string executable) {
            var window = new IntPtr(hwnd);
            RECT frame;
            if (!WindowFrame(window, out frame)) throw new ArgumentException("窗口已关闭");
            var center = new System.Drawing.Point((frame.Left + frame.Right) / 2, (frame.Top + frame.Bottom) / 2);
            bounds = DisplayBoundsAt(center);
            int w = Math.Max(2, Math.Min(3840, canvasWidth) / 2 * 2), h = Math.Max(2, Math.Min(2160, canvasHeight) / 2 * 2);
            string source = "gfxcapture=hwnd=" + hwnd + ":capture_border=1:capture_cursor=0:width=" + w + ":height=" + h + ":resize_mode=crop:max_framerate=" + Math.Max(1, Math.Min(60, fps)) + ",";
            RunVideo(w, h, fps, bitrate, executable, source, 0, 0, -1, -1, IntPtr.Zero, true);
        }

        static void CaptureVideo(int screen, int width, int fps, int bitrate, string executable) {
            EnsureSharingEnabled();
            if (!Path.IsPathRooted(executable) || !File.Exists(executable)) throw new ArgumentException("Windows 视频组件缺失");
            fps = Math.Max(1, Math.Min(60, fps));
            bitrate = Math.Max(300000, Math.Min(24000000, bitrate));
            System.Drawing.Rectangle svcBounds;
            bool startedOnSecure = !IsDefaultDesktopActive();
            IntPtr hmonitor = IntPtr.Zero;
            bool hasActiveMonitor = true;
            if (startedOnSecure && TryServiceDisplayBounds(screen, out svcBounds)) {
                bounds = svcBounds;
            } else {
                var entry = DisplayEntry(screen);
                bounds = entry.Bounds;
                hmonitor = entry.Monitor;
                hasActiveMonitor = entry.HasActiveMonitor;
            }
            // Allow up to 4K native (3840x2160, Level 5.2) when requested and never upscale.
            int maxW = Math.Max(320, Math.Min(3840, width));
            double maxH = maxW > 2560 ? 2160.0 : maxW > 1920 ? 1440.0 : 1080.0;
            double scale = Math.Min(1, Math.Min(maxW / (double)bounds.Width, maxH / bounds.Height));
            int w = Math.Max(2, (int)(bounds.Width * scale) / 2 * 2), h = Math.Max(2, (int)(bounds.Height * scale) / 2 * 2);
            uint vendor = 0; int adapterIndex = 0; int dxgiOutput = -1;
            if (!startedOnSecure) {
                try {
                    dxgiOutput = DesktopDuplication.VideoOutput(bounds, out vendor, out adapterIndex);
                } catch {
                    dxgiOutput = -1;
                    vendor = DesktopDuplication.PrimaryVendor();
                    adapterIndex = 0;
                }
            }
            if (vendor == 0) vendor = DesktopDuplication.PrimaryVendor();
            string ddaSource = dxgiOutput >= 0 ? ("ddagrab=output_idx=" + dxgiOutput + ":framerate=" + fps + ":draw_mouse=0,") : null;
            RunVideo(w, h, fps, bitrate, executable, ddaSource, vendor, adapterIndex, screen, dxgiOutput, hmonitor, hasActiveMonitor);
        }

        static string BuildGfxMonitorFilter(IntPtr hmonitor, int screenIndex, int w, int h, int fps) {
            string target = hmonitor != IntPtr.Zero
                ? ("hmonitor=" + unchecked((ulong)hmonitor.ToInt64()).ToString(System.Globalization.CultureInfo.InvariantCulture))
                : ("monitor_idx=" + Math.Max(0, screenIndex));
            return "gfxcapture=" + target + ":capture_cursor=0:width=" + w + ":height=" + h + ":resize_mode=scale:scale_mode=bicubic:max_framerate=" + fps;
        }

        static void RunVideo(int w, int h, int fps, int bitrate, string executable, string source, uint vendor = 0, int adapterIndex = 0, int screenIndex = -1, int dxgiOutput = -1, IntPtr hmonitor = default(IntPtr), bool hasActiveMonitor = true) {
            if (!Path.IsPathRooted(executable) || !File.Exists(executable)) throw new ArgumentException("Windows 视频组件缺失");
            fps = Math.Max(1, Math.Min(60, fps));
            bitrate = Math.Max(300000, Math.Min(24000000, bitrate));
            bool isWindowCapture = screenIndex < 0;
            // A window's capture only wants to know whose encoder to try first: a display that
            // can't be duplicated (rotated, on another adapter) must not stop the window's picture.
            if (vendor == 0 && IsDefaultDesktopActive()) {
                try { uint found; DesktopDuplication.VideoOutput(bounds, out found); vendor = found; }
                catch (Exception) { vendor = DesktopDuplication.PrimaryVendor(); }
            }
            string preferred = vendor == 0x1002 ? "h264_amf" : vendor == 0x10de ? "h264_nvenc" : vendor == 0x8086 ? "h264_qsv" : "h264_mf";
            string selected = Environment.GetEnvironmentVariable("LINKSHELL_WINDOWS_ENCODER");
            var encoders = String.IsNullOrEmpty(selected) ? new[] { preferred, "h264_mf" }.Distinct().ToArray() : new[] { selected };
            if (encoders.Any(e => !new[] { "h264_amf", "h264_nvenc", "h264_qsv", "h264_mf" }.Contains(e))) throw new ArgumentException("未知 Windows 硬件编码器");
            var input = new Thread(() => {
                try {
                    string line;
                    while ((line = Console.ReadLine()) != null) {
                        if (line.IndexOf("\"nudge\"", StringComparison.Ordinal) >= 0 || line.IndexOf("\"keyframe\"", StringComparison.Ordinal) >= 0) {
                            NudgeDesktopForCapture();
                        }
                    }
                } finally { ended = true; }
            });
            input.IsBackground = true; input.Start();
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new InvalidOperationException("无法保护视频进程生命周期");
            try {
                var limits = new JobLimits { Basic = new BasicLimits { Flags = 0x2000 } }; // KILL_ON_JOB_CLOSE, including a killed helper.
                if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits)))) throw new InvalidOperationException("无法配置视频进程生命周期");
                var attempts = new List<VideoAttempt>();
                if (isWindowCapture) {
                    foreach (var encoder in encoders) {
                        if (encoder != "h264_mf") attempts.Add(new VideoAttempt { SourceKind = "window", Encoder = encoder, Compatible = false });
                        attempts.Add(new VideoAttempt { SourceKind = "window", Encoder = encoder, Compatible = true });
                    }
                } else {
                    bool allowDdaFirst = hasActiveMonitor && dxgiOutput >= 0 && !String.IsNullOrEmpty(source);
                    bool allowGfx = hmonitor != IntPtr.Zero;
                    // 1. When an active physical monitor is attached, try zero-copy ddagrab first.
                    if (allowDdaFirst) {
                        foreach (var encoder in encoders) {
                            if (encoder != "h264_mf") attempts.Add(new VideoAttempt { SourceKind = "ddagrab", Encoder = encoder, Compatible = false });
                        }
                    }
                    // 2. Windows.Graphics.Capture (gfxcapture): GPU-scaled and works BOTH with monitors AND headless (unplugged/sleeping/rotated).
                    // Direct D3D11->NVENC avoids CPU download completely; hwdownload+nv12 covers AMF/QSV/MF cleanly.
                    if (allowGfx) {
                        foreach (var encoder in encoders) {
                            if (encoder == "h264_nvenc") attempts.Add(new VideoAttempt { SourceKind = "gfxcapture", Encoder = encoder, Compatible = false });
                            attempts.Add(new VideoAttempt { SourceKind = "gfxcapture", Encoder = encoder, Compatible = true });
                        }
                    }
                    // 3. Compatible ddagrab fallback (active monitor only).
                    if (allowDdaFirst) {
                        foreach (var encoder in encoders) {
                            attempts.Add(new VideoAttempt { SourceKind = "ddagrab", Encoder = encoder, Compatible = true });
                        }
                    }
                    // 4. Universal GDI desktop grab + hardware H.264: works even on 0-HMONITOR headless or legacy Win10 1809.
                    foreach (var encoder in encoders) {
                        attempts.Add(new VideoAttempt { SourceKind = "gdigrab", Encoder = encoder, Compatible = true });
                    }
                    // 5. Universal Media Foundation software-allowed fallback for VMs / Basic Render Driver with no GPU encoder.
                    if (String.IsNullOrEmpty(selected)) {
                        if (allowGfx) attempts.Add(new VideoAttempt { SourceKind = "gfxcapture", Encoder = "h264_mf", Compatible = true, SoftwareFallback = true });
                        attempts.Add(new VideoAttempt { SourceKind = "gdigrab", Encoder = "h264_mf", Compatible = true, SoftwareFallback = true });
                    }
                }
                // What made pictures last time goes first (the host remembers it): a driver that
                // refuses the zero-copy path refuses it every time, at an FFmpeg launch each.
                // Never prioritize a stale ddagrab hint when no active physical monitor is attached.
                string hint = Environment.GetEnvironmentVariable("LINKSHELL_WINDOWS_VIDEO_HINT");
                if (!String.IsNullOrEmpty(hint)) {
                    int known = attempts.FindIndex(a => a.HintKey == hint);
                    if (known < 0 && (isWindowCapture || hasActiveMonitor)) known = attempts.FindIndex(a => a.LegacyHintKey == hint);
                    if (known > 0) { var first = attempts[known]; attempts.RemoveAt(known); attempts.Insert(0, first); }
                }
                bool framed = Environment.GetEnvironmentVariable("LINKSHELL_VIDEO_FRAMED") == "1";
                using (var destination = Console.OpenStandardOutput()) {
                    foreach (var attempt in attempts) {
                        int zeroFramePauses = 0;
                        while (!ended) {
                            EnsureSharingEnabled();
                            if (!IsDefaultDesktopActive()) {
                                bool streamedSecure = screenIndex >= 0 && TryStreamSecureDesktopVideo(job, destination, executable, screenIndex, w, h, Math.Min(15, fps), Math.Min(bitrate, 4000000), attempt.Encoder, framed);
                                if (ended) return;
                                if (!streamedSecure && !WaitForDefaultDesktop(120000)) return;
                                if (!IsDefaultDesktopActive()) continue;
                                Thread.Sleep(250);
                                EnsureSharingEnabled();
                                if (screenIndex >= 0) {
                                    var entry = DisplayEntry(screenIndex);
                                    bounds = entry.Bounds;
                                    hmonitor = entry.Monitor;
                                    hasActiveMonitor = entry.HasActiveMonitor;
                                    try {
                                        uint v2; int a2; int out2 = DesktopDuplication.VideoOutput(bounds, out v2, out a2);
                                        adapterIndex = a2;
                                        dxgiOutput = out2;
                                        source = "ddagrab=output_idx=" + out2 + ":framerate=" + fps + ":draw_mouse=0,";
                                    } catch {
                                        dxgiOutput = -1;
                                        source = null;
                                    }
                                } else if (DisplayFromCacheChanged()) {
                                    throw new InvalidOperationException("屏幕布局已改变，请重新连接");
                                }
                            }
                            if (attempt.SourceKind == "ddagrab" && (dxgiOutput < 0 || String.IsNullOrEmpty(source))) break;
                            bool hadFrames;
                            int outcome = RunVideoEncoder(job, destination, executable, attempt.SourceKind, source, hmonitor, screenIndex, w, h, fps, bitrate, attempt.Encoder, attempt.Compatible, attempt.SoftwareFallback, adapterIndex, out hadFrames);
                            if (outcome == VideoEnded) return;
                            if (outcome == VideoDesktopPaused) {
                                if (hadFrames) zeroFramePauses = 0;
                                else if (++zeroFramePauses >= 5) break;
                                Console.Error.WriteLine("[video] desktop interrupted (UAC/secure desktop); streaming secure desktop or waiting for Default");
                                bool streamedSecure = screenIndex >= 0 && TryStreamSecureDesktopVideo(job, destination, executable, screenIndex, w, h, Math.Min(15, fps), Math.Min(bitrate, 4000000), attempt.Encoder, framed);
                                if (ended) return;
                                if (!streamedSecure && !WaitForDefaultDesktop(120000)) return;
                                if (!IsDefaultDesktopActive()) continue;
                                Thread.Sleep(250);
                                EnsureSharingEnabled();
                                if (DisplayFromCacheChanged()) throw new InvalidOperationException("屏幕布局已改变，请重新连接");
                                continue;
                            }
                            break;
                        }
                    }
                }
                if (!ended) throw new InvalidOperationException("这台电脑的硬件视频编码不可用，将使用兼容画面");
            } finally { CloseHandle(job); }
        }

        const int VideoFailed = 0;
        const int VideoEnded = 1;
        const int VideoDesktopPaused = 2;

        static bool IsDesktopAccessLostMessage(string line) {
            if (String.IsNullOrEmpty(line)) return false;
            return line.IndexOf("887a0026", StringComparison.OrdinalIgnoreCase) >= 0
                || line.IndexOf("DXGI_ERROR_ACCESS_LOST", StringComparison.OrdinalIgnoreCase) >= 0
                || line.IndexOf("access lost", StringComparison.OrdinalIgnoreCase) >= 0
                || line.IndexOf("failed to acquire", StringComparison.OrdinalIgnoreCase) >= 0
                || line.IndexOf("desktop switch", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        static int RunVideoEncoder(IntPtr job, Stream destination, string executable, string sourceKind, string ddaOrWindowSource, IntPtr hmonitor, int screenIndex, int width, int height, int fps, int bitrate, string encoder, bool compatible, bool softwareFallback, int adapterIndex, out bool hadFrames) {
            hadFrames = false;
            bool framed = Environment.GetEnvironmentVariable("LINKSHELL_VIDEO_FRAMED") == "1";
            bool needsScale = width != bounds.Width || height != bounds.Height;
            bool directRgbToNvenc = sourceKind == "gfxcapture" && encoder == "h264_nvenc" && !compatible;
            int effectiveFps = (sourceKind == "gdigrab" || softwareFallback) ? Math.Min(30, fps) : fps;

            string inputArgs;
            string adapterOption = "";
            if (sourceKind == "gdigrab") {
                string vf = needsScale
                    ? "scale=" + width + ":" + height + ":flags=bilinear:out_color_matrix=bt709,format=nv12"
                    : "scale=out_color_matrix=bt709,format=nv12";
                inputArgs = "-f gdigrab -framerate " + effectiveFps + " -draw_mouse 0 -offset_x " + bounds.Left + " -offset_y " + bounds.Top + " -video_size " + bounds.Width + "x" + bounds.Height + " -i desktop -vf \"" + vf + "\"";
            } else if (sourceKind == "gfxcapture") {
                string gfx = BuildGfxMonitorFilter(hmonitor, screenIndex, width, height, effectiveFps);
                string filter = directRgbToNvenc
                    ? gfx
                    : gfx + ",hwdownload,format=bgra,scale=out_color_matrix=bt709,format=nv12";
                inputArgs = "-f lavfi -i \"" + filter + "\"";
            } else {
                // ddagrab or Fusion window capture
                string filter = ddaOrWindowSource;
                if (compatible) filter += needsScale ? "hwdownload,format=bgra,scale=" + width + ":" + height + ":flags=bilinear:out_color_matrix=bt709,format=nv12" : "hwdownload,format=bgra,scale=out_color_matrix=bt709,format=nv12";
                else if (encoder == "h264_amf") filter += "vpp_amf=w=" + width + ":h=" + height + ":format=nv12";
                else if (encoder == "h264_qsv") filter += "hwmap=derive_device=qsv,vpp_qsv=w=" + width + ":h=" + height + ":format=nv12";
                else filter += "scale_d3d11=width=" + width + ":height=" + height + ":format=nv12";
                if (adapterIndex > 0 && sourceKind == "ddagrab") adapterOption = "-init_hw_device d3d11va=ls:" + adapterIndex + " -filter_hw_device ls ";
                inputArgs = "-f lavfi -i \"" + filter + "\"";
            }

            bool baseline = String.Equals(Environment.GetEnvironmentVariable("LINKSHELL_WINDOWS_PROFILE"), "baseline", StringComparison.OrdinalIgnoreCase);
            bool level52 = width * height > 3686400;
            bool level51 = width * height > 2088960;
            string nvLevel = level52 ? "5.2" : level51 ? "5.1" : "4.2";
            string numLevel = level52 ? "52" : level51 ? "51" : "42";
            // Low-latency VBR with QP bounds keeps UI text razor-sharp without CBR single-frame starvation.
            string tuning = encoder == "h264_amf" ? "-usage lowlatency -quality quality -rc vbr_latency -qp_i 18 -qp_p 20 -min_qp_i 14 -max_qp_i 32 -min_qp_p 14 -max_qp_p 34 -async_depth 1 -preanalysis 0" :
                encoder == "h264_nvenc" ? "-preset p4 -tune ll -rc vbr -cq 19 -qmin 14 -qmax 32 -zerolatency 1 -delay 0 -rc-lookahead 0 -spatial-aq 1 -aq-strength 10" :
                encoder == "h264_qsv" ? "-preset fast -async_depth 1 -look_ahead 0 -qmin 14 -qmax 32" :
                softwareFallback ? "-hw_encoding 0 -scenario display_remoting -quality 80" : "-hw_encoding 1 -scenario display_remoting -quality 90";
            string profileOption = encoder == "h264_nvenc"
                ? " -profile:v " + (baseline ? "baseline" : "main") + " -level:v " + nvLevel
                : encoder == "h264_amf"
                    ? " -profile:v " + (baseline ? "constrained_baseline" : "main") + " -level:v " + numLevel
                    : encoder == "h264_qsv"
                        ? " -profile:v " + (baseline ? "baseline" : "main") + " -level:v " + numLevel
                        : " -profile:v " + (baseline ? "66" : "77") + " -level:v " + numLevel;
            // 2-second GOP with bounded VBV buffer keeps IDR frames crisp (~80-150 KB) without UDP bursts.
            int gop = Math.Max(effectiveFps, Math.Min(120, effectiveFps * 2));
            int maxrate = Math.Min(28000000, bitrate + bitrate / 4);
            int bufsize = Math.Max(1500000, Math.Min(bitrate / 2, Math.Max(bitrate / 4, 2500000)));
            // Let direct D3D11->NVENC emit its native RGB->YUV color VUI (matches its internal matrix accurately).
            string colorArgs = directRgbToNvenc ? "" : " -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709";
            string args = "-hide_banner -loglevel warning -nostats " + adapterOption + inputArgs + " -an -c:v " + encoder + " " + tuning +
                // Level 4.2 covers 1080p, 5.1 covers 1440p, and 5.2 covers 4K60 native desktops.
                profileOption + colorArgs + " -bf 0 -g " + gop + " -b:v " + bitrate + " -maxrate " + maxrate + " -bufsize " + bufsize +
                " -fps_mode passthrough" +
                // Framed (the host asks): AVI, each picture in a chunk that says its length and is
                // written as it is encoded, so the host hands it on at its last byte. Raw H.264
                // only says where a picture starts: each waited for the next one, a frame late.
                // setts counts the pictures: AVI fills a gap in time with empty chunks, and gives
                // up over a long one, where a window's capture simply had nothing new to send.
                (framed ? " -bsf:v h264_metadata=aud=insert,setts=ts=N -flush_packets 1 -f avi pipe:1" : " -bsf:v h264_metadata=aud=insert -flush_packets 1 -f h264 pipe:1");
            int firstFrameTimeoutMs = sourceKind == "ddagrab" ? 2200 : sourceKind == "gfxcapture" ? 3000 : 4000;
            if (sourceKind == "gfxcapture") NudgeDesktopForCapture();
            using (var process = new Process()) {
                int accessLost = 0;
                process.StartInfo = new ProcessStartInfo(executable, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
                process.ErrorDataReceived += (sender, e) => {
                    if (e.Data != null) {
                        Console.Error.WriteLine("[video:" + encoder + "] " + e.Data);
                        if (IsDesktopAccessLostMessage(e.Data)) Interlocked.Exchange(ref accessLost, 1);
                    }
                };
                process.Start();
                if (!AssignProcessToJobObject(job, process.Handle)) { process.Kill(); throw new InvalidOperationException("无法绑定视频进程生命周期"); }
                Console.Error.WriteLine("[video] child=" + process.Id + " source=" + sourceKind);
                process.BeginErrorReadLine();
                int received = 0;
                var copy = Task.Run(() => {
                    var buffer = new byte[65536]; int count;
                    // AVI's headers are written before any picture is: an encoder that then fails
                    // has made nothing, and the next way of encoding must still be tried. Pictures
                    // begin after "movi".
                    byte[] mark = { (byte)'m', (byte)'o', (byte)'v', (byte)'i' };
                    int matched = framed ? 0 : mark.Length;
                    while ((count = process.StandardOutput.BaseStream.Read(buffer, 0, buffer.Length)) > 0) {
                        bool pictures = matched == mark.Length;
                        for (int i = 0; i < count && !pictures; i++) {
                            matched = buffer[i] == mark[matched] ? matched + 1 : buffer[i] == mark[0] ? 1 : 0;
                            if (matched == mark.Length) pictures = i + 1 < count;
                        }
                        if (pictures && Interlocked.Exchange(ref received, 1) == 0) {
                            string srcTag = sourceKind == "window" ? "" : (" source=" + sourceKind);
                            string pathName = softwareFallback ? "software" : (compatible ? "compatible" : "native");
                            Console.Error.WriteLine("[video] encoder=" + encoder + " width=" + width + " height=" + height + " fps=" + effectiveFps + " path=" + pathName + srcTag);
                        }
                        destination.Write(buffer, 0, count); destination.Flush();
                    }
                });
                bool desktopPaused = false;
                bool nudged = false;
                long lastLayoutCheck = 0;
                try {
                    var clock = Stopwatch.StartNew();
                    while (!ended && !process.WaitForExit(50)) {
                        EnsureSharingEnabled();
                        if (!IsDefaultDesktopActive()) { desktopPaused = true; break; }
                        long elapsedMs = clock.ElapsedMilliseconds;
                        if (elapsedMs - lastLayoutCheck >= 500) {
                            lastLayoutCheck = elapsedMs;
                            if (DisplayFromCacheChanged()) throw new InvalidOperationException("屏幕布局已改变，请重新连接");
                        }
                        if (copy.IsFaulted) throw copy.Exception;
                        if (received == 0 && !nudged && sourceKind == "gfxcapture" && elapsedMs >= 350) {
                            nudged = true;
                            NudgeDesktopForCapture();
                        }
                        if (received == 0 && elapsedMs > firstFrameTimeoutMs) break;
                    }
                } finally {
                    if (!process.HasExited) {
                        try { process.StandardInput.WriteLine("q"); } catch {}
                        if (!process.WaitForExit(desktopPaused ? 1000 : 500)) process.Kill();
                    }
                    process.WaitForExit();
                    if (!copy.Wait(2000)) throw new IOException("视频输出没有关闭");
                }
                hadFrames = received != 0;
                if (ended) return VideoEnded;
                if (desktopPaused || !IsDefaultDesktopActive() || (hadFrames && Interlocked.CompareExchange(ref accessLost, 0, 0) != 0)) return VideoDesktopPaused;
                if (hadFrames) throw new InvalidOperationException("硬件视频编码已停止");
                return VideoFailed;
            }
        }

        static bool DisplayFromCacheChanged() {
            // Bounds matching also rejects removal or a rotation while this helper owns a capture.
            return !EnumerateDisplays(false).Any(s => s.Bounds == bounds);
        }

        [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceEnumerator {
            [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint stateMask, out IntPtr devices);
            [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
            [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
            [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
            [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
        }

        [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDevice {
            [PreserveSig] int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePtr);
            [PreserveSig] int OpenPropertyStore(uint stgmAccess, out IntPtr properties);
            [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
            [PreserveSig] int GetState(out uint state);
        }

        [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioClient {
            [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);
            [PreserveSig] int GetBufferSize(out uint numBufferFrames);
            [PreserveSig] int GetStreamLatency(out long latency);
            [PreserveSig] int GetCurrentPadding(out uint numPaddingFrames);
            [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
            [PreserveSig] int GetMixFormat(out IntPtr deviceFormatPointer);
            [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
            [PreserveSig] int Start();
            [PreserveSig] int Stop();
            [PreserveSig] int Reset();
            [PreserveSig] int SetEventHandle(IntPtr eventHandle);
            [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePtr);
        }

        [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioCaptureClient {
            [PreserveSig] int GetBuffer(out IntPtr data, out uint numFramesToRead, out uint flags, out ulong devicePosition, out ulong qpcPosition);
            [PreserveSig] int ReleaseBuffer(uint numFramesRead);
            [PreserveSig] int GetNextPacketSize(out uint numFramesInNextPacket);
        }

        /// <summary>
        /// Captures Windows system loopback audio via WASAPI COM (FFmpeg on Windows has no wasapi input)
        /// and writes 48 kHz stereo PCM16 20 ms frames to stdout as [u32 length][u32 timestampMs][payload].
        /// </summary>
        static void CaptureAudio() {
            var input = new Thread(() => { try { while (Console.ReadLine() != null) {} } finally { ended = true; } }) { IsBackground = true };
            input.Start();

            const int targetRate = 48000;
            const int frameSamples = 960;
            const int frameBytes = frameSamples * 2 * 2;
            const uint audclntStreamFlagsLoopback = 0x00020000;
            const uint audclntBufferFlagsSilent = 0x2;
            const int audclntDeviceInvalidated = unchecked((int)0x88890004);
            const int errNotFound = unchecked((int)0x80070490);
            var clsidEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
            var iidAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
            var iidAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
            var subtypePcm = new Guid("00000001-0000-0010-8000-00aa00389b71");
            var subtypeFloat = new Guid("00000003-0000-0010-8000-00aa00389b71");

            var clock = Stopwatch.StartNew();
            byte[] packetBuf = new byte[0];
            float[] leftBuf = new float[0];
            float[] rightBuf = new float[0];
            byte[] outFrame = new byte[8 + frameBytes];
            outFrame[0] = (byte)(frameBytes & 0xff);
            outFrame[1] = (byte)((frameBytes >> 8) & 0xff);
            outFrame[2] = (byte)((frameBytes >> 16) & 0xff);
            outFrame[3] = (byte)((frameBytes >> 24) & 0xff);

            using (var destination = Console.OpenStandardOutput()) {
                while (!ended) {
                    EnsureSharingEnabled();
                    if (!IsDefaultDesktopActive()) { Thread.Sleep(150); continue; }
                    IMMDeviceEnumerator enumerator = null;
                    IMMDevice device = null;
                    IAudioClient audioClient = null;
                    IAudioCaptureClient captureClient = null;
                    IntPtr mixPtr = IntPtr.Zero;
                    try {
                        enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(clsidEnumerator, true));
                        int hr = enumerator.GetDefaultAudioEndpoint(0, 0, out device);
                        if (hr == errNotFound || device == null) {
                            Thread.Sleep(500);
                            continue;
                        }
                        if (hr < 0) Marshal.ThrowExceptionForHR(hr);

                        object rawClient;
                        hr = device.Activate(ref iidAudioClient, 23, IntPtr.Zero, out rawClient);
                        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
                        audioClient = (IAudioClient)rawClient;

                        hr = audioClient.GetMixFormat(out mixPtr);
                        if (hr < 0 || mixPtr == IntPtr.Zero) Marshal.ThrowExceptionForHR(hr < 0 ? hr : unchecked((int)0x80004005));

                        ushort formatTag = unchecked((ushort)Marshal.ReadInt16(mixPtr, 0));
                        ushort channels = unchecked((ushort)Marshal.ReadInt16(mixPtr, 2));
                        uint sampleRate = unchecked((uint)Marshal.ReadInt32(mixPtr, 4));
                        ushort blockAlign = unchecked((ushort)Marshal.ReadInt16(mixPtr, 12));
                        ushort bitsPerSample = unchecked((ushort)Marshal.ReadInt16(mixPtr, 14));
                        ushort cbSize = unchecked((ushort)Marshal.ReadInt16(mixPtr, 16));
                        bool isFloat = formatTag == 3;
                        if (formatTag == 0xFFFE && cbSize >= 22) {
                            byte[] guidBytes = new byte[16];
                            Marshal.Copy(new IntPtr(mixPtr.ToInt64() + 24), guidBytes, 0, 16);
                            var subFormat = new Guid(guidBytes);
                            if (subFormat == subtypeFloat) isFloat = true;
                            else if (subFormat == subtypePcm) isFloat = false;
                            else throw new NotSupportedException("Unsupported WASAPI audio subformat: " + subFormat);
                        } else if (formatTag != 1 && formatTag != 3) {
                            throw new NotSupportedException("Unsupported WASAPI audio format tag: " + formatTag);
                        }
                        if (channels == 0 || sampleRate == 0 || blockAlign == 0) throw new InvalidOperationException("Invalid WASAPI mix format");

                        // 100 ms shared loopback buffer (10,000,000 ticks = 1 second).
                        hr = audioClient.Initialize(0, audclntStreamFlagsLoopback, 1000000, 0, mixPtr, IntPtr.Zero);
                        if (hr == audclntDeviceInvalidated) { Thread.Sleep(200); continue; }
                        if (hr < 0) Marshal.ThrowExceptionForHR(hr);

                        object rawCapture;
                        hr = audioClient.GetService(ref iidAudioCaptureClient, out rawCapture);
                        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
                        captureClient = (IAudioCaptureClient)rawCapture;

                        hr = audioClient.Start();
                        if (hr < 0) Marshal.ThrowExceptionForHR(hr);

                        int framePos = 0;
                        int silentFrames = 0;
                        double srcPos = 0.0;
                        double step = (double)sampleRate / targetRate;
                        float prevL = 0.0f, prevR = 0.0f;
                        bool hasPrev = false;
                        long desktopCheckedAt = clock.ElapsedMilliseconds;

                        while (!ended) {
                            long nowMs = clock.ElapsedMilliseconds;
                            if (nowMs - desktopCheckedAt >= 250) {
                                EnsureSharingEnabled();
                                desktopCheckedAt = nowMs;
                                if (!IsDefaultDesktopActive()) break;
                            }

                            uint packetFrames;
                            hr = captureClient.GetNextPacketSize(out packetFrames);
                            if (hr == audclntDeviceInvalidated) break;
                            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
                            if (packetFrames == 0) {
                                Thread.Sleep(10);
                                continue;
                            }

                            while (packetFrames > 0 && !ended) {
                                IntPtr data;
                                uint numFrames;
                                uint flags;
                                ulong devPos, qpcPos;
                                hr = captureClient.GetBuffer(out data, out numFrames, out flags, out devPos, out qpcPos);
                                if (hr == audclntDeviceInvalidated) { packetFrames = 0; break; }
                                if (hr < 0) Marshal.ThrowExceptionForHR(hr);
                                if (hr != 0) { packetFrames = 0; break; }

                                try {
                                    bool silent = (flags & audclntBufferFlagsSilent) != 0 || data == IntPtr.Zero;
                                    int count = checked((int)numFrames);
                                    if (silent) {
                                        if (silentFrames < 5) {
                                            int outSamples = Math.Max(1, (int)Math.Round(count / step));
                                            long baseTs = clock.ElapsedMilliseconds;
                                            int emitted = 0;
                                            for (int i = 0; i < outSamples; i++) {
                                                outFrame[8 + framePos++] = 0; outFrame[8 + framePos++] = 0;
                                                outFrame[8 + framePos++] = 0; outFrame[8 + framePos++] = 0;
                                                if (framePos == frameBytes) {
                                                    EmitAudioFrame(destination, outFrame, unchecked((uint)(baseTs + emitted * 20)));
                                                    framePos = 0;
                                                    emitted++;
                                                    silentFrames++;
                                                    if (silentFrames >= 5) break;
                                                }
                                            }
                                        }
                                        prevL = 0.0f; prevR = 0.0f; hasPrev = false; srcPos = 0.0;
                                    } else if (count > 0) {
                                        silentFrames = 0;
                                        int byteCount = checked(count * blockAlign);
                                        if (packetBuf.Length < byteCount) packetBuf = new byte[byteCount];
                                        if (leftBuf.Length < count) { leftBuf = new float[count]; rightBuf = new float[count]; }
                                        Marshal.Copy(data, packetBuf, 0, byteCount);

                                        for (int i = 0; i < count; i++) {
                                            int off = i * blockAlign;
                                            float s0 = ReadSample(packetBuf, off, isFloat, bitsPerSample);
                                            float l, r;
                                            if (channels == 1) {
                                                l = s0; r = s0;
                                            } else {
                                                int stride = bitsPerSample / 8;
                                                float s1 = ReadSample(packetBuf, off + stride, isFloat, bitsPerSample);
                                                if (channels >= 6) {
                                                    float fc = ReadSample(packetBuf, off + stride * 2, isFloat, bitsPerSample);
                                                    float bl = ReadSample(packetBuf, off + stride * 4, isFloat, bitsPerSample);
                                                    float br = ReadSample(packetBuf, off + stride * 5, isFloat, bitsPerSample);
                                                    l = s0 + 0.7071f * fc + 0.5f * bl;
                                                    r = s1 + 0.7071f * fc + 0.5f * br;
                                                } else {
                                                    l = s0; r = s1;
                                                }
                                            }
                                            leftBuf[i] = l;
                                            rightBuf[i] = r;
                                        }

                                        long baseTs = clock.ElapsedMilliseconds;
                                        int emitted = 0;
                                        while (srcPos < count && !ended) {
                                            float lSample, rSample;
                                            if (sampleRate == targetRate) {
                                                int idx = (int)srcPos;
                                                lSample = leftBuf[idx];
                                                rSample = rightBuf[idx];
                                                srcPos += 1.0;
                                            } else {
                                                int idx = (int)Math.Floor(srcPos);
                                                double frac = srcPos - idx;
                                                float l0, r0, l1, r1;
                                                if (idx < 0) {
                                                    l0 = hasPrev ? prevL : leftBuf[0];
                                                    r0 = hasPrev ? prevR : rightBuf[0];
                                                    l1 = leftBuf[0];
                                                    r1 = rightBuf[0];
                                                } else if (idx + 1 < count) {
                                                    l0 = leftBuf[idx]; r0 = rightBuf[idx];
                                                    l1 = leftBuf[idx + 1]; r1 = rightBuf[idx + 1];
                                                } else {
                                                    l0 = leftBuf[count - 1]; r0 = rightBuf[count - 1];
                                                    l1 = l0; r1 = r0;
                                                }
                                                lSample = (float)(l0 + (l1 - l0) * frac);
                                                rSample = (float)(r0 + (r1 - r0) * frac);
                                                srcPos += step;
                                            }
                                            WriteInt16(outFrame, 8 + framePos, lSample);
                                            WriteInt16(outFrame, 8 + framePos + 2, rSample);
                                            framePos += 4;
                                            if (framePos == frameBytes) {
                                                EmitAudioFrame(destination, outFrame, unchecked((uint)(baseTs + emitted * 20)));
                                                framePos = 0;
                                                emitted++;
                                            }
                                        }
                                        srcPos -= count;
                                        prevL = leftBuf[count - 1];
                                        prevR = rightBuf[count - 1];
                                        hasPrev = true;
                                    }
                                } finally {
                                    captureClient.ReleaseBuffer(numFrames);
                                }

                                if (hr == audclntDeviceInvalidated) break;
                                hr = captureClient.GetNextPacketSize(out packetFrames);
                                if (hr == audclntDeviceInvalidated) break;
                                if (hr < 0) Marshal.ThrowExceptionForHR(hr);
                            }
                            if (hr == audclntDeviceInvalidated) break;
                        }
                    } finally {
                        if (captureClient != null) Marshal.ReleaseComObject(captureClient);
                        if (audioClient != null) { try { audioClient.Stop(); } catch {} Marshal.ReleaseComObject(audioClient); }
                        if (device != null) Marshal.ReleaseComObject(device);
                        if (enumerator != null) Marshal.ReleaseComObject(enumerator);
                        if (mixPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(mixPtr);
                    }
                    if (!ended) Thread.Sleep(200);
                }
            }
        }

        static void EmitAudioFrame(Stream destination, byte[] outFrame, uint timestampMs) {
            outFrame[4] = (byte)(timestampMs & 0xff);
            outFrame[5] = (byte)((timestampMs >> 8) & 0xff);
            outFrame[6] = (byte)((timestampMs >> 16) & 0xff);
            outFrame[7] = (byte)((timestampMs >> 24) & 0xff);
            destination.Write(outFrame, 0, outFrame.Length);
            destination.Flush();
        }

        static float ReadSample(byte[] buf, int offset, bool isFloat, ushort bits) {
            if (isFloat && bits == 32) return BitConverter.ToSingle(buf, offset);
            if (!isFloat && bits == 16) return BitConverter.ToInt16(buf, offset) / 32768.0f;
            if (!isFloat && bits == 32) return BitConverter.ToInt32(buf, offset) / 2147483648.0f;
            if (!isFloat && bits == 24) {
                int v = buf[offset] | (buf[offset + 1] << 8) | ((sbyte)buf[offset + 2] << 16);
                return v / 8388608.0f;
            }
            return 0.0f;
        }

        static void WriteInt16(byte[] buf, int offset, float sample) {
            if (sample > 1.0f) sample = 1.0f;
            else if (sample < -1.0f) sample = -1.0f;
            int scaled = (int)Math.Round(sample * 32767.0f);
            if (scaled > 32767) scaled = 32767;
            else if (scaled < -32768) scaled = -32768;
            buf[offset] = (byte)(scaled & 0xff);
            buf[offset + 1] = (byte)((scaled >> 8) & 0xff);
        }
    }
}
