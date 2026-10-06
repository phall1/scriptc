#include "scr_runtime.h"
#include <assert.h>
#include <math.h>
#include <string.h>

long scr_bytes_live_count(void);

/* Foreign wrappers may alias without a shared owner and may be unaligned. */
static ScrBytes *external(uint8_t *data, ScrBytesElem elem, size_t count) {
  ScrBytes *view = scr_bytes_from_external(data, count * scr_bytes_elem_size(elem));
  view->elem = elem;
  view->len = count;
  return view;
}

static void external_set(void) {
  const size_t starts[] = {1, 9, 41, 3001};
  uint8_t storage[6000], expected[6000];
  for (ScrBytesElem from = SCR_BYTES_U8; from <= SCR_BYTES_U8C; from++) {
    for (ScrBytesElem to = SCR_BYTES_U8; to <= SCR_BYTES_U8C; to++) {
      for (size_t j = 0; j < sizeof starts / sizeof starts[0]; j++) {
        memset(storage, 0x5a, sizeof storage);
        ScrBytes *src = external(storage + 9, from, 259);
        ScrBytes *dst = external(storage + starts[j], to, 263);
        for (size_t i = 0; i < src->len; i++) scr_bytes_set(src, i, (double)i * 3.5 - 257);
        memcpy(expected, storage, sizeof storage);
        ScrBytes *want = external(expected + starts[j], to, 263);
        for (size_t i = 0; i < src->len; i++) scr_bytes_set(want, i + 2, scr_bytes_get(src, i));
        scr_bytes_set_from(dst, src, 2);
        assert(!scr_exc_pending());
        assert(memcmp(storage, expected, sizeof storage) == 0);
        scr_bytes_release(want);
        scr_bytes_release(dst);
        scr_bytes_release(src);
      }
    }
  }
}

static void copied_storage(void) {
  /* Same-kind copies preserve NaN payloads, signed zero and ownership. */
  const uint64_t bits[] = {UINT64_C(0x7ff8000000000042), UINT64_C(0x8000000000000000),
                           UINT64_C(0xfff0000000000000)};
  ScrBytes *src = scr_bytes_new(SCR_BYTES_F64, 3);
  memcpy(src->data, bits, sizeof bits);
  ScrBytes *copy = scr_bytes_convert(SCR_BYTES_F64, src);
  ScrBytes *slice = scr_bytes_slice(src, 0, 3);
  assert(copy->data != src->data && slice->data != src->data);
  assert(memcmp(copy->data, bits, sizeof bits) == 0);
  assert(memcmp(slice->data, bits, sizeof bits) == 0);
  ScrBytes *view = scr_bytes_subarray(copy, 1, 3);
  scr_bytes_release(copy);
  scr_bytes_release(src);
  assert(memcmp(view->data, bits + 1, sizeof bits - sizeof bits[0]) == 0);
  scr_bytes_release(view);
  scr_bytes_release(slice);
}

static void filled_storage(void) {
  uint8_t storage[2200], expected[2200];
  const double values[] = {-0.0, -1.5, 2.5, 255.5, 4294967297.0, NAN, INFINITY};
  for (ScrBytesElem elem = SCR_BYTES_U8; elem <= SCR_BYTES_U8C; elem++) {
    for (size_t j = 0; j < sizeof values / sizeof values[0]; j++) {
      memset(storage, 0xa5, sizeof storage);
      memcpy(expected, storage, sizeof storage);
      ScrBytes *dst = external(storage + 1, elem, 263);
      ScrBytes *want = external(expected + 1, elem, 263);
      for (size_t i = 2; i < 261; i++) scr_bytes_set(want, i, values[j]);
      ScrBytes *result = scr_bytes_fill_elem(dst, values[j], 2, 261);
      assert(result == dst && dst->rc == 2);
      assert(memcmp(storage, expected, sizeof storage) == 0);
      scr_bytes_release(result);
      scr_bytes_release(dst);
      scr_bytes_release(want);
    }
  }
}

void scr_bytes_test_bulk_storage(void) {
  long before = scr_bytes_live_count();
  external_set();
  copied_storage();
  filled_storage();
  assert(scr_bytes_live_count() == before);
}
