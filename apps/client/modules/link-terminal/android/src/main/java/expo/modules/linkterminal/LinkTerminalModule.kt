package expo.modules.linkterminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LinkTerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LinkTerminal")

    View(LinkTerminalView::class) {
      Events("onInput", "onResize")

      Prop("theme") { view: LinkTerminalView, theme: Map<String, String> -> view.setTheme(theme) }
      Prop("fontSize") { view: LinkTerminalView, size: Double -> view.setFontSize(size) }

      AsyncFunction("write") { view: LinkTerminalView, data: String -> view.write(data) }
      AsyncFunction("reset") { view: LinkTerminalView -> view.reset() }
      AsyncFunction("finish") { view: LinkTerminalView, message: String -> view.finish(message) }
      AsyncFunction("focus") { view: LinkTerminalView -> view.showKeyboard() }
      AsyncFunction("blur") { view: LinkTerminalView -> view.hideKeyboard() }
    }
  }
}
