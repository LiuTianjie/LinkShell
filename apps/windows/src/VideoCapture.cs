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
            bounds = System.Windows.Forms.Screen.FromPoint(center).Bounds;
            int w = Math.Max(2, Math.Min(3840, canvasWidth) / 2 * 2), h = Math.Max(2, Math.Min(2160, canvasHeight) / 2 * 2);
            string source = "gfxcapture=hwnd=" + hwnd + ":capture_border=1:capture_cursor=0:width=" + w + ":height=" + h + ":resize_mode=crop:max_framerate=" + Math.Max(1, Math.Min(60, fps)) + ",";
            RunVideo(w, h, fps, bitrate, executable, source);
        }

        static void CaptureVideo(int screen, int width, int fps, int bitrate, string executable) {
            bounds = Display(screen);
            if (!Path.IsPathRooted(executable) || !File.Exists(executable)) throw new ArgumentException("Windows 视频组件缺失");
            fps = Math.Max(1, Math.Min(60, fps));
            bitrate = Math.Max(300000, Math.Min(12000000, bitrate));
            // Level 4.2 fits 1080p60; never upscale or claim a higher profile than the SDP offers.
            double scale = Math.Min(1, Math.Min(Math.Max(320, Math.Min(1920, width)) / (double)bounds.Width, 1080.0 / bounds.Height));
            int w = Math.Max(2, (int)(bounds.Width * scale) / 2 * 2), h = Math.Max(2, (int)(bounds.Height * scale) / 2 * 2);
            uint vendor; int output = DesktopDuplication.VideoOutput(bounds, out vendor);
            RunVideo(w, h, fps, bitrate, executable, "ddagrab=output_idx=" + output + ":framerate=" + fps + ":draw_mouse=0,", vendor);
        }

        static void RunVideo(int w, int h, int fps, int bitrate, string executable, string source, uint vendor = 0) {
            if (!Path.IsPathRooted(executable) || !File.Exists(executable)) throw new ArgumentException("Windows 视频组件缺失");
            fps = Math.Max(1, Math.Min(60, fps));
            bitrate = Math.Max(300000, Math.Min(12000000, bitrate));
            if (vendor == 0) { uint found; DesktopDuplication.VideoOutput(bounds, out found); vendor = found; }
            string preferred = vendor == 0x1002 ? "h264_amf" : vendor == 0x10de ? "h264_nvenc" : vendor == 0x8086 ? "h264_qsv" : "h264_mf";
            string selected = Environment.GetEnvironmentVariable("LINKSHELL_WINDOWS_ENCODER");
            var encoders = String.IsNullOrEmpty(selected) ? new[] { preferred, "h264_mf" }.Distinct().ToArray() : new[] { selected };
            if (encoders.Any(e => !new[] { "h264_amf", "h264_nvenc", "h264_qsv", "h264_mf" }.Contains(e))) throw new ArgumentException("未知 Windows 硬件编码器");
            var input = new Thread(() => { try { while (Console.ReadLine() != null) {} } finally { ended = true; } });
            input.IsBackground = true; input.Start();
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new InvalidOperationException("无法保护视频进程生命周期");
            try {
                var limits = new JobLimits { Basic = new BasicLimits { Flags = 0x2000 } }; // KILL_ON_JOB_CLOSE, including a killed helper.
                if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits)))) throw new InvalidOperationException("无法配置视频进程生命周期");
                // Each attempt: an encoder, and whether frames are converted on the CPU on their way to it.
                var attempts = new List<KeyValuePair<string, bool>>();
                foreach (var encoder in encoders) {
                    if (encoder != "h264_mf") attempts.Add(new KeyValuePair<string, bool>(encoder, false));
                    attempts.Add(new KeyValuePair<string, bool>(encoder, true));
                }
                // What made pictures last time goes first (the host remembers it): a driver that
                // refuses the zero-copy path refuses it every time, at an FFmpeg launch each.
                string hint = Environment.GetEnvironmentVariable("LINKSHELL_WINDOWS_VIDEO_HINT");
                int known = String.IsNullOrEmpty(hint) ? -1 : attempts.FindIndex(a => a.Key + (a.Value ? ":compatible" : ":native") == hint);
                if (known > 0) { var first = attempts[known]; attempts.RemoveAt(known); attempts.Insert(0, first); }
                using (var destination = Console.OpenStandardOutput()) {
                    foreach (var attempt in attempts) {
                        if (ended) return;
                        EnsureDesktop();
                        if (RunVideoEncoder(job, destination, executable, source, w, h, fps, bitrate, attempt.Key, attempt.Value)) return;
                    }
                }
                if (!ended) throw new InvalidOperationException("这台电脑的硬件视频编码不可用，将使用兼容画面");
            } finally { CloseHandle(job); }
        }

        static bool RunVideoEncoder(IntPtr job, Stream destination, string executable, string source, int width, int height, int fps, int bitrate, string encoder, bool compatible) {
            string filter = source;
            // Older drivers reject D3D11_BIND_VIDEO_ENCODER surfaces. Use the vendor's scaler
            // where available, then allow CPU conversion while retaining hardware encoding.
            if (compatible) filter += "hwdownload,format=bgra,scale=" + width + ":" + height + ":flags=fast_bilinear,format=nv12";
            else if (encoder == "h264_amf") filter += "vpp_amf=w=" + width + ":h=" + height + ":format=nv12";
            else if (encoder == "h264_qsv") filter += "hwmap=derive_device=qsv,vpp_qsv=w=" + width + ":h=" + height + ":format=nv12";
            else filter += "scale_d3d11=width=" + width + ":height=" + height + ":format=bgra";
            string tuning = encoder == "h264_amf" ? "-usage ultralowlatency -quality speed -rc cbr -async_depth 1 -header_spacing 1 -preanalysis 0 -forced_idr 1" :
                encoder == "h264_nvenc" ? "-preset p1 -tune ull -rc cbr -zerolatency 1 -delay 0 -rc-lookahead 0" :
                encoder == "h264_qsv" ? "-preset veryfast -async_depth 1 -look_ahead 0" : "-hw_encoding 1 -scenario display_remoting";
            string args = "-hide_banner -loglevel warning -nostats -f lavfi -i \"" + filter + "\" -an -c:v " + encoder + " " + tuning +
                // Level 4.2 stops at 1080p; a Fusion window's canvas is its monitor, up to 4K (5.1).
                (encoder == "h264_nvenc" ? " -profile:v baseline -level:v " + (width * height > 2088960 ? "5.1" : "4.2") : encoder == "h264_amf" ? " -profile:v constrained_baseline -level:v " + (width * height > 2088960 ? "51" : "42") : " -profile:v 66 -level:v " + (width * height > 2088960 ? "51" : "42")) + " -bf 0 -g " + fps + " -b:v " + bitrate + " -maxrate " + bitrate + " -bufsize " + (bitrate / 4) +
                " -force_key_frames \"expr:gte(t,n_forced)\" -fps_mode passthrough -bsf:v h264_metadata=aud=insert -flush_packets 1 -f h264 pipe:1";
            using (var process = new Process()) {
                process.StartInfo = new ProcessStartInfo(executable, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
                process.ErrorDataReceived += (sender, e) => { if (e.Data != null) Console.Error.WriteLine("[video:" + encoder + "] " + e.Data); };
                process.Start();
                if (!AssignProcessToJobObject(job, process.Handle)) { process.Kill(); throw new InvalidOperationException("无法绑定视频进程生命周期"); }
                Console.Error.WriteLine("[video] child=" + process.Id);
                process.BeginErrorReadLine();
                int received = 0;
                var copy = Task.Run(() => {
                    var buffer = new byte[65536]; int count;
                    while ((count = process.StandardOutput.BaseStream.Read(buffer, 0, buffer.Length)) > 0) {
                        if (Interlocked.Exchange(ref received, 1) == 0) Console.Error.WriteLine("[video] encoder=" + encoder + " width=" + width + " height=" + height + " fps=" + fps + " path=" + (compatible ? "compatible" : "native"));
                        destination.Write(buffer, 0, count); destination.Flush();
                    }
                });
                try {
                    var clock = Stopwatch.StartNew();
                    while (!ended && !process.WaitForExit(50)) {
                        EnsureDesktop();
                        if (DisplayFromCacheChanged()) throw new InvalidOperationException("屏幕布局已改变，请重新连接");
                        if (copy.IsFaulted) throw copy.Exception;
                        if (received == 0 && clock.ElapsedMilliseconds > 5000) break;
                    }
                } finally {
                    if (!process.HasExited) { try { process.StandardInput.WriteLine("q"); } catch {} if (!process.WaitForExit(500)) process.Kill(); }
                    process.WaitForExit();
                    if (!copy.Wait(2000)) throw new IOException("视频输出没有关闭");
                }
                if (ended) return true;
                if (received != 0) throw new InvalidOperationException("硬件视频编码已停止");
                return false;
            }
        }

        static bool DisplayFromCacheChanged() {
            // Bounds matching also rejects removal or a rotation while this helper owns a capture.
            return !System.Windows.Forms.Screen.AllScreens.Any(s => s.Bounds == bounds);
        }
    }
}
