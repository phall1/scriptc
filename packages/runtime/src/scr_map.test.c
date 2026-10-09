/* Number-keyed maps switch between linear, directly indexed and hashed
 * lookup. A randomized run compares every operation with a plain ordered
 * model (SameValueZero, insertion order), and explicit cases pin which
 * index each key shape selects. */
#include "scr_runtime.h"
#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MODEL_CAP 20000

typedef struct {
  double key[MODEL_CAP];
  double val[MODEL_CAP];
  size_t n;
} Model;

static bool same_value_zero(double a, double b) {
  return a == b || (a != a && b != b);
}

static long model_find(const Model *m, double k) {
  for (size_t i = 0; i < m->n; i++) if (same_value_zero(m->key[i], k)) return (long)i;
  return -1;
}

static void model_set(Model *m, double k, double v) {
  long i = model_find(m, k);
  if (i >= 0) { m->val[i] = v; return; }
  assert(m->n < MODEL_CAP);
  m->key[m->n] = k == 0 ? 0 : k; /* Map stores +0 for -0 */
  m->val[m->n++] = v;
}

static bool model_delete(Model *m, double k) {
  long i = model_find(m, k);
  if (i < 0) return false;
  memmove(&m->key[i], &m->key[i + 1], (m->n - (size_t)i - 1) * sizeof(double));
  memmove(&m->val[i], &m->val[i + 1], (m->n - (size_t)i - 1) * sizeof(double));
  m->n--;
  return true;
}

static uint64_t state = UINT64_C(0x9e3779b97f4a7c15);
static uint64_t next(void) {
  state ^= state << 13;
  state ^= state >> 7;
  state ^= state << 17;
  return state;
}

static double odd_key(void) {
  static const double odd[] = {-1, 0.5, 1e9, 4294967296.0, -0.0, 3.25, 1e300, -1e-300};
  uint64_t r = next() % 9;
  return r == 8 ? NAN : odd[r];
}

static void check_same(const ScrMap *map, const Model *model) {
  assert((size_t)scr_map_size(map) == model->n);
  size_t j = 0;
  size_t count = (size_t)scr_map_iter_count(map);
  for (size_t i = 0; i < count; i++) {
    if (!scr_map_iter_live(map, (double)i)) continue;
    double k = scr_map_iter_key_f64(map, (double)i);
    assert(j < model->n);
    assert(same_value_zero(k, model->key[j]) && !signbit(k == 0 ? k : 1));
    assert(scr_map_iter_val_f64(map, (double)i) == model->val[j]);
    j++;
  }
  assert(j == model->n);
}

static void probe(const ScrMap *map, const Model *model, double k) {
  long i = model_find(model, k);
  double out = -12345;
  bool found = scr_map_get_f64_f64(map, k, &out);
  assert(found == (i >= 0));
  assert(scr_map_has_f64(map, k) == (i >= 0));
  const ScrMapEntry *entry = scr_map_entry_f64(map, k);
  assert((entry != NULL) == (i >= 0));
  if (i >= 0) {
    assert(out == model->val[i]);
    double v;
    memcpy(&v, &entry->val, sizeof v);
    assert(v == model->val[i]);
  }
}

/* 0: a small dense key set; 1: the same with a rare key that forces
 * hashing; 2: frequent such keys; 3: sparse keys only; 4: a moving dense
 * window that later jumps to sparse keys. */
static double random_key(unsigned flavor, size_t step) {
  uint64_t r = next();
  switch (flavor) {
  case 0: return (double)(r % 60);
  case 1: return r % 20011 == 0 ? odd_key() : (double)(r % 60);
  case 2: return r % 13 == 0 ? odd_key() : (double)(r % 300);
  case 3: return (double)(r % 64) * 1000003.0;
  default: return step < 30000 ? (double)(step / 8 + r % 50) : (double)step * 1000.0 + (double)(r % 50);
  }
}

static void fuzz(unsigned flavor) {
  static Model model;
  model.n = 0;
  ScrMap *map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL, NULL, NULL);
  size_t dense_steps = 0, hashed_steps = 0;
  for (size_t step = 0; step < 40000; step++) {
    dense_steps += map->ndense != 0;
    hashed_steps += map->nbuckets != 0;
    uint64_t op = next() % 100;
    double k = random_key(flavor, step);
    if (op < 45) {
      double v = (double)(next() % 100000);
      scr_map_set_f64_f64(map, k, v);
      model_set(&model, k, v);
    } else if (op < 70) {
      assert(scr_map_delete_f64(map, k) == model_delete(&model, k));
    } else if (op < 99) {
      probe(map, &model, k);
      probe(map, &model, odd_key());
    } else if (next() % 20 == 0) {
      scr_map_clear(map);
      model.n = 0;
    }
    if (step % 997 == 0) check_same(map, &model);
  }
  check_same(map, &model);
  /* Each flavor must have exercised the index it targets. */
  if (flavor <= 1 || flavor == 4) assert(dense_steps > 1000);
  if (flavor >= 2) assert(hashed_steps > 1000);
  if (flavor == 0) assert(hashed_steps == 0);
  /* Copies keep order and lookups, and stay independent. */
  ScrMap *copy = scr_map_clone(map, false);
  check_same(copy, &model);
  for (size_t i = 0; i < 400; i++) probe(copy, &model, (double)i);
  scr_map_set_f64_f64(copy, 7, -1);
  check_same(map, &model);
  scr_map_release(copy);
  scr_map_release(map);
}

/* Removing and re-adding keys during an iteration: indices stay stable and
 * appended keys are visited, as Map.prototype.forEach requires. */
static void iterate_while_mutating(void) {
  ScrMap *map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL, NULL, NULL);
  for (int i = 0; i < 64; i++) scr_map_set_f64_f64(map, i, i);
  assert(map->ndense);
  scr_map_iter_enter(map);
  size_t visited = 0;
  for (size_t i = 0; i < (size_t)scr_map_iter_count(map); i++) {
    if (!scr_map_iter_live(map, (double)i)) continue;
    double k = scr_map_iter_key_f64(map, (double)i);
    visited++;
    if (k < 32) {
      assert(scr_map_delete_f64(map, k));
      scr_map_set_f64_f64(map, k + 64, k);
    }
  }
  scr_map_iter_exit(map);
  assert(visited == 96 && scr_map_size(map) == 64);
  for (int i = 32; i < 96; i++) assert(scr_map_has_f64(map, i));
  for (int i = 0; i < 32; i++) assert(!scr_map_has_f64(map, i));
  scr_map_release(map);
}

static void modes(void) {
  ScrMap *map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL, NULL, NULL);
  for (int i = 1; i <= 4; i++) scr_map_set_f64_f64(map, i, i);
  assert(!map->ndense && !map->nbuckets); /* still a linear scan */
  scr_map_set_f64_f64(map, 5, 5);
  assert(map->ndense >= 16 && !map->nbuckets);
  for (int i = 6; i < 1000; i++) scr_map_set_f64_f64(map, i, i);
  assert(map->ndense >= 1000 && map->ndense <= 2048);
  scr_map_set_f64_f64(map, -0.0, 0); /* slot 0 */
  assert(map->ndense);
  double out;
  assert(scr_map_get_f64_f64(map, -0.0, &out) && out == 0);
  assert(!scr_map_has_f64(map, 0.5) && !scr_map_has_f64(map, NAN) && !scr_map_has_f64(map, -1));
  scr_map_set_f64_f64(map, 0.5, 9); /* a fraction moves to hashing */
  assert(!map->ndense && map->nbuckets);
  assert(scr_map_get_f64_f64(map, 0.5, &out) && out == 9);
  assert(scr_map_get_f64_f64(map, 999, &out) && out == 999);
  scr_map_delete_f64(map, 0.5);
  scr_map_set_f64_f64(map, 1000, 1000);
  assert(!map->ndense); /* hashing until the bucket table must grow */
  for (int i = 1001; i < 3000 && !map->ndense; i++) scr_map_set_f64_f64(map, i, i);
  assert(map->ndense && !map->nbuckets); /* compact integer keys again */
  assert(scr_map_get_f64_f64(map, 1000, &out) && out == 1000 && !scr_map_has_f64(map, 0.5));
  scr_map_release(map);

  /* A key far beyond the live count hashes instead of allocating for it. */
  map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL, NULL, NULL);
  for (int i = 0; i < 5; i++) scr_map_set_f64_f64(map, i, i);
  assert(map->ndense);
  scr_map_set_f64_f64(map, 100000, 1);
  assert(!map->ndense);
  scr_map_release(map);

  /* Keys that start far from zero hash until the live count makes a table
   * covering them compact, then switch to it. */
  map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL, NULL, NULL);
  for (int i = 0; i < 5; i++) scr_map_set_f64_f64(map, 5000 + i, i);
  assert(!map->ndense && map->nbuckets);
  for (int i = 5; i < 2000; i++) scr_map_set_f64_f64(map, 5000 + i, i);
  assert(map->ndense && !map->nbuckets);
  for (int i = 0; i < 2000; i++) assert(scr_map_get_f64_f64(map, 5000 + i, &out) && out == i);
  assert(!scr_map_has_f64(map, 4999) && !scr_map_has_f64(map, 0));
  scr_map_release(map);

  /* Sparse keys from the start never enter the direct index. */
  map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL, NULL, NULL);
  for (int i = 0; i < 10; i++) scr_map_set_f64_f64(map, i * 100000.0, i);
  assert(!map->ndense && map->nbuckets);
  scr_map_release(map);

  /* Sets built from an array use the same index. */
  ScrArr *values = scr_arr_new(SCR_ELEM_F64, 0);
  for (int i = 0; i < 50; i++) scr_arr_push_f64(values, (double)(i % 20));
  ScrMap *set = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL, NULL, NULL);
  scr_set_add_all(set, values);
  assert(set->ndense && scr_map_size(set) == 20);
  scr_arr_release(values);
  scr_map_release(set);
}

int main(void) {
  modes();
  iterate_while_mutating();
  for (unsigned flavor = 0; flavor < 5; flavor++) fuzz(flavor);
  puts("number-key maps passed");
  return 0;
}
