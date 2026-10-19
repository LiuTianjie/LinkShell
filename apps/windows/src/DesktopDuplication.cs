using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace LinkShell.Windows {
    // Windows' compositor supplies a GPU texture. GDI screen reads synchronize the
    // entire desktop and can take hundreds of milliseconds on high-DPI displays.
    internal sealed class DesktopDuplication : IDisposable {
        IntPtr device, context, duplication, staging, sourceTexture, sourceView, renderTexture, renderView, vertexShader, pixelShader, sampler, rasterizer;
        uint width, height, scaledWidth, scaledHeight;
        const int WaitTimeout = unchecked((int)0x887a0027);
        static readonly Guid DxgiDevice = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
        static readonly Guid Output1 = new Guid("00cddea8-939b-4b83-a340-a685226666cc");
        static readonly Guid Texture2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");

        [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, uint driverType, IntPtr software, uint flags, IntPtr levels, uint levelCount, uint sdk, out IntPtr device, out uint level, out IntPtr context);
        [DllImport("d3dcompiler_47.dll", CharSet = CharSet.Ansi)] static extern int D3DCompile(string source, UIntPtr size, string name, IntPtr defines, IntPtr include, string entry, string profile, uint flags, uint effectFlags, out IntPtr code, out IntPtr errors);
        [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct OutputDesc {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
            public Rect DesktopCoordinates;
            public int Attached, Rotation;
            public IntPtr Monitor;
        }
        [StructLayout(LayoutKind.Sequential)] struct TextureDesc {
            public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CpuAccessFlags, MiscFlags;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct AdapterDesc {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Name;
            public uint Vendor, Device, Subsystem, Revision;
            public UIntPtr VideoMemory, SystemMemory, SharedMemory;
            public long Luid;
        }
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetAdapterDesc(IntPtr self, out AdapterDesc desc);
        [StructLayout(LayoutKind.Sequential)] struct Mapped { public IntPtr Data; public uint RowPitch, DepthPitch; }
        [StructLayout(LayoutKind.Sequential)] struct Viewport { public float X, Y, Width, Height, MinDepth, MaxDepth; }
        [StructLayout(LayoutKind.Sequential)] struct SamplerDesc {
            public uint Filter, AddressU, AddressV, AddressW; public float LodBias;
            public uint MaxAnisotropy, Comparison; public float R, G, B, A, MinLod, MaxLod;
        }
        [StructLayout(LayoutKind.Sequential)] struct RasterizerDesc {
            public uint Fill, Cull; public int FrontCcw, DepthBias; public float BiasClamp, SlopeBias;
            public int DepthClip, Scissor, Multisample, AntialiasedLine;
        }
        [StructLayout(LayoutKind.Sequential)] struct FrameInfo {
            public long LastPresent, LastMouse;
            public uint Accumulated;
            public int Coalesced, Protected, PointerX, PointerY, PointerVisible;
            public uint MetadataBytes, PointerBytes;
        }
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetAdapter(IntPtr self, out IntPtr adapter);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumOutputs(IntPtr self, uint index, out IntPtr output);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetOutputDesc(IntPtr self, out OutputDesc desc);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DuplicateOutput(IntPtr self, IntPtr device, out IntPtr duplication);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int AcquireFrame(IntPtr self, uint timeout, out FrameInfo info, out IntPtr resource);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ReleaseFrame(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void GetTextureDesc(IntPtr self, out TextureDesc desc);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTexture(IntPtr self, ref TextureDesc desc, IntPtr data, out IntPtr texture);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void CopyResource(IntPtr self, IntPtr dest, IntPtr source);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int MapResource(IntPtr self, IntPtr resource, uint subresource, uint type, uint flags, out Mapped mapped);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void UnmapResource(IntPtr self, IntPtr resource, uint subresource);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate IntPtr BlobPointer(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate UIntPtr BlobSize(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateShader(IntPtr self, IntPtr data, UIntPtr size, IntPtr linkage, out IntPtr shader);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateView(IntPtr self, IntPtr resource, IntPtr desc, out IntPtr view);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateSampler(IntPtr self, ref SamplerDesc desc, out IntPtr state);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateRasterizer(IntPtr self, ref RasterizerDesc desc, out IntPtr state);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void SetShader(IntPtr self, IntPtr shader, IntPtr instances, uint count);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void SetViews(IntPtr self, uint start, uint count, ref IntPtr view);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void SetRenderTarget(IntPtr self, uint count, ref IntPtr view, IntPtr depth);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void SetViewport(IntPtr self, uint count, ref Viewport viewport);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void SetRasterizer(IntPtr self, IntPtr state);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void SetTopology(IntPtr self, uint topology);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void Draw(IntPtr self, uint count, uint start);

        static T Method<T>(IntPtr self, int slot) where T : class {
            return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(self), slot * IntPtr.Size), typeof(T));
        }
        static void Check(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }
        static IntPtr Query(IntPtr value, Guid id) { IntPtr result; Check(Marshal.QueryInterface(value, ref id, out result)); return result; }
        static void Release(ref IntPtr value) { if (value != IntPtr.Zero) { Marshal.Release(value); value = IntPtr.Zero; } }

        // Screen.AllScreens ordering is not DXGI output ordering. Match physical bounds first.
        public static int VideoOutput(Rectangle bounds, out uint vendor) {
            IntPtr device = IntPtr.Zero, context = IntPtr.Zero, dxgi = IntPtr.Zero, adapter = IntPtr.Zero;
            vendor = 0;
            try {
                uint level;
                Check(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out level, out context));
                dxgi = Query(device, DxgiDevice); Check(Method<GetAdapter>(dxgi, 7)(dxgi, out adapter));
                AdapterDesc adapterInfo; Check(Method<GetAdapterDesc>(adapter, 8)(adapter, out adapterInfo)); vendor = adapterInfo.Vendor;
                for (uint i = 0; ; i++) {
                    IntPtr output;
                    if (Method<EnumOutputs>(adapter, 7)(adapter, i, out output) < 0) break;
                    try {
                        OutputDesc info; Check(Method<GetOutputDesc>(output, 7)(output, out info));
                        var rect = info.DesktopCoordinates;
                        if (rect.Left == bounds.Left && rect.Top == bounds.Top && rect.Right == bounds.Right && rect.Bottom == bounds.Bottom && info.Rotation == 1) return (int)i;
                    } finally { Release(ref output); }
                }
                throw new NotSupportedException("此显示器暂时使用兼容采集");
            } finally { Release(ref adapter); Release(ref dxgi); Release(ref context); Release(ref device); }
        }

        public static DesktopDuplication TryCreate(Rectangle bounds, out string reason) {
            if (Environment.GetEnvironmentVariable("LINKSHELL_SCREEN_CAPTURE") == "gdi") { reason = "selected GDI"; return null; }
            var result = new DesktopDuplication();
            try { result.Initialize(bounds); reason = null; return result; }
            catch (Exception error) { reason = error.Message; result.Dispose(); return null; }
        }
        void Initialize(Rectangle bounds) {
            uint level;
            Check(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out level, out context));
            IntPtr dxgi = IntPtr.Zero, adapter = IntPtr.Zero;
            try {
                dxgi = Query(device, DxgiDevice);
                Check(Method<GetAdapter>(dxgi, 7)(dxgi, out adapter));
                for (uint i = 0; ; i++) {
                    IntPtr output = IntPtr.Zero, output1 = IntPtr.Zero;
                    if (Method<EnumOutputs>(adapter, 7)(adapter, i, out output) < 0) break;
                    try {
                        OutputDesc desc; Check(Method<GetOutputDesc>(output, 7)(output, out desc));
                        var area = desc.DesktopCoordinates;
                        if (area.Left != bounds.Left || area.Top != bounds.Top || area.Right != bounds.Right || area.Bottom != bounds.Bottom) continue;
                        // Rotated outputs need texture rotation. Keep the correct GDI path for those.
                        if (desc.Rotation != 1) throw new NotSupportedException("旋转屏幕使用兼容采集");
                        output1 = Query(output, Output1);
                        Check(Method<DuplicateOutput>(output1, 22)(output1, device, out duplication));
                        InitializeScaler();
                        return;
                    } finally { Release(ref output1); Release(ref output); }
                }
                throw new NotSupportedException("此显示器使用兼容采集");
            } finally { Release(ref adapter); Release(ref dxgi); }
        }
        void InitializeScaler() {
            const string shader = "struct V { float4 position : SV_Position; float2 uv : TEXCOORD0; }; V Vertex(uint id : SV_VertexID) { V o; float2 p = float2(id == 2 ? 3 : -1, id == 1 ? 3 : -1); o.position = float4(p, 0, 1); o.uv = p * float2(0.5, -0.5) + 0.5; return o; } Texture2D image : register(t0); SamplerState sampling : register(s0); float4 Pixel(V i) : SV_Target { return image.SampleLevel(sampling, i.uv, 0); }";
            vertexShader = CompileShader(shader, "Vertex", "vs_4_0", 12);
            pixelShader = CompileShader(shader, "Pixel", "ps_4_0", 15);
            var sampling = new SamplerDesc { Filter = 0x15, AddressU = 3, AddressV = 3, AddressW = 3, MaxAnisotropy = 1, Comparison = 1, MaxLod = float.MaxValue };
            Check(Method<CreateSampler>(device, 23)(device, ref sampling, out sampler));
            var raster = new RasterizerDesc { Fill = 3, Cull = 1, DepthClip = 1 };
            Check(Method<CreateRasterizer>(device, 22)(device, ref raster, out rasterizer));
        }
        IntPtr CompileShader(string source, string entry, string profile, int slot) {
            IntPtr code = IntPtr.Zero, errors = IntPtr.Zero, shader;
            try {
                Check(D3DCompile(source, (UIntPtr)source.Length, "LinkShell.Screen", IntPtr.Zero, IntPtr.Zero, entry, profile, 0, 0, out code, out errors));
                Check(Method<CreateShader>(device, slot)(device, Method<BlobPointer>(code, 3)(code), Method<BlobSize>(code, 4)(code), IntPtr.Zero, out shader));
                return shader;
            } finally { Release(ref code); Release(ref errors); }
        }
        public bool CopyTo(Graphics target, int targetWidth, int targetHeight, bool force) {
            FrameInfo info; IntPtr resource;
            int result = Method<AcquireFrame>(duplication, 8)(duplication, 0, out info, out resource);
            bool changed = force;
            if (result != WaitTimeout) {
                Check(result);
                IntPtr texture = IntPtr.Zero;
                try {
                    // Pointer-only changes need no desktop texture readback.
                    if (info.LastPresent != 0 || sourceTexture == IntPtr.Zero) {
                        texture = Query(resource, Texture2D);
                        TextureDesc desc; Method<GetTextureDesc>(texture, 10)(texture, out desc);
                        if (desc.Format != 87) throw new NotSupportedException("此屏幕像素格式需要兼容采集");
                        if (sourceTexture == IntPtr.Zero || width != desc.Width || height != desc.Height) {
                            Release(ref sourceView); Release(ref sourceTexture); width = desc.Width; height = desc.Height;
                            desc.Usage = 0; desc.BindFlags = 8; desc.CpuAccessFlags = 0; desc.MiscFlags = 0;
                            Check(Method<CreateTexture>(device, 5)(device, ref desc, IntPtr.Zero, out sourceTexture));
                            Check(Method<CreateView>(device, 7)(device, sourceTexture, IntPtr.Zero, out sourceView));
                        }
                        Method<CopyResource>(context, 47)(context, sourceTexture, texture);
                        changed = true;
                    }
                } finally {
                    Release(ref texture); Release(ref resource);
                    Check(Method<ReleaseFrame>(duplication, 14)(duplication));
                }
            }
            if (sourceTexture == IntPtr.Zero) return false;
            if (scaledWidth != targetWidth || scaledHeight != targetHeight) {
                Release(ref renderView); Release(ref renderTexture); Release(ref staging);
                scaledWidth = (uint)targetWidth; scaledHeight = (uint)targetHeight;
                var desc = new TextureDesc { Width = scaledWidth, Height = scaledHeight, Format = 87, MipLevels = 1, ArraySize = 1, SampleCount = 1, BindFlags = 0x20 };
                Check(Method<CreateTexture>(device, 5)(device, ref desc, IntPtr.Zero, out renderTexture));
                Check(Method<CreateView>(device, 9)(device, renderTexture, IntPtr.Zero, out renderView));
                desc.Usage = 3; desc.BindFlags = 0; desc.CpuAccessFlags = 0x20000;
                Check(Method<CreateTexture>(device, 5)(device, ref desc, IntPtr.Zero, out staging));
                changed = true;
            }
            if (!changed) return false;
            var viewport = new Viewport { Width = targetWidth, Height = targetHeight, MaxDepth = 1 };
            Method<SetShader>(context, 11)(context, vertexShader, IntPtr.Zero, 0);
            Method<SetShader>(context, 9)(context, pixelShader, IntPtr.Zero, 0);
            Method<SetViews>(context, 8)(context, 0, 1, ref sourceView);
            Method<SetViews>(context, 10)(context, 0, 1, ref sampler);
            Method<SetRenderTarget>(context, 33)(context, 1, ref renderView, IntPtr.Zero);
            Method<SetViewport>(context, 44)(context, 1, ref viewport);
            Method<SetRasterizer>(context, 43)(context, rasterizer);
            Method<SetTopology>(context, 24)(context, 4);
            Method<Draw>(context, 13)(context, 3, 0);
            Method<CopyResource>(context, 47)(context, staging, renderTexture);
            Mapped mapped; Check(Method<MapResource>(context, 14)(context, staging, 0, 1, 0, out mapped));
            try {
                using (var bitmap = new Bitmap(targetWidth, targetHeight, (int)mapped.RowPitch, PixelFormat.Format32bppRgb, mapped.Data)) target.DrawImageUnscaled(bitmap, 0, 0);
            } finally { Method<UnmapResource>(context, 15)(context, staging, 0); }
            return true;
        }
        public void Dispose() {
            Release(ref staging); Release(ref sourceView); Release(ref sourceTexture); Release(ref renderView); Release(ref renderTexture);
            Release(ref vertexShader); Release(ref pixelShader); Release(ref sampler); Release(ref rasterizer);
            Release(ref duplication); Release(ref context); Release(ref device);
        }
    }
}
