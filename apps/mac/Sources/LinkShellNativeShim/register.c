#include "LinkShellNativeShim.h"

// Node-API's module registration: Node looks up this symbol when it loads the .node file.
__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  return linkshell_native_init(env, exports);
}

__attribute__((visibility("default"))) int32_t node_api_module_get_api_version_v1(void) { return 8; }
