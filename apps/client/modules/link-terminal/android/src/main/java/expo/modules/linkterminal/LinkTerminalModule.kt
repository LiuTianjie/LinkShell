package expo.modules.linkterminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LinkTerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LinkTerminal")

    View(LinkTerminalView::class) {
      Events("onInput", "onResize", "onFile", "onError", "onModifiers", "onFontSize")

      Prop("theme") { view: LinkTerminalView, theme: Map<String, String> -> view.setTheme(theme) }
      Prop("fontSize") { view: LinkTerminalView, size: Double -> view.setFontSize(size) }

      OnViewDestroys { view: LinkTerminalView -> view.destroy() }
      AsyncFunction("key") { view: LinkTerminalView, name: String, shift: Boolean, ctrl: Boolean, alt: Boolean -> view.key(name, shift, ctrl, alt) }
      AsyncFunction("paste") { view: LinkTerminalView, text: String -> view.paste(text) }
      AsyncFunction("pasteClipboard") { view: LinkTerminalView -> view.pasteClipboard() }
      AsyncFunction("toggleCtrl") { view: LinkTerminalView -> view.toggleCtrl() }
      AsyncFunction("beginReplay") { view: LinkTerminalView, reset: Boolean -> view.beginReplay(reset) }
      AsyncFunction("replay") { view: LinkTerminalView, data: String, cols: Int, rows: Int -> view.replay(data, cols, rows) }
      AsyncFunction("endReplay") { view: LinkTerminalView -> view.endReplay() }
      AsyncFunction("write") { view: LinkTerminalView, data: String -> view.write(data) }
      AsyncFunction("reset") { view: LinkTerminalView -> view.reset() }
      AsyncFunction("finish") { view: LinkTerminalView, message: String -> view.finish(message) }
      AsyncFunction("focus") { view: LinkTerminalView -> view.showKeyboard() }
      AsyncFunction("blur") { view: LinkTerminalView -> view.hideKeyboard() }
    }
  }
}
