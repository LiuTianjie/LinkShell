import ExpoModulesCore

public class LinkTerminalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LinkTerminal")

    View(LinkTerminalView.self) {
      Events("onInput", "onResize")

      Prop("theme") { (view: LinkTerminalView, theme: [String: String]) in
        view.setTheme(theme)
      }
      Prop("fontSize") { (view: LinkTerminalView, size: Double) in
        view.setFontSize(size)
      }

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
