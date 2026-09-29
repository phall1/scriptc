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
