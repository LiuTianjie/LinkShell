import type { ContentInsets } from "./adaptive-insets";

export const hasSideToolbar = (insets: ContentInsets) => Math.max(insets.left, insets.right) >= 80;

/**
 * Custom toolbar views (`UIBarButtonItem(customView:)`) cannot enter iPhone Duo's vertical side bar
 * and force UIKit to mount an auxiliary full-width top bar; keep native button items on side toolbars.
 */
export function usesCustomLiveToolbarItem(platform: string, systemInsets: ContentInsets, live?: boolean) {
  return platform === "ios" && live !== undefined && !hasSideToolbar(systemInsets);
}

export function homeUsesInlineControls(systemInsets: ContentInsets, detailVisible: boolean) {
  // A fold report can briefly change `split`; an empty list still has no native title or actions.
  return !detailVisible && !hasSideToolbar(systemInsets);
}

/** Keep native header geometry stable while a rotated frame waits for its hinge report. */
export function homeNavigationLayout(pageInsets: ContentInsets, systemInsets: ContentInsets, headerHeight: number, headerVisible = true) {
  // A Duo side bar reserves 84pt; recent iPhones reserve 62pt for landscape cameras.
  // Read the unconsumed system insets: AdaptivePage has already removed the side bar.
  const sideBar = hasSideToolbar(systemInsets);
  return {
    headerTransparent: true as const,
    contentTop: !headerVisible ? Math.max(pageInsets.top, systemInsets.top) : sideBar ? pageInsets.top : Math.max(pageInsets.top, headerHeight),
  };
}
