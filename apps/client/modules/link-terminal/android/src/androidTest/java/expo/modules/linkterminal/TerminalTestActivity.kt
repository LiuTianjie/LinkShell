package expo.modules.linkterminal

import android.app.Activity
import android.os.Bundle

class TerminalTestActivity : Activity() {
  internal lateinit var terminal: GhosttyTerminalView
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    terminal = GhosttyTerminalView(this)
    setContentView(terminal)
  }
  override fun onDestroy() { terminal.destroy(); super.onDestroy() }
}
