#ifndef LINKSHELL_NATIVE_SHIM_H
#define LINKSHELL_NATIVE_SHIM_H

// Node-API, as Electron's main process provides it. Only these declarations are needed; the
// symbols resolve against the process that loads the module (-undefined dynamic_lookup).

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_ref__ *napi_ref;
typedef struct napi_callback_info__ *napi_callback_info;
typedef struct napi_threadsafe_function__ *napi_threadsafe_function;
typedef int napi_status;

typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);
typedef void (*napi_finalize)(napi_env env, void *data, void *hint);
typedef void (*napi_threadsafe_function_call_js)(napi_env env, napi_value js_callback, void *context, void *data);

typedef enum { napi_tsfn_nonblocking = 0, napi_tsfn_blocking = 1 } napi_threadsafe_function_call_mode;
typedef enum { napi_tsfn_release = 0, napi_tsfn_abort = 1 } napi_threadsafe_function_release_mode;

typedef enum {
  napi_undefined, napi_null, napi_boolean, napi_number, napi_string, napi_symbol, napi_object, napi_function, napi_external, napi_bigint
} napi_valuetype;

napi_status napi_get_cb_info(napi_env env, napi_callback_info info, size_t *argc, napi_value *argv, napi_value *this_arg, void **data);
napi_status napi_typeof(napi_env env, napi_value value, napi_valuetype *result);
napi_status napi_get_value_string_utf8(napi_env env, napi_value value, char *buf, size_t bufsize, size_t *result);
napi_status napi_get_value_bool(napi_env env, napi_value value, bool *result);
napi_status napi_get_value_double(napi_env env, napi_value value, double *result);
napi_status napi_get_buffer_info(napi_env env, napi_value value, void **data, size_t *length);
napi_status napi_create_string_utf8(napi_env env, const char *str, size_t length, napi_value *result);
napi_status napi_get_boolean(napi_env env, bool value, napi_value *result);
napi_status napi_get_undefined(napi_env env, napi_value *result);
napi_status napi_get_global(napi_env env, napi_value *result);
napi_status napi_get_named_property(napi_env env, napi_value object, const char *utf8name, napi_value *result);
napi_status napi_create_function(napi_env env, const char *utf8name, size_t length, napi_callback cb, void *data, napi_value *result);
napi_status napi_set_named_property(napi_env env, napi_value object, const char *utf8name, napi_value value);
napi_status napi_call_function(napi_env env, napi_value recv, napi_value func, size_t argc, const napi_value *argv, napi_value *result);
napi_status napi_throw_error(napi_env env, const char *code, const char *msg);
napi_status napi_create_threadsafe_function(napi_env env, napi_value func, napi_value async_resource, napi_value async_resource_name,
  size_t max_queue_size, size_t initial_thread_count, void *thread_finalize_data, napi_finalize thread_finalize_cb, void *context,
  napi_threadsafe_function_call_js call_js_cb, napi_threadsafe_function *result);
napi_status napi_call_threadsafe_function(napi_threadsafe_function func, void *data, napi_threadsafe_function_call_mode is_blocking);
napi_status napi_release_threadsafe_function(napi_threadsafe_function func, napi_threadsafe_function_release_mode mode);
napi_status napi_unref_threadsafe_function(napi_env env, napi_threadsafe_function func);

/// Registers the module's exports (implemented in Swift as `linkshell_native_init`).
napi_value linkshell_native_init(napi_env env, napi_value exports);

#endif
