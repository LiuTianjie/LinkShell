const std = @import("std");
pub fn build(b: *std.Build) void {
    const target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .freestanding });
    const dep = b.dependency("ghostty", .{ .target = target, .optimize = .ReleaseFast, .simd = false });
    const module = b.createModule(.{ .root_source_file = b.path("main.zig"), .target = target, .optimize = .ReleaseFast });
    module.single_threaded = true;
    module.strip = true;
    dep.module("ghostty-vt").single_threaded = true;
    module.addImport("ghostty-vt", dep.module("ghostty-vt"));
    const exe = b.addExecutable(.{ .name = "terminal-state", .root_module = module });
    exe.entry = .disabled;
    exe.rdynamic = true;
    b.installArtifact(exe);
}
