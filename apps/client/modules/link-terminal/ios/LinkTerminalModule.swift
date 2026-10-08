import ExpoModulesCore

public class LinkTerminalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LinkTerminal")

    View(LinkTerminalView.self) {
      Events("onInput", "onResize", "onFile", "onError", "onModifiers", "onFontSize")

      Prop("theme") { (view: LinkTerminalView, theme: [String: String]) in
        view.setTheme(theme)
      }
      Prop("fontSize") { (view: LinkTerminalView, size: Double) in
        view.setFontSize(size)
      }

      AsyncFunction("key") { (view: LinkTerminalView, name: String, shift: Bool, ctrl: Bool, alt: Bool) in view.key(name, shift, ctrl, alt) }.runOnQueue(.main)
      AsyncFunction("paste") { (view: LinkTerminalView, text: String) in view.paste(text) }.runOnQueue(.main)
      AsyncFunction("pasteClipboard") { (view: LinkTerminalView) in view.pasteClipboard() }.runOnQueue(.main)
      AsyncFunction("toggleCtrl") { (view: LinkTerminalView) in view.toggleCtrl() }.runOnQueue(.main)
      AsyncFunction("beginReplay") { (view: LinkTerminalView, reset: Bool) in view.beginReplay(reset) }.runOnQueue(.main)
      AsyncFunction("replay") { (view: LinkTerminalView, data: String, cols: Int, rows: Int) in view.replay(data, cols, rows) }.runOnQueue(.main)
      AsyncFunction("endReplay") { (view: LinkTerminalView) in view.endReplay() }.runOnQueue(.main)
      AsyncFunction("write") { (view: LinkTerminalView, data: String) in
        view.write(data)
      }.runOnQueue(.main)
      AsyncFunction("reset") { (view: LinkTerminalView) in
        view.reset()
      }.runOnQueue(.main)
      AsyncFunction("finish") { (view: LinkTerminalView, message: String) in
        view.write(message)
      }.runOnQueue(.main)
      AsyncFunction("focus") { (view: LinkTerminalView) in
        view.focus()
      }.runOnQueue(.main)
      AsyncFunction("blur") { (view: LinkTerminalView) in
        view.blur()
      }.runOnQueue(.main)
    }
  }
}
