#include "scr_runtime.h"
#include <assert.h>
#include <stdio.h>

static void put(ScrDyn *map, ScrDyn *key, ScrDyn *value) {
  ScrDyn *args[] = {key, value};
  ScrDyn *result = scr_dyn_handle_ops_of(map)->invoke(map->v.handle.ptr, map, "set", args, 2, "map.set");
  assert(result == map && !scr_exc_pending());
  scr_dyn_release(result);
}

static void erase(ScrDyn *map, ScrDyn *key) {
  ScrDyn *result = scr_dyn_handle_ops_of(map)->invoke(map->v.handle.ptr, map, "delete", &key, 1, "map.delete");
  assert(result && result->kind == SCR_DYN_BOOL && result->v.b && !scr_exc_pending());
  scr_dyn_release(result);
}

static ScrDyn *nothing(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_dyn_retain(scr_dyn_undefined());
}

int main(void) {
  scr_init();
  /* Native Set boxes may own headerless scalar/string maps. Collecting an
   * enclosing cycle must neither trace those leaves nor skip their release. */
  for (int i = 0; i < 2000; i++) {
#ifdef SCR_RC_AUDIT
    long before_maps = scr_map_live_count();
    long before_dyns = scr_dyn_live_count();
#endif
    ScrMap *numbers = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL, NULL, NULL);
    ScrMap *strings = scr_map_new(SCR_MAP_KEY_STR, SCR_MAP_VAL_F64, NULL, NULL, NULL);
    scr_map_set_f64_f64(numbers, 42, 1);
    ScrStr *text = scr_str_new("kept", 4);
    scr_map_set_str_f64(strings, text, 1);
    scr_str_release(text);
    ScrDyn *object = scr_dyn_new_obj();
    scr_dyn_obj_set(object, "numbers", 7, scr_dyn_native_set(numbers));
    scr_dyn_obj_set(object, "strings", 7, scr_dyn_native_set(strings));
    scr_dyn_obj_set(object, "self", 4, scr_dyn_retain(object));
    scr_map_release(strings); /* only the box owns this leaf */
    scr_dyn_release(object);
    scr_collect_cycles();
    assert(numbers->rc == 1 && scr_map_has_f64(numbers, 42));
    scr_map_release(numbers);
#ifdef SCR_RC_AUDIT
    assert(scr_map_live_count() == before_maps);
    assert(scr_dyn_live_count() == before_dyns);
#endif
  }
  /* A live alias survives collection; dropping it releases the entire
   * object/closure/capture cycle, including its acyclic string leaf. */
  for (int i = 0; i < 2000; i++) {
#ifdef SCR_RC_AUDIT
    long before = scr_dyn_live_count();
#endif
    ScrDyn *object = scr_dyn_new_obj();
    ScrClosure *closure = scr_closure_new(NULL, 1);
    closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    scr_box_set_ref(closure->caps[0], scr_dyn_retain(object));
    ScrDyn *callback = scr_dyn_new_func(closure, nothing, 0, "func()=>dyn", "read");
    scr_dyn_obj_set(object, "read", 4, callback);
    ScrStr *text = scr_str_new("alive", 5);
    scr_dyn_obj_set(object, "text", 4, scr_dyn_new_str(text));
    scr_str_release(text);
    ScrDyn *alias = scr_dyn_retain(object);
    scr_dyn_release(object);
    scr_collect_cycles();
    assert(scr_dyn_obj_get(alias, "text", 4)->v.str->len == 5);
    scr_dyn_release(alias);
    scr_collect_cycles();
#ifdef SCR_RC_AUDIT
    assert(scr_dyn_live_count() == before);
#endif
  }
  /* A checked bigint owns its payload independently of the producing slot. */
  for (int i = 0; i < 2000; i++) {
    ScrStr *decimal = scr_str_new("18446744073709551615", 20);
    ScrBigInt *integer = scr_bigint_parse(decimal);
    ScrDyn *boxed = scr_dyn_new_bigint(integer);
    scr_bigint_release(integer);
    ScrDyn *copy = scr_dyn_new_bigint(boxed->v.bigint);
    assert(scr_dyn_strict_eq(boxed, copy) && scr_dyn_truthy(copy));
    scr_dyn_release(boxed);
    ScrStr *rendered = scr_dyn_to_string(copy, NULL);
    assert(scr_str_eq(decimal, rendered));
    scr_str_release(decimal);
    scr_str_release(rendered);
    scr_dyn_release(copy);
  }
  ScrDyn *snapshot = scr_dyn_mark_snapshot(scr_dyn_new_obj());
  scr_dyn_release(snapshot);
  ScrDyn *fresh = scr_dyn_new_obj();
  assert(!fresh->copied_from_native);
  scr_dyn_release(fresh);
  ScrDyn *map = scr_weak_map_new(scr_dyn_undefined());
  ScrDyn *key = scr_dyn_new_obj();
  ScrDyn *first = scr_dyn_new_obj(), *second = scr_dyn_new_obj();
  put(map, key, first);
  assert(key->rc == 1 && first->rc == 2);
  put(map, key, second);
  assert(first->rc == 1 && second->rc == 2);
  erase(map, key);
  assert(second->rc == 1);
  put(map, key, first);
  put(map, second, first);
  scr_dyn_release(key);
  assert(first->rc == 2); /* first key died; second is still alive */
  scr_dyn_release(second);
  assert(first->rc == 1);

  /* Releasing a value can dispose a second key and its value. */
  key = scr_dyn_new_obj();
  ScrDyn *inner = scr_dyn_new_obj();
  put(map, key, inner);
  put(map, inner, first);
  scr_dyn_release(inner);
  scr_dyn_release(key);
  assert(first->rc == 1);

  /* Multiple maps observe the same key without retaining it. */
  ScrDyn *other_map = scr_weak_map_new(scr_dyn_undefined());
  key = scr_dyn_new_arr();
  put(map, key, first);
  put(other_map, key, first);
  assert(key->rc == 1 && first->rc == 3);
  scr_dyn_release(other_map);
  assert(key->rc == 1 && first->rc == 2);
  scr_dyn_release(key);
  assert(first->rc == 1);

  /* View and backing buffer are distinct keys, including a root view.
   * Dropping a box cannot remove metadata while native storage survives. */
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, 8);
  key = scr_dyn_new_bytes(bytes);
  ScrDyn *buffer = scr_array_buffer_from_bytes(bytes);
  put(map, key, first);
  put(map, buffer, first);
  assert(first->rc == 3 && bytes->rc == 3);
  scr_dyn_release(key);
  scr_dyn_release(buffer);
  assert(first->rc == 3 && bytes->rc == 1);
  buffer = scr_array_buffer_from_bytes(bytes);
  erase(map, buffer);
  assert(first->rc == 2);
  scr_dyn_release(buffer);
  scr_bytes_release(bytes);
  assert(first->rc == 1);

  ScrClosure *closure = scr_closure_new(NULL, 0);
  key = scr_dyn_new_func(scr_closure_retain(closure), nothing, 0, "", "key");
  put(map, key, first);
  scr_dyn_release(key);
  assert(closure->rc == 1 && first->rc == 2);
  scr_closure_release(closure);
  assert(first->rc == 1);

  /* A WeakMap can itself be a weak key. */
  other_map = scr_weak_map_new(scr_dyn_undefined());
  put(map, other_map, first);
  scr_dyn_release(other_map);
  assert(first->rc == 1);

  ScrDyn *weak_set = scr_weak_set_new(scr_dyn_undefined());
  key = scr_dyn_new_obj();
  ScrDyn *added = scr_dyn_handle_ops_of(weak_set)->invoke(weak_set->v.handle.ptr, weak_set, "add", &key, 1, "set.add");
  assert(added == weak_set && key->rc == 1);
  scr_dyn_release(added);
  scr_dyn_release(key);
  scr_dyn_release(weak_set);

  key = scr_dyn_new_obj();
  put(map, key, first);
  scr_dyn_release(map);
  assert(key->rc == 1 && first->rc == 1);
  scr_dyn_release(key);
  scr_dyn_release(first);
  assert(!scr_exc_pending());
  puts("weak metadata lifetime checks passed");
  return 0;
}
