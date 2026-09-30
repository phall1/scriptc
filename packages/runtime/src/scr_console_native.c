#include "scr_runtime.h"
#include <stdlib.h>
#include <string.h>

/* Stored console methods use the same native rendering as direct output.
 * Reflection, mutation, and further Console APIs remain explicit boundaries. */
static SCR_TL ScrDyn *scr_console_methods[5];
static SCR_TL bool scr_console_registered;
static void scr_console_methods_cleanup(void) {
  for (size_t i = 0; i < 5; i++) {
    ScrDyn *method = scr_console_methods[i];
    scr_console_methods[i] = NULL;
    scr_dyn_release(method);
  }
}

static ScrDyn *scr_console_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  if (argc > 1 && args[0]->kind == SCR_DYN_STR) {
    ScrStr *format = args[0]->v.str;
    for (size_t i = 0; i + 1 < format->len; i++) if (format->data[i] == '%' &&
        strchr("sdifjoOc%", format->data[i + 1])) {
      static const char message[] = "Format strings through stored console methods have no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
  }
  ScrLogArg *rendered = argc ? calloc(argc, sizeof *rendered) : NULL;
  if (argc && !rendered) scr_trap("scriptc: out of memory\n");
  size_t count = 0;
  for (; count < argc; count++) {
    rendered[count].tag = SCR_ARG_STR;
    rendered[count].v.s = scr_insp_dyn_s(args[count], 2);
    if (scr_exc_pending()) break;
  }
  if (!scr_exc_pending()) {
    if (scr_box_get_f64(closure->caps[0]) != 0) scr_console_error(argc, rendered);
    else scr_console_log(argc, rendered);
  }
  for (size_t i = 0; i < argc; i++) scr_str_release(rendered[i].v.s);
  free(rendered);
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

static void *scr_console_retain(void *ptr) { return ptr; }
static void scr_console_release(void *ptr) { (void)ptr; }
static bool scr_console_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr; (void)key; (void)len; (void)value;
  static const char message[] = "Mutating the native console has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return false;
}
static ScrDyn *scr_console_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  const char *names[] = {"log", "info", "debug", "error", "warn"};
  for (size_t i = 0; i < 5; i++) if (strlen(names[i]) == len && memcmp(names[i], key, len) == 0) {
    if (!scr_console_methods[i]) {
      ScrClosure *closure = scr_closure_new(NULL, 1);
      closure->caps[0] = scr_box_new(SCR_BOX_F64);
      scr_box_set_f64(closure->caps[0], i >= 3 ? 1 : 0);
      scr_console_methods[i] = scr_dyn_new_func(closure, scr_console_method_call, 0, "", names[i]);
    }
    return scr_dyn_retain(scr_console_methods[i]);
  }
  static const char *unsupported[] = {"Console", "assert", "clear", "count", "countReset", "dir", "dirxml", "group", "groupCollapsed", "groupEnd", "table", "time", "timeEnd", "timeLog", "trace", "profile", "profileEnd", "timeStamp", "context", "_stdout", "_stderr"};
  for (size_t i = 0; i < sizeof unsupported / sizeof unsupported[0]; i++)
    if (strlen(unsupported[i]) == len && memcmp(unsupported[i], key, len) == 0) {
      static const char message[] = "This stored console member has no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
  return scr_dyn_retain(scr_dyn_undefined());
}
static ScrDyn *scr_console_invoke(void *ptr, ScrDyn *self, const char *key, ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  ScrDyn *method = scr_console_get(ptr, key, strlen(key));
  if (!method) return NULL;
  ScrDyn *result = scr_dyn_call(method, args, argc, what);
  scr_dyn_release(method);
  return result;
}
ScrDyn *scr_console_native(void) {
  static const ScrDynHandleOps ops = {"console", scr_console_retain, scr_console_release, scr_console_invoke, scr_console_get, scr_console_set, NULL, NULL};
  if (!scr_console_registered) {
    scr_console_registered = true;
    scr_atexit(scr_console_methods_cleanup);
  }
  scr_dyn_handle_install(SCR_DYNH_CONSOLE, &ops);
  return scr_dyn_new_handle(&scr_console_registered, SCR_DYNH_CONSOLE);
}

/* Only programs that expose a stored global need its console provider.
 * Keep the core builtin unit independent of optional inspection code. */
ScrDyn *scr_global_native(ScrArr *known) {
  return scr_global_native_init(known, scr_console_native);
}
