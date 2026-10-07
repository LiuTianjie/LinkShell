import type { ContentInsets } from "./adaptive-insets";

export const hasSideToolbar = (insets: ContentInsets) => Math.max(insets.left, insets.right) >= 80;

export function homeUsesInlineControls(systemInsets: ContentInsets, split: boolean, detailVisible: boolean) {
  return !split && !detailVisible && !hasSideToolbar(systemInsets);
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
