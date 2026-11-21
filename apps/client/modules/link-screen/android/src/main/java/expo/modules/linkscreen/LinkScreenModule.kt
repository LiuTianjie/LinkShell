package expo.modules.linkscreen

import android.view.View
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Collections
import java.util.WeakHashMap

class LinkScreenModule : Module() {
  private val activeViews = Collections.newSetFromMap(WeakHashMap<LinkScreenView, Boolean>())

  override fun definition() = ModuleDefinition {
    Name("LinkScreen")

    OnActivityEntersBackground {
      val snapshot = synchronized(activeViews) { activeViews.toList() }
      for (view in snapshot) {
        view.setApplicationActive(false)
      }
    }

    OnActivityEntersForeground {
      val snapshot = synchronized(activeViews) { activeViews.toList() }
      for (view in snapshot) {
        view.setApplicationActive(true)
      }
    }

    OnDestroy {
      val snapshot = synchronized(activeViews) {
        activeViews.toList().also { activeViews.clear() }
      }
      for (view in snapshot) {
        view.dispose()
      }
    }

    View(LinkScreenView::class) {
      Events("onState")

      Prop("url") { view: LinkScreenView, value: String? ->
        synchronized(activeViews) { activeViews.add(view) }
        view.setUrl(value ?: "")
      }

      Prop("maxFps") { view: LinkScreenView, value: Int? ->
        synchronized(activeViews) { activeViews.add(view) }
        view.setMaxFps(value ?: 120)
      }

      Prop("active", true) { view: LinkScreenView, value: Boolean ->
        synchronized(activeViews) { activeViews.add(view) }
        view.setActive(value)
      }

      Prop("audio", false) { view: LinkScreenView, value: Boolean ->
        synchronized(activeViews) { activeViews.add(view) }
        view.setAudio(value)
      }

      OnViewDestroys { view: LinkScreenView ->
        synchronized(activeViews) { activeViews.remove(view) }
        view.dispose()
      }

      GroupView<LinkScreenView> {
        AddChildView<View> { parent, child, index ->
          synchronized(activeViews) { activeViews.add(parent) }
          parent.addRnChild(child, index)
        }
        GetChildCount { parent ->
          parent.getRnChildCount()
        }
        GetChildViewAt<View> { parent, index ->
          parent.getRnChildAt(index)
        }
        RemoveChildViewAt { parent, index ->
          parent.removeRnChildAt(index)
        }
        RemoveChildView<View> { parent, child ->
          parent.removeRnChild(child)
        }
      }
    }
  }
}
