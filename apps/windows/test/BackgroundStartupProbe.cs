using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
class BackgroundStartupProbe {
    [StructLayout(LayoutKind.Sequential)] struct StartupInfo {
        public uint cb; public IntPtr reserved, desktop, title;
        public uint x, y, width, height, xChars, yChars, fill, flags;
        public ushort show, reservedSize;
        public IntPtr reservedData, input, output, error;
    }
    [DllImport("kernel32.dll", EntryPoint="GetStartupInfoW")] static extern void GetStartupInfo(out StartupInfo info);
    static void Main(string[] args) {
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        Console.InputEncoding = new System.Text.UTF8Encoding(false);
        StartupInfo startup; GetStartupInfo(out startup);
        var json = new JavaScriptSerializer();
        string mode = Array.IndexOf(args, "--mcp") >= 0 ? "mcp" : Array.IndexOf(args, "--terminal") >= 0 ? "terminal" : "git";
        File.AppendAllText(Environment.GetEnvironmentVariable("LINKSHELL_QA_STARTUP_LOG"), json.Serialize(new { mode, hidden = (startup.flags & 1) != 0 && startup.show == 0, flags = startup.flags, show = startup.show }) + "\n");
        if (mode == "terminal") { Console.WriteLine("TERMINAL_READY"); return; }
        if (mode == "mcp") {
            string line;
            while ((line = Console.ReadLine()) != null) {
                var request = json.Deserialize<Dictionary<string, object>>(line);
                if (request.ContainsKey("id")) Console.WriteLine(json.Serialize(new { jsonrpc = "2.0", id = request["id"], result = new { tools = new object[0] } }));
            }
            return;
        }
        if (Array.IndexOf(args, "symbolic-ref") >= 0) Console.WriteLine("qa-main");
        else if (Array.IndexOf(args, "--show-toplevel") >= 0) Console.WriteLine(args[Array.IndexOf(args, "-C") + 1]);
        else if (Array.IndexOf(args, "rev-parse") >= 0) Console.WriteLine("123abcd");
    }
}
