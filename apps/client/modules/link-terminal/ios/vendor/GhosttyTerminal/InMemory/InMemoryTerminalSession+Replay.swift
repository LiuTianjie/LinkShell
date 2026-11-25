import GhosttyKit
extension InMemoryTerminalSession {
    public func resizeGrid(columns: UInt32, rows: UInt32) {
        guard let surface = currentSurface else { return }
        waitForPendingOutput()
        applyGridSize(columns: columns, rows: rows)
    }

    /// Applies grid dimensions directly on the current surface after callers have already drained output off-main.
    public func applyGridSize(columns: UInt32, rows: UInt32) {
        guard let surface = currentSurface else { return }
        let size = ghostty_surface_size(surface)
        ghostty_surface_set_size(surface, columns * size.cell_width_px, rows * size.cell_height_px)
    }
}
