import { SCREEN_LOADING_SCRIPT } from "./screen-loading.js";
import { AUDIO_SCRIPT } from "./screen-viewer/audio-script.js";
import { CLIENT_PREAMBLE_SCRIPT } from "./screen-viewer/client-script.js";
import { SCREEN_IDLE, SCREEN_TAKEN } from "./screen-viewer/constants.js";
import { CONTROLS_SCRIPT } from "./screen-viewer/controls-script.js";
import { renderViewerHtml } from "./screen-viewer/html.js";
import { VIEWER_LOGIC } from "./screen-viewer/logic.js";
import { PANELS_SCRIPT } from "./screen-viewer/panels-script.js";
import { WEBRTC_SCRIPT } from "./screen-viewer/webrtc-script.js";

export { SCREEN_IDLE, SCREEN_TAKEN, VIEWER_LOGIC };

const BODY = `${CLIENT_PREAMBLE_SCRIPT}\n${AUDIO_SCRIPT}\n${WEBRTC_SCRIPT}\n${CONTROLS_SCRIPT}\n${PANELS_SCRIPT}`;
const SCRIPT = `(() => {const SCREEN_TAKEN = ${JSON.stringify(SCREEN_TAKEN)};const SCREEN_IDLE = ${JSON.stringify(SCREEN_IDLE)};${VIEWER_LOGIC}${SCREEN_LOADING_SCRIPT}${BODY}})();`;

/** Generates the standalone HTML document served to remote screen viewers. */
export function viewerPage(platform: NodeJS.Platform = "darwin", locale: "zh" | "en" | "ja" = "zh"): string {
  return renderViewerHtml(platform, locale, SCRIPT);
}
