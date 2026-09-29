/* Native builtin export objects. The compiler supplies the existing static
 * callable implementations; this unit owns lookup, identity, and mutations. */
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>
#include <math.h>

static SCR_TL ScrDyn *scr_global_known;
static SCR_TL bool scr_global_cleanup_registered;

static void scr_global_cleanup(void) {
  scr_dyn_release(scr_global_known);
  scr_global_known = NULL;
}

static void *scr_global_retain(void *handle) { return handle; }
static void scr_global_release(void *handle) { (void)handle; }

static ScrDyn *scr_global_get(void *handle, const char *key, size_t length) {
  (void)handle;
  if ((length == 10 && memcmp(key, "globalThis", length) == 0) ||
      (length == 6 && memcmp(key, "global", length) == 0))
    return scr_dyn_new_handle(&scr_global_known, SCR_DYNH_GLOBAL);
  if (length == 9 && memcmp(key, "undefined", length) == 0) return scr_dyn_undefined();
  if (length == 3 && memcmp(key, "NaN", length) == 0) return scr_dyn_new_num(NAN);
  if (length == 8 && memcmp(key, "Infinity", length) == 0) return scr_dyn_new_num(INFINITY);
  if (!scr_dyn_obj_get(scr_global_known, key, length)) return scr_dyn_undefined();
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_puts(&text, "reading globalThis.");
  for (size_t i = 0; i < length; i++) scr_jb_putc(&text, key[i]);
  scr_jb_puts(&text, " through a stored global object is not supported yet [SC2020]");
  ScrStr *message = scr_jb_finish(&text);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
  scr_str_release(message);
  return NULL;
}

ScrDyn *scr_global_native(ScrArr *known) {
  static const ScrDynHandleOps ops = {
    .cls = "Object", .retain = scr_global_retain, .release = scr_global_release,
    .get = scr_global_get,
  };
  scr_dyn_handle_install(SCR_DYNH_GLOBAL, &ops);
  if (!scr_global_known) scr_global_known = scr_dyn_new_obj();
  if (!scr_global_cleanup_registered) {
    scr_atexit(scr_global_cleanup);
    scr_global_cleanup_registered = true;
  }
  for (size_t i = 0; i < known->len; i++) {
    ScrStr *key = (ScrStr *)scr_arr_get_ref(known, (double)i);
    if (!scr_dyn_obj_get(scr_global_known, key->data, key->len))
      scr_dyn_obj_set(scr_global_known, key->data, key->len, scr_dyn_new_bool(true));
    scr_str_release(key);
  }
  return scr_dyn_new_handle(&scr_global_known, SCR_DYNH_GLOBAL);
}

typedef struct ScrBuiltinModule {
  size_t rc;
  ScrStr *id;
  ScrDyn *getter;
  ScrDyn *exports;
  struct ScrBuiltinModule *next;
} ScrBuiltinModule;

static SCR_TL ScrBuiltinModule *scr_builtin_modules;
static SCR_TL bool scr_builtin_cleanup_registered;

static void *scr_builtin_retain(void *handle) {
  ScrBuiltinModule *module = handle;
  module->rc++;
  return module;
}

static void scr_builtin_release(void *handle) {
  ScrBuiltinModule *module = handle;
  if (--module->rc) return;
  scr_str_release(module->id);
  scr_dyn_release(module->getter);
  scr_dyn_release(module->exports);
  free(module);
}

static void scr_builtin_cleanup(void) {
  while (scr_builtin_modules) {
    ScrBuiltinModule *module = scr_builtin_modules;
    scr_builtin_modules = module->next;
    scr_builtin_release(module);
  }
}

static ScrDyn *scr_builtin_get(void *handle, const char *key, size_t length) {
  ScrBuiltinModule *module = handle;
  ScrDyn *cached = scr_dyn_obj_get(module->exports, key, length);
  if (cached) return scr_dyn_retain(cached);
  ScrStr *name = scr_str_new(key, length);
  ScrDyn *arg = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *result = scr_dyn_call(module->getter, &arg, 1, "builtin export");
  scr_dyn_release(arg);
  if (!result) return NULL;
  // Nested path aliases are handles rooted in the registry. Caching them
  // would add path.posix/path.win32 cycles to the reference-counted graph.
  if (!(result->kind == SCR_DYN_HANDLE && result->v.handle.tag == SCR_DYNH_BUILTIN_MODULE))
    scr_dyn_obj_set(module->exports, key, length, scr_dyn_retain(result));
  return result;
}

static bool scr_builtin_set(void *handle, const char *key, size_t length, const ScrDyn *value) {
  ScrBuiltinModule *module = handle;
  scr_dyn_obj_set(module->exports, key, length, scr_dyn_retain((ScrDyn *)value));
  return true;
}

static ScrDyn *scr_builtin_invoke(void *handle, ScrDyn *self, const char *key,
                                ScrDyn *const *args, size_t argc, const char *what) {
  ScrDyn *fn = scr_builtin_get(handle, key, strlen(key));
  if (!fn) return NULL;
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(fn, args, argc, what);
  scr_dyn_this_pop();
  scr_dyn_release(fn);
  return result;
}

ScrStr *scr_process_builtin_id(ScrDyn *id, ScrArr *known) {
  if (id->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("id", "of type string", id);
    return NULL;
  }
  ScrStr *value = id->v.str;
  bool prefix = value->len >= 5 && memcmp(value->data, "node:", 5) == 0;
  for (size_t i = 0; i < known->len; i++) {
    ScrStr *entry = (ScrStr *)scr_arr_get_ref(known, (double)i);
    bool exact = entry->len == value->len && memcmp(entry->data, value->data, value->len) == 0;
    bool prefix_only = entry->len >= 5 && memcmp(entry->data, "node:", 5) == 0;
    bool bare = prefix && !prefix_only && entry->len == value->len - 5 && memcmp(entry->data, value->data + 5, entry->len) == 0;
    scr_str_release(entry);
    if (exact || bare) return scr_str_new(value->data + (prefix ? 5 : 0), value->len - (prefix ? 5 : 0));
  }
  return scr_str_new("", 0);
}

ScrDyn *scr_process_builtin_module(ScrStr *id, ScrDyn *getter) {
  static const ScrDynHandleOps ops = {
    .cls = "Object", .retain = scr_builtin_retain, .release = scr_builtin_release,
    .get = scr_builtin_get, .set = scr_builtin_set, .invoke = scr_builtin_invoke,
  };
  scr_dyn_handle_install(SCR_DYNH_BUILTIN_MODULE, &ops);
  for (ScrBuiltinModule *module = scr_builtin_modules; module; module = module->next) {
    if (module->id->len == id->len && memcmp(module->id->data, id->data, id->len) == 0)
      return scr_dyn_new_handle(module, SCR_DYNH_BUILTIN_MODULE);
  }
  if (!scr_builtin_cleanup_registered) {
    scr_atexit(scr_builtin_cleanup);
    scr_builtin_cleanup_registered = true;
  }
  ScrBuiltinModule *module = malloc(sizeof(*module));
  if (!module) scr_trap("scriptc: out of memory\n");
  *module = (ScrBuiltinModule){ 1, scr_str_retain(id), scr_dyn_retain(getter), scr_dyn_new_obj(), scr_builtin_modules };
  scr_builtin_modules = module;
  return scr_dyn_new_handle(module, SCR_DYNH_BUILTIN_MODULE);
}

ScrDyn *scr_process_builtin_unsupported(ScrStr *id, ScrStr *member) {
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_puts(&text, "native builtin '");
  for (size_t i = 0; i < id->len; i++) scr_jb_putc(&text, id->data[i]);
  if (member->len) {
    scr_jb_putc(&text, '.');
    for (size_t i = 0; i < member->len; i++) scr_jb_putc(&text, member->data[i]);
  }
  scr_jb_puts(&text, "' is not supported through process.getBuiltinModule yet [SC2020]");
  ScrStr *message = scr_jb_finish(&text);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
  scr_str_release(message);
  return NULL;
}
