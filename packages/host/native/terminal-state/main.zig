const std = @import("std");
const vt = @import("ghostty-vt");
const alloc = std.heap.wasm_allocator;
const history_rows = 1000;
const Session = struct { term: vt.Terminal, stream: vt.TerminalStream, output: std.Io.Writer.Allocating, portable: bool = true };
const Png = extern struct { width: u32, height: u32, data: ?[*]u8, len: usize };
extern "env" fn decode_png(data: [*]const u8, len: usize, out: *Png) bool;
extern "env" fn compress(data: [*]const u8, len: usize, out_len: *usize) ?[*]u8;
pub const std_options: std.Options = .{ .logFn = quietLog };
fn quietLog(comptime _: std.log.Level, comptime _: @Type(.enum_literal), comptime _: []const u8, _: anytype) void {}
fn pngDecoder(_: std.mem.Allocator, data: []const u8) vt.sys.DecodeError!vt.sys.Image {
    var out: Png = undefined;
    if (!decode_png(data.ptr, data.len, &out) or out.data == null) return error.InvalidData;
    return .{ .width = out.width, .height = out.height, .data = out.data.?[0..out.len] };
}
export fn allocate(len: usize) ?[*]u8 { return (alloc.alloc(u8,len) catch return null).ptr; }
export fn release(ptr: [*]u8, len: usize) void { alloc.free(ptr[0..len]); }
export fn create(cols: u16, rows: u16) ?*Session {
    vt.sys.decode_png = pngDecoder;
    const s = alloc.create(Session) catch return null;
    s.* = .{ .term = vt.Terminal.init(alloc, .{ .cols = cols, .rows = rows, .max_scrollback = 8 * 1024 * 1024, .kitty_image_storage_limit = 32 * 1024 * 1024 }) catch { alloc.destroy(s); return null; }, .stream = undefined, .output = .init(alloc) };
    s.term.width_px = @as(u32, cols) * 8; s.term.height_px = @as(u32, rows) * 16;
    s.stream = s.term.vtStream();
    return s;
}
export fn destroy(s: *Session) void { s.stream.deinit(); s.term.deinit(alloc); s.output.deinit(); alloc.destroy(s); }
export fn write(s: *Session, ptr: [*]const u8, len: usize) void { s.stream.nextSlice(ptr[0..len]);
    // Raw recordings remain authoritative for image addressing/geometry that
    // a portable VT bootstrap cannot reproduce across different phone fonts.
    for ([_]@TypeOf(s.term.screens.active_key){ .primary, .alternate }) |key| {
        const screen = s.term.screens.get(key) orelse continue;
        var images = screen.kitty_images.images.iterator();
        while (images.next()) |entry| {
            if (entry.value_ptr.implicit_id or entry.value_ptr.number != 0) s.portable = false;
        }
        var placements = screen.kitty_images.placements.iterator();
        while (placements.next()) |entry| {
            if (entry.value_ptr.columns == 0 or entry.value_ptr.rows == 0) s.portable = false;
        }
    }
}
export fn resize(s: *Session, cols: u16, rows: u16, cell_w: u16, cell_h: u16) bool {
    s.term.resize(alloc,cols,rows) catch return false;
    s.term.width_px = @as(u32,cols) * cell_w; s.term.height_px = @as(u32,rows) * cell_h;
    return true;
}
export fn cursor_x(s: *Session) u32 { return s.term.screens.active.cursor.x; }
export fn cursor_y(s: *Session) u32 { return s.term.screens.active.cursor.y; }
export fn image_count(s: *Session) u32 { return @intCast(s.term.screens.active.kitty_images.images.count()); }
export fn placement_count(s: *Session) u32 { return @intCast(s.term.screens.active.kitty_images.placements.count()); }
export fn image_checksum(s: *Session, id: u32) u32 { const image = s.term.screens.active.kitty_images.images.get(id) orelse return 0; return std.hash.Crc32.hash(image.data); }
export fn image_position(s: *Session, id: u32, axis: u8) i32 {
    const screen = s.term.screens.active;
    var placements = screen.kitty_images.placements.iterator();
    while (placements.next()) |entry| {
        if (entry.key_ptr.image_id != id or entry.value_ptr.location != .pin) continue;
        const p = screen.pages.pointFromPin(.screen, entry.value_ptr.location.pin.*).?.screen;
        const top = screen.pages.pointFromPin(.screen, screen.pages.getTopLeft(.active)).?.screen;
        return if (axis == 0) @intCast(p.x) else @as(i32,@intCast(p.y)) - @as(i32,@intCast(top.y));
    }
    return std.math.minInt(i32);
}
export fn keyboard_flags(s: *Session) u32 { return s.term.screens.active.kitty_keyboard.current().int(); }
export fn active_screen(s: *Session) u32 { return @intFromEnum(s.term.screens.active_key); }
export fn plain(s: *Session) ?[*]const u8 {
    s.output.deinit(); s.output = .init(alloc);
    var fmt = vt.formatter.TerminalFormatter.init(&s.term, .plain);
    fmt.format(&s.output.writer) catch return null;
    return s.output.written().ptr;
}
export fn output_len(s: *Session) usize { return s.output.written().len; }
export fn snapshot(s: *Session) ?[*]const u8 {
    if (!s.portable) return null;
    if (s.term.screens.get(.primary).?.kitty_images.loading != null) return null;
    if (s.term.screens.get(.alternate)) |screen| if (screen.kitty_images.loading != null) return null;
    s.output.deinit(); s.output = .init(alloc);
    encodeSnapshot(s, &s.output.writer) catch return null;
    return s.output.written().ptr;
}
fn encodeImage(w: *std.Io.Writer, image: vt.kitty.graphics.Image) !void {
    var compressed_len: usize = 0;
    const compressed = compress(image.data.ptr, image.data.len, &compressed_len) orelse return error.OutOfMemory;
    defer alloc.free(compressed[0..compressed_len]);
    const size = std.base64.standard.Encoder.calcSize(compressed_len);
    const buffer = try alloc.alloc(u8, size); defer alloc.free(buffer);
    const payload = std.base64.standard.Encoder.encode(buffer, compressed[0..compressed_len]);
    var offset: usize = 0;
    while (offset < payload.len) {
        const end = @min(offset + 4096, payload.len);
        try w.writeAll("\x1b_G");
        if (offset == 0) try w.print("a=t,f={d},s={d},v={d},i={d},o=z,q=2,", .{ @as(u8, if (image.format == .rgb) 24 else 32), image.width, image.height, image.id });
        try w.print("m={d};{s}\x1b\\", .{ @intFromBool(end < payload.len), payload[offset..end] });
        offset = end;
    }
}
fn encodePlacement(w: *std.Io.Writer, key: vt.kitty.graphics.ImageStorage.PlacementKey, p: vt.kitty.graphics.ImageStorage.Placement) !void {
    try w.print("\x1b_Ga=p,i={d},p={d},U={d},C=1,q=2,X={d},Y={d},x={d},y={d},w={d},h={d},c={d},r={d},z={d}\x1b\\", .{
        key.image_id, if (key.placement_id.tag == .internal) @as(u32, 0) else key.placement_id.id, @intFromBool(p.location == .virtual), p.x_offset, p.y_offset,
        p.source_x, p.source_y, p.source_width, p.source_height, p.columns, p.rows, p.z,
    });
}
fn screenExtras(w: *std.Io.Writer, screen: *vt.Screen, origin: bool, margin_top: u16, margin_left: u16) !void {
    var fmt = vt.formatter.ScreenFormatter.init(screen, .vt);
    fmt.content = .none; fmt.extra = .all; fmt.extra.cursor = false; fmt.extra.kitty_keyboard = false;
    try fmt.format(w);
    try w.writeAll("\x1b[<8u");
    // Restore the whole keyboard stack so a later pop in a running TUI works.
    for (screen.kitty_keyboard.flags[0..@as(usize,screen.kitty_keyboard.idx) + 1], 0..) |flags,i| {
        if (i == 0) try w.print("\x1b[={d};1u", .{flags.int()}) else try w.print("\x1b[>{d}u", .{flags.int()});
    }
    const y = screen.cursor.y -| (if (origin) margin_top else 0);
    const x = screen.cursor.x -| (if (origin) margin_left else 0);
    try w.print("\x1b[{d};{d}H", .{y+1,x+1});
    if (screen.cursor.pending_wrap) {
        var pin = screen.pages.pin(.{ .active = .{ .x = screen.cursor.x, .y = screen.cursor.y } }).?;
        if (pin.rowAndCell().cell.wide == .spacer_tail and pin.x > 0) pin.x -= 1;
        try w.print("\x1b[{d};{d}H", .{y+1,(pin.x -| (if (origin) margin_left else 0))+1});
        var cell = vt.formatter.PageFormatter.init(pin.node.page(), .{ .emit = .vt, .trim = false });
        cell.start_x = pin.x; cell.end_x = screen.pages.cols - 1; cell.start_y = pin.y; cell.end_y = pin.y;
        try cell.format(w);
        try fmt.format(w);
    }
}
fn encodeScreen(w: *std.Io.Writer, screen: *vt.Screen) !void {
    const pages = &screen.pages;
    const active = pages.getTopLeft(.active);
    var pin = active.up(history_rows) orelse pages.getTopLeft(.screen);
    const bottom = pages.getBottomRight(.screen).?;
    var images = screen.kitty_images.images.iterator();
    while (images.next()) |entry| try encodeImage(w,entry.value_ptr.*);
    var placements = screen.kitty_images.placements.iterator();
    while (placements.next()) |entry| if (entry.value_ptr.location == .virtual) { try encodePlacement(w,entry.key_ptr.*,entry.value_ptr.*); };
    var first = true; var wrapped = false;
    while (true) {
        if (!first) try w.writeAll(if (wrapped) " \x08" else "\r\n");
        first = false;
        placements = screen.kitty_images.placements.iterator();
        while (placements.next()) |entry| {
            const place = entry.value_ptr.*;
            if (place.location != .pin) continue;
            const location = place.location.pin.*;
            if (location.node != pin.node or location.y != pin.y) continue;
            try w.print("\x1b[{d}G", .{location.x + 1});
            try encodePlacement(w,entry.key_ptr.*,place);
            try w.writeByte('\r');
        }
        var fmt = vt.formatter.PageFormatter.init(pin.node.page(), .{ .emit = .vt, .trim = false });
        fmt.start_y = pin.y; fmt.end_y = pin.y;
        const tail = try fmt.formatWithState(w);
        wrapped = pin.rowAndCell().row.wrap;
        if (wrapped) for (0..tail.cells) |_| try w.writeByte(' ');
        if (pin.node == bottom.node and pin.y == bottom.y) break;
        pin = pin.down(1) orelse break;
    }
    try screenExtras(w,screen,false,0,0);
    if (screen.saved_cursor) |saved| {
        // DECSC belongs to the screen, including a primary screen behind a TUI.
        var copy = screen.*;
        copy.cursor.x = saved.x; copy.cursor.y = saved.y; copy.cursor.style = saved.style;
        copy.cursor.protected = saved.protected; copy.cursor.pending_wrap = saved.pending_wrap; copy.charset = saved.charset;
        if (saved.origin) try w.writeAll("\x1b[?6h");
        try screenExtras(w,&copy,false,0,0);
        try w.writeAll("\x1b7");
        if (saved.origin) try w.writeAll("\x1b[?6l");
        try screenExtras(w,screen,false,0,0);
    }
}
fn encodeSnapshot(s: *Session, w: *std.Io.Writer) !void {
    try w.writeAll("\x1bc\x1b[3J");
    try encodeScreen(w, s.term.screens.get(.primary).?);
    if (s.term.screens.get(.alternate)) |alternate| {
        if (s.term.screens.active_key == .alternate and s.term.modes.get(.alt_screen_save_cursor_clear_enter)) {
            try w.writeAll("\x1b[?1049h");
        } else if (s.term.screens.active_key == .alternate and s.term.modes.get(.alt_screen)) {
            try w.writeAll("\x1b[?1047h");
        } else try w.writeAll("\x1b[?47h");
        try w.writeAll("\x1b[2J\x1b[H\x1b[0m");
        try encodeScreen(w, alternate);
        if (s.term.screens.active_key == .primary) try w.writeAll("\x1b[?47l");
    }
    var copy = s.term;
    copy.modes.set(.alt_screen_legacy,false); copy.modes.set(.alt_screen,false);
    copy.modes.set(.alt_screen_save_cursor_clear_enter,false); copy.modes.set(.synchronized_output,false);
    var fmt = vt.formatter.TerminalFormatter.init(&copy,.vt);
    fmt.content = .none; fmt.extra = .all; fmt.extra.screen = .none; fmt.extra.palette = false;
    try fmt.format(w);
    var palette = s.term.colors.palette.mask.iterator(.{});
    while (palette.next()) |idx| {
        const rgb = s.term.colors.palette.current[idx];
        try w.print("\x1b]4;{d};rgb:{x:0>2}/{x:0>2}/{x:0>2}\x1b\\", .{idx,rgb.r,rgb.g,rgb.b});
    }
    inline for (.{ .{10,s.term.colors.foreground}, .{11,s.term.colors.background}, .{12,s.term.colors.cursor} }) |entry| {
        if (entry[1].override) |rgb| try w.print("\x1b]{d};rgb:{x:0>2}/{x:0>2}/{x:0>2}\x1b\\", .{entry[0],rgb.r,rgb.g,rgb.b});
    }
    const cursor_style: u8 = switch (s.term.screens.active.cursor.cursor_style) { .bar => 5, .underline => 3, .block,.block_hollow => 1 };
    try w.print("\x1b[{d} q", .{cursor_style + @as(u8,@intFromBool(!s.term.modes.get(.cursor_blinking)))});
    try screenExtras(w,s.term.screens.active,s.term.modes.get(.origin),s.term.scrolling_region.top,s.term.scrolling_region.left);
}
