/* SPDX-License-Identifier: AGPL-3.0-or-later */
/*
 * Streaming, low-memory, multi-threaded OSM PBF node scanner for rsm.pipeline.osm.
 *
 * Why this exists:
 *   pyosmium's FileProcessor.with_locations() caches the coordinates of EVERY node
 *   in the entire .osm.pbf (buildings, trees, landuse, POIs, rivers, ...) in RAM
 *   (flex_mem: ~1.2 GB on a 330 MB extract, ~8-10 GB on a 2.2 GB Alps extract,
 *   OOM on Germany/Europe).
 *
 *   Here we stream PBF blobs through a bounded worker pool (zlib + pthreads),
 *   skipping StringTable, DenseInfo, keys_vals, Ways, and Relations completely,
 *   and retaining ONLY:
 *     1. pbf_scan_nodes_in_boxes: nodes inside padded target bboxes (20 B/node),
 *        with a bitmask of exact boxes containing each node.
 *     2. pbf_lookup_nodes_by_ids: coordinates for a sorted int64 array of needed
 *        node IDs (8 B/node, used for boundary fallback and density()).
 *     3. way_box_masks_batch: fast binary-search lookup of box bitmasks for a
 *        batch of ways against the sorted node-ID array (zero Python set memory).
 *
 * Compile:
 *   cc -O3 -shared -fPIC -lz -lpthread -o _pbf_native_$(uname -m).so _pbf_native.c
 */

#include <errno.h>
#include <limits.h>
#include <math.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

#define PBF_OK 0
#define PBF_ERR_IO -1
#define PBF_ERR_UNSUPPORTED -2
#define PBF_ERR_FORMAT -3
#define PBF_ERR_OOM -4

#define MAX_BOXES 32
#define MAX_HEADER_LEN (64 * 1024)
#define MAX_BLOB_LEN (32 * 1024 * 1024)
#define MAX_GROUPS_STACK 64

typedef void (*progress_cb_t)(double frac);

/* ------------------------------------------------------------------ protobuf helpers */

static inline int read_varint(const uint8_t *buf, size_t len, size_t *pos, uint64_t *out) {
    uint64_t val = 0;
    unsigned shift = 0;
    size_t p = *pos;
    while (p < len) {
        uint8_t b = buf[p++];
        val |= (uint64_t)(b & 0x7Fu) << shift;
        if ((b & 0x80u) == 0) {
            *pos = p;
            *out = val;
            return 1;
        }
        shift += 7;
        if (shift > 63) return 0;
    }
    return 0;
}

static inline int64_t zigzag64(uint64_t v) {
    return (int64_t)((v >> 1) ^ (-(int64_t)(v & 1u)));
}

static inline int skip_field(const uint8_t *buf, size_t len, size_t *pos, uint32_t wire_type) {
    uint64_t v;
    switch (wire_type) {
        case 0:
            return read_varint(buf, len, pos, &v);
        case 1:
            if (*pos + 8 > len) return 0;
            *pos += 8;
            return 1;
        case 2:
            if (!read_varint(buf, len, pos, &v)) return 0;
            if (v > len - *pos) return 0;
            *pos += (size_t)v;
            return 1;
        case 5:
            if (*pos + 4 > len) return 0;
            *pos += 4;
            return 1;
        default:
            return 0;
    }
}

static inline int32_t ndeg_to_e7(int64_t ndeg, int32_t gran, int64_t off) {
    if (gran == 100 && off == 0) {
        /* caller already passed raw delta value? No, ndeg = 100 * raw -> exact division */
        return (int32_t)(ndeg / 100);
    }
    return (int32_t)llround((double)ndeg * 0.01);
}

/* ------------------------------------------------------------------ BlobHeader & Blob */

static int parse_blob_header(const uint8_t *buf, size_t len, int *is_osmdata, uint32_t *datasize) {
    size_t pos = 0;
    *is_osmdata = 0;
    *datasize = 0;
    while (pos < len) {
        uint64_t key;
        if (!read_varint(buf, len, &pos, &key)) return 0;
        uint32_t fnum = (uint32_t)(key >> 3);
        uint32_t wt = (uint32_t)(key & 7u);
        if (fnum == 1 && wt == 2) {
            uint64_t slen;
            if (!read_varint(buf, len, &pos, &slen) || slen > len - pos) return 0;
            if (slen == 7 && memcmp(buf + pos, "OSMData", 7) == 0) *is_osmdata = 1;
            pos += (size_t)slen;
        } else if (fnum == 3 && wt == 0) {
            uint64_t ds;
            if (!read_varint(buf, len, &pos, &ds)) return 0;
            *datasize = (uint32_t)ds;
        } else {
            if (!skip_field(buf, len, &pos, wt)) return 0;
        }
    }
    return 1;
}

static int decompress_blob(const uint8_t *blob, size_t blob_len,
                           uint8_t **out_buf, size_t *out_cap, size_t *out_len) {
    size_t pos = 0;
    const uint8_t *raw_ptr = NULL;
    size_t raw_len = 0;
    const uint8_t *zlib_ptr = NULL;
    size_t zlib_len = 0;
    uint32_t raw_size = 0;
    int has_other_comp = 0;

    while (pos < blob_len) {
        uint64_t key;
        if (!read_varint(blob, blob_len, &pos, &key)) return PBF_ERR_FORMAT;
        uint32_t fnum = (uint32_t)(key >> 3);
        uint32_t wt = (uint32_t)(key & 7u);
        if (fnum == 1 && wt == 2) {
            uint64_t l;
            if (!read_varint(blob, blob_len, &pos, &l) || l > blob_len - pos) return PBF_ERR_FORMAT;
            raw_ptr = blob + pos;
            raw_len = (size_t)l;
            pos += (size_t)l;
        } else if (fnum == 2 && wt == 0) {
            uint64_t v;
            if (!read_varint(blob, blob_len, &pos, &v)) return PBF_ERR_FORMAT;
            raw_size = (uint32_t)v;
        } else if (fnum == 3 && wt == 2) {
            uint64_t l;
            if (!read_varint(blob, blob_len, &pos, &l) || l > blob_len - pos) return PBF_ERR_FORMAT;
            zlib_ptr = blob + pos;
            zlib_len = (size_t)l;
            pos += (size_t)l;
        } else if ((fnum >= 4 && fnum <= 7) && wt == 2) {
            has_other_comp = 1;
            if (!skip_field(blob, blob_len, &pos, wt)) return PBF_ERR_FORMAT;
        } else {
            if (!skip_field(blob, blob_len, &pos, wt)) return PBF_ERR_FORMAT;
        }
    }

    if (raw_ptr) {
        if (raw_len > *out_cap) {
            uint8_t *nb = (uint8_t *)realloc(*out_buf, raw_len);
            if (!nb) return PBF_ERR_OOM;
            *out_buf = nb;
            *out_cap = raw_len;
        }
        memcpy(*out_buf, raw_ptr, raw_len);
        *out_len = raw_len;
        return PBF_OK;
    }

    if (zlib_ptr) {
        size_t need = raw_size ? (size_t)raw_size : zlib_len * 4;
        if (need < 65536) need = 65536;
        if (need > MAX_BLOB_LEN) need = MAX_BLOB_LEN;
        if (need > *out_cap) {
            uint8_t *nb = (uint8_t *)realloc(*out_buf, need);
            if (!nb) return PBF_ERR_OOM;
            *out_buf = nb;
            *out_cap = need;
        }
        uLongf dst_len = (uLongf)(*out_cap);
        int zrc = uncompress(*out_buf, &dst_len, zlib_ptr, (uLong)zlib_len);
        while (zrc == Z_BUF_ERROR && *out_cap < MAX_BLOB_LEN) {
            size_t ncap = (*out_cap) * 2;
            if (ncap > MAX_BLOB_LEN) ncap = MAX_BLOB_LEN;
            uint8_t *nb = (uint8_t *)realloc(*out_buf, ncap);
            if (!nb) return PBF_ERR_OOM;
            *out_buf = nb;
            *out_cap = ncap;
            dst_len = (uLongf)(*out_cap);
            zrc = uncompress(*out_buf, &dst_len, zlib_ptr, (uLong)zlib_len);
        }
        if (zrc != Z_OK) return PBF_ERR_FORMAT;
        *out_len = (size_t)dst_len;
        return PBF_OK;
    }

    return has_other_comp ? PBF_ERR_UNSUPPORTED : PBF_ERR_FORMAT;
}

/* ------------------------------------------------------------------ Node record & dynamic array */

typedef struct {
    int64_t id;
    int32_t lat_e7;
    int32_t lon_e7;
    uint32_t mask;
} NodeRec;

typedef struct {
    NodeRec *data;
    size_t len;
    size_t cap;
} NodeVec;

static inline int nodevec_push(NodeVec *v, int64_t id, int32_t lat_e7, int32_t lon_e7, uint32_t mask) {
    if (v->len == v->cap) {
        size_t ncap = v->cap ? v->cap * 2 : 4096;
        NodeRec *nd = (NodeRec *)realloc(v->data, ncap * sizeof(NodeRec));
        if (!nd) return 0;
        v->data = nd;
        v->cap = ncap;
    }
    v->data[v->len].id = id;
    v->data[v->len].lat_e7 = lat_e7;
    v->data[v->len].lon_e7 = lon_e7;
    v->data[v->len].mask = mask;
    v->len++;
    return 1;
}

/* ------------------------------------------------------------------ Bounded blob queue */

typedef struct {
    uint8_t *buf;
    size_t len;
} BlobItem;

typedef struct {
    BlobItem *items;
    int cap;
    int head;
    int tail;
    int count;
    int done;
    int err;
    pthread_mutex_t mu;
    pthread_cond_t not_empty;
    pthread_cond_t not_full;
} BlobQueue;

static int bq_init(BlobQueue *q, int cap) {
    memset(q, 0, sizeof(*q));
    q->items = (BlobItem *)calloc((size_t)cap, sizeof(BlobItem));
    if (!q->items) return 0;
    q->cap = cap;
    pthread_mutex_init(&q->mu, NULL);
    pthread_cond_init(&q->not_empty, NULL);
    pthread_cond_init(&q->not_full, NULL);
    return 1;
}

static void bq_destroy(BlobQueue *q) {
    for (int i = 0; i < q->count; i++) {
        free(q->items[(q->head + i) % q->cap].buf);
    }
    free(q->items);
    pthread_mutex_destroy(&q->mu);
    pthread_cond_destroy(&q->not_empty);
    pthread_cond_destroy(&q->not_full);
}

static int bq_push(BlobQueue *q, uint8_t *buf, size_t len) {
    pthread_mutex_lock(&q->mu);
    while (q->count == q->cap && !q->err) {
        pthread_cond_wait(&q->not_full, &q->mu);
    }
    if (q->err) {
        pthread_mutex_unlock(&q->mu);
        free(buf);
        return 0;
    }
    q->items[q->tail].buf = buf;
    q->items[q->tail].len = len;
    q->tail = (q->tail + 1) % q->cap;
    q->count++;
    pthread_cond_signal(&q->not_empty);
    pthread_mutex_unlock(&q->mu);
    return 1;
}

static int bq_pop(BlobQueue *q, BlobItem *out) {
    pthread_mutex_lock(&q->mu);
    while (q->count == 0 && !q->done && !q->err) {
        pthread_cond_wait(&q->not_empty, &q->mu);
    }
    if (q->count == 0 || q->err) {
        pthread_mutex_unlock(&q->mu);
        return 0;
    }
    *out = q->items[q->head];
    q->head = (q->head + 1) % q->cap;
    q->count--;
    pthread_cond_signal(&q->not_full);
    pthread_mutex_unlock(&q->mu);
    return 1;
}

static void bq_finish(BlobQueue *q) {
    pthread_mutex_lock(&q->mu);
    q->done = 1;
    pthread_cond_broadcast(&q->not_empty);
    pthread_mutex_unlock(&q->mu);
}

static void bq_fail(BlobQueue *q, int err) {
    pthread_mutex_lock(&q->mu);
    if (!q->err) q->err = err;
    pthread_cond_broadcast(&q->not_empty);
    pthread_cond_broadcast(&q->not_full);
    pthread_mutex_unlock(&q->mu);
}

/* ------------------------------------------------------------------ Mode 1: scan nodes in boxes */

typedef struct {
    int64_t s_ndeg, w_ndeg, n_ndeg, e_ndeg;
} BoxNdeg;

typedef struct {
    int n_boxes;
    BoxNdeg exact[MAX_BOXES];
    BoxNdeg padded[MAX_BOXES];
    BoxNdeg union_pad;
} BoxSpec;

static inline int check_boxes_and_push(const BoxSpec *bs, NodeVec *vec,
                                       int64_t id, int64_t lat_ndeg, int64_t lon_ndeg,
                                       int32_t gran, int64_t lat_off, int64_t lon_off) {
    if (lat_ndeg < bs->union_pad.s_ndeg || lat_ndeg > bs->union_pad.n_ndeg ||
        lon_ndeg < bs->union_pad.w_ndeg || lon_ndeg > bs->union_pad.e_ndeg) {
        return 1;
    }
    int in_pad = 0;
    uint32_t mask = 0;
    for (int i = 0; i < bs->n_boxes; i++) {
        if (lat_ndeg >= bs->padded[i].s_ndeg && lat_ndeg <= bs->padded[i].n_ndeg &&
            lon_ndeg >= bs->padded[i].w_ndeg && lon_ndeg <= bs->padded[i].e_ndeg) {
            in_pad = 1;
            if (lat_ndeg >= bs->exact[i].s_ndeg && lat_ndeg <= bs->exact[i].n_ndeg &&
                lon_ndeg >= bs->exact[i].w_ndeg && lon_ndeg <= bs->exact[i].e_ndeg) {
                mask |= (1u << i);
            }
        }
    }
    if (!in_pad) return 1;
    int32_t lat_e7 = ndeg_to_e7(lat_ndeg, gran, lat_off);
    int32_t lon_e7 = ndeg_to_e7(lon_ndeg, gran, lon_off);
    return nodevec_push(vec, id, lat_e7, lon_e7, mask);
}

/* ------------------------------------------------------------------ Mode 2: lookup nodes by sorted IDs */

typedef struct {
    const int64_t *ids;
    int64_t n;
    int64_t min_id;
    int64_t max_id;
    int32_t *lat_e7;
    int32_t *lon_e7;
} LookupSpec;

static inline int64_t bsearch_id(const int64_t *ids, int64_t n, int64_t target) {
    int64_t lo = 0, hi = n - 1;
    while (lo <= hi) {
        int64_t mid = lo + ((hi - lo) >> 1);
        int64_t v = ids[mid];
        if (v == target) return mid;
        if (v < target) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}

static inline void check_lookup_and_store(const LookupSpec *ls,
                                          int64_t id, int64_t lat_ndeg, int64_t lon_ndeg,
                                          int32_t gran, int64_t lat_off, int64_t lon_off) {
    if (id < ls->min_id || id > ls->max_id) return;
    int64_t idx = bsearch_id(ls->ids, ls->n, id);
    if (idx >= 0) {
        ls->lat_e7[idx] = ndeg_to_e7(lat_ndeg, gran, lat_off);
        ls->lon_e7[idx] = ndeg_to_e7(lon_ndeg, gran, lon_off);
    }
}

/* ------------------------------------------------------------------ PrimitiveBlock node decoding */

typedef struct {
    const uint8_t *ptr;
    size_t len;
} Slice;

static int decode_dense_nodes(const uint8_t *buf, size_t len,
                              int32_t gran, int64_t lat_off, int64_t lon_off,
                              const BoxSpec *bs, NodeVec *vec, const LookupSpec *ls) {
    size_t pos = 0;
    const uint8_t *id_p = NULL, *lat_p = NULL, *lon_p = NULL;
    size_t id_l = 0, lat_l = 0, lon_l = 0;

    while (pos < len) {
        uint64_t key;
        if (!read_varint(buf, len, &pos, &key)) return PBF_ERR_FORMAT;
        uint32_t fnum = (uint32_t)(key >> 3);
        uint32_t wt = (uint32_t)(key & 7u);
        if (wt == 2 && (fnum == 1 || fnum == 8 || fnum == 9)) {
            uint64_t sl;
            if (!read_varint(buf, len, &pos, &sl) || sl > len - pos) return PBF_ERR_FORMAT;
            if (fnum == 1) { id_p = buf + pos; id_l = (size_t)sl; }
            else if (fnum == 8) { lat_p = buf + pos; lat_l = (size_t)sl; }
            else { lon_p = buf + pos; lon_l = (size_t)sl; }
            pos += (size_t)sl;
        } else {
            if (!skip_field(buf, len, &pos, wt)) return PBF_ERR_FORMAT;
        }
    }
    if (!id_p || !lat_p || !lon_p) return PBF_OK;

    size_t pi = 0, pla = 0, plo = 0;
    int64_t cur_id = 0, cur_lat = 0, cur_lon = 0;
    int64_t g64 = (int64_t)gran;

    while (pi < id_l && pla < lat_l && plo < lon_l) {
        uint64_t vi, vla, vlo;
        if (!read_varint(id_p, id_l, &pi, &vi) ||
            !read_varint(lat_p, lat_l, &pla, &vla) ||
            !read_varint(lon_p, lon_l, &plo, &vlo)) {
            return PBF_ERR_FORMAT;
        }
        cur_id += zigzag64(vi);
        cur_lat += zigzag64(vla);
        cur_lon += zigzag64(vlo);
        int64_t lat_ndeg = lat_off + g64 * cur_lat;
        int64_t lon_ndeg = lon_off + g64 * cur_lon;
        if (bs) {
            if (!check_boxes_and_push(bs, vec, cur_id, lat_ndeg, lon_ndeg, gran, lat_off, lon_off))
                return PBF_ERR_OOM;
        } else if (ls) {
            check_lookup_and_store(ls, cur_id, lat_ndeg, lon_ndeg, gran, lat_off, lon_off);
        }
    }
    return PBF_OK;
}

static int decode_single_node(const uint8_t *buf, size_t len,
                              int32_t gran, int64_t lat_off, int64_t lon_off,
                              const BoxSpec *bs, NodeVec *vec, const LookupSpec *ls) {
    size_t pos = 0;
    int64_t id = 0, lat = 0, lon = 0;
    int have = 0;
    while (pos < len) {
        uint64_t key;
        if (!read_varint(buf, len, &pos, &key)) return PBF_ERR_FORMAT;
        uint32_t fnum = (uint32_t)(key >> 3);
        uint32_t wt = (uint32_t)(key & 7u);
        if (wt == 0 && (fnum == 1 || fnum == 8 || fnum == 9)) {
            uint64_t v;
            if (!read_varint(buf, len, &pos, &v)) return PBF_ERR_FORMAT;
            if (fnum == 1) { id = zigzag64(v); have |= 1; }
            else if (fnum == 8) { lat = zigzag64(v); have |= 2; }
            else { lon = zigzag64(v); have |= 4; }
        } else {
            if (!skip_field(buf, len, &pos, wt)) return PBF_ERR_FORMAT;
        }
    }
    if (have != 7) return PBF_OK;
    int64_t lat_ndeg = lat_off + (int64_t)gran * lat;
    int64_t lon_ndeg = lon_off + (int64_t)gran * lon;
    if (bs) {
        if (!check_boxes_and_push(bs, vec, id, lat_ndeg, lon_ndeg, gran, lat_off, lon_off))
            return PBF_ERR_OOM;
    } else if (ls) {
        check_lookup_and_store(ls, id, lat_ndeg, lon_ndeg, gran, lat_off, lon_off);
    }
    return PBF_OK;
}

static int process_primitive_block(const uint8_t *buf, size_t len,
                                   const BoxSpec *bs, NodeVec *vec, const LookupSpec *ls) {
    size_t pos = 0;
    int32_t gran = 100;
    int64_t lat_off = 0, lon_off = 0;
    Slice stack_groups[MAX_GROUPS_STACK];
    Slice *groups = stack_groups;
    size_t n_groups = 0, cap_groups = MAX_GROUPS_STACK;
    int rc = PBF_OK;

    while (pos < len) {
        uint64_t key;
        if (!read_varint(buf, len, &pos, &key)) { rc = PBF_ERR_FORMAT; goto out; }
        uint32_t fnum = (uint32_t)(key >> 3);
        uint32_t wt = (uint32_t)(key & 7u);
        if (fnum == 2 && wt == 2) {
            uint64_t sl;
            if (!read_varint(buf, len, &pos, &sl) || sl > len - pos) { rc = PBF_ERR_FORMAT; goto out; }
            if (n_groups == cap_groups) {
                size_t ncap = cap_groups * 2;
                Slice *ng = (groups == stack_groups)
                    ? (Slice *)malloc(ncap * sizeof(Slice))
                    : (Slice *)realloc(groups, ncap * sizeof(Slice));
                if (!ng) { rc = PBF_ERR_OOM; goto out; }
                if (groups == stack_groups) memcpy(ng, stack_groups, n_groups * sizeof(Slice));
                groups = ng;
                cap_groups = ncap;
            }
            groups[n_groups].ptr = buf + pos;
            groups[n_groups].len = (size_t)sl;
            n_groups++;
            pos += (size_t)sl;
        } else if (fnum == 17 && wt == 0) {
            uint64_t v;
            if (!read_varint(buf, len, &pos, &v)) { rc = PBF_ERR_FORMAT; goto out; }
            gran = (int32_t)v;
        } else if (fnum == 19 && wt == 0) {
            uint64_t v;
            if (!read_varint(buf, len, &pos, &v)) { rc = PBF_ERR_FORMAT; goto out; }
            lat_off = (int64_t)v;
        } else if (fnum == 20 && wt == 0) {
            uint64_t v;
            if (!read_varint(buf, len, &pos, &v)) { rc = PBF_ERR_FORMAT; goto out; }
            lon_off = (int64_t)v;
        } else {
            if (!skip_field(buf, len, &pos, wt)) { rc = PBF_ERR_FORMAT; goto out; }
        }
    }

    for (size_t gi = 0; gi < n_groups; gi++) {
        const uint8_t *gb = groups[gi].ptr;
        size_t gl = groups[gi].len;
        size_t gp = 0;
        while (gp < gl) {
            uint64_t key;
            if (!read_varint(gb, gl, &gp, &key)) { rc = PBF_ERR_FORMAT; goto out; }
            uint32_t fnum = (uint32_t)(key >> 3);
            uint32_t wt = (uint32_t)(key & 7u);
            if (fnum == 2 && wt == 2) {
                uint64_t sl;
                if (!read_varint(gb, gl, &gp, &sl) || sl > gl - gp) { rc = PBF_ERR_FORMAT; goto out; }
                rc = decode_dense_nodes(gb + gp, (size_t)sl, gran, lat_off, lon_off, bs, vec, ls);
                if (rc != PBF_OK) goto out;
                gp += (size_t)sl;
            } else if (fnum == 1 && wt == 2) {
                uint64_t sl;
                if (!read_varint(gb, gl, &gp, &sl) || sl > gl - gp) { rc = PBF_ERR_FORMAT; goto out; }
                rc = decode_single_node(gb + gp, (size_t)sl, gran, lat_off, lon_off, bs, vec, ls);
                if (rc != PBF_OK) goto out;
                gp += (size_t)sl;
            } else {
                /* Ways (3), Relations (4), ChangeSets (5): skip immediately */
                if (!skip_field(gb, gl, &gp, wt)) { rc = PBF_ERR_FORMAT; goto out; }
            }
        }
    }

out:
    if (groups != stack_groups) free(groups);
    return rc;
}

/* ------------------------------------------------------------------ Worker thread */

typedef struct {
    BlobQueue *q;
    const BoxSpec *bs;
    const LookupSpec *ls;
    NodeVec vec;
} WorkerArg;

static void *worker_main(void *arg) {
    WorkerArg *wa = (WorkerArg *)arg;
    uint8_t *raw_buf = NULL;
    size_t raw_cap = 0;
    BlobItem item;

    while (bq_pop(wa->q, &item)) {
        size_t raw_len = 0;
        int rc = decompress_blob(item.buf, item.len, &raw_buf, &raw_cap, &raw_len);
        free(item.buf);
        if (rc != PBF_OK) {
            bq_fail(wa->q, rc);
            break;
        }
        rc = process_primitive_block(raw_buf, raw_len, wa->bs, &wa->vec, wa->ls);
        if (rc != PBF_OK) {
            bq_fail(wa->q, rc);
            break;
        }
    }
    free(raw_buf);
    return NULL;
}

static int run_pbf_node_scan(const char *path, int n_threads,
                             const BoxSpec *bs, const LookupSpec *ls,
                             WorkerArg *workers, progress_cb_t prog_cb) {
    FILE *fp = fopen(path, "rb");
    if (!fp) return PBF_ERR_IO;

    fseeko(fp, 0, SEEK_END);
    off_t fsize = ftello(fp);
    fseeko(fp, 0, SEEK_SET);
    if (fsize <= 0) {
        fclose(fp);
        return PBF_ERR_FORMAT;
    }

    if (n_threads < 1) n_threads = 1;
    if (n_threads > 8) n_threads = 8;

    BlobQueue q;
    if (!bq_init(&q, n_threads * 2 + 2)) {
        fclose(fp);
        return PBF_ERR_OOM;
    }

    pthread_t tids[8];
    for (int i = 0; i < n_threads; i++) {
        memset(&workers[i], 0, sizeof(WorkerArg));
        workers[i].q = &q;
        workers[i].bs = bs;
        workers[i].ls = ls;
        pthread_create(&tids[i], NULL, worker_main, &workers[i]);
    }

    uint8_t hdr_buf[MAX_HEADER_LEN];
    int rc = PBF_OK;
    int blob_idx = 0;

    while (1) {
        uint8_t len4[4];
        size_t nr = fread(len4, 1, 4, fp);
        if (nr == 0) break;
        if (nr != 4) { rc = PBF_ERR_FORMAT; break; }
        uint32_t hlen = ((uint32_t)len4[0] << 24) | ((uint32_t)len4[1] << 16) |
                        ((uint32_t)len4[2] << 8)  | ((uint32_t)len4[3]);
        if (hlen == 0 || hlen > MAX_HEADER_LEN) { rc = PBF_ERR_FORMAT; break; }
        if (fread(hdr_buf, 1, hlen, fp) != hlen) { rc = PBF_ERR_FORMAT; break; }

        int is_data = 0;
        uint32_t dsize = 0;
        if (!parse_blob_header(hdr_buf, hlen, &is_data, &dsize) || dsize > MAX_BLOB_LEN) {
            rc = PBF_ERR_FORMAT;
            break;
        }

        if (!is_data) {
            if (fseeko(fp, (off_t)dsize, SEEK_CUR) != 0) { rc = PBF_ERR_IO; break; }
            continue;
        }

        uint8_t *bbuf = (uint8_t *)malloc(dsize);
        if (!bbuf) { rc = PBF_ERR_OOM; break; }
        if (fread(bbuf, 1, dsize, fp) != dsize) {
            free(bbuf);
            rc = PBF_ERR_FORMAT;
            break;
        }

        if (!bq_push(&q, bbuf, dsize)) {
            break;
        }

        blob_idx++;
        if (prog_cb && (blob_idx & 63) == 0) {
            off_t cur = ftello(fp);
            double f = (double)cur / (double)fsize;
            if (f > 1.0) f = 1.0;
            prog_cb(f);
        }
    }

    if (rc != PBF_OK) bq_fail(&q, rc);
    else bq_finish(&q);

    for (int i = 0; i < n_threads; i++) {
        pthread_join(tids[i], NULL);
    }

    int final_rc = q.err ? q.err : rc;
    bq_destroy(&q);
    fclose(fp);
    if (final_rc == PBF_OK && prog_cb) prog_cb(1.0);
    return final_rc;
}

static int cmp_noderec(const void *a, const void *b) {
    int64_t ia = ((const NodeRec *)a)->id;
    int64_t ib = ((const NodeRec *)b)->id;
    return (ia > ib) - (ia < ib);
}

/* ------------------------------------------------------------------ Public C API */

/*
 * Scan all nodes in `path` falling inside any padded box (boxes_swne: n_boxes * 4 doubles
 * [south, west, north, east] in degrees, padded by pad_deg).
 * Allocates output arrays via malloc; caller must free them with pbf_free_nodes().
 * Returns 0 on success, negative PBF_ERR_* on failure.
 */
int pbf_scan_nodes_in_boxes(const char *path,
                            int n_boxes,
                            const double *boxes_swne,
                            double pad_deg,
                            int n_threads,
                            progress_cb_t prog_cb,
                            int64_t **out_ids,
                            int32_t **out_lat_e7,
                            int32_t **out_lon_e7,
                            uint32_t **out_mask,
                            int64_t *out_count) {
    *out_ids = NULL;
    *out_lat_e7 = NULL;
    *out_lon_e7 = NULL;
    *out_mask = NULL;
    *out_count = 0;

    if (n_boxes <= 0 || n_boxes > MAX_BOXES) return PBF_ERR_UNSUPPORTED;

    BoxSpec bs;
    memset(&bs, 0, sizeof(bs));
    bs.n_boxes = n_boxes;
    int64_t pad_nd = (int64_t)llround(pad_deg * 1e9);

    for (int i = 0; i < n_boxes; i++) {
        int64_t s = (int64_t)llround(boxes_swne[i * 4 + 0] * 1e9);
        int64_t w = (int64_t)llround(boxes_swne[i * 4 + 1] * 1e9);
        int64_t n = (int64_t)llround(boxes_swne[i * 4 + 2] * 1e9);
        int64_t e = (int64_t)llround(boxes_swne[i * 4 + 3] * 1e9);
        bs.exact[i].s_ndeg = s;
        bs.exact[i].w_ndeg = w;
        bs.exact[i].n_ndeg = n;
        bs.exact[i].e_ndeg = e;
        bs.padded[i].s_ndeg = s - pad_nd;
        bs.padded[i].w_ndeg = w - pad_nd;
        bs.padded[i].n_ndeg = n + pad_nd;
        bs.padded[i].e_ndeg = e + pad_nd;
        if (i == 0) {
            bs.union_pad = bs.padded[0];
        } else {
            if (bs.padded[i].s_ndeg < bs.union_pad.s_ndeg) bs.union_pad.s_ndeg = bs.padded[i].s_ndeg;
            if (bs.padded[i].w_ndeg < bs.union_pad.w_ndeg) bs.union_pad.w_ndeg = bs.padded[i].w_ndeg;
            if (bs.padded[i].n_ndeg > bs.union_pad.n_ndeg) bs.union_pad.n_ndeg = bs.padded[i].n_ndeg;
            if (bs.padded[i].e_ndeg > bs.union_pad.e_ndeg) bs.union_pad.e_ndeg = bs.padded[i].e_ndeg;
        }
    }

    if (n_threads < 1) n_threads = 1;
    if (n_threads > 8) n_threads = 8;
    WorkerArg workers[8];
    int rc = run_pbf_node_scan(path, n_threads, &bs, NULL, workers, prog_cb);
    if (rc != PBF_OK) {
        for (int i = 0; i < n_threads; i++) free(workers[i].vec.data);
        return rc;
    }

    size_t total = 0;
    for (int i = 0; i < n_threads; i++) total += workers[i].vec.len;
    if (total == 0) {
        for (int i = 0; i < n_threads; i++) free(workers[i].vec.data);
        return PBF_OK;
    }

    NodeRec *all = (NodeRec *)malloc(total * sizeof(NodeRec));
    if (!all) {
        for (int i = 0; i < n_threads; i++) free(workers[i].vec.data);
        return PBF_ERR_OOM;
    }
    size_t off = 0;
    for (int i = 0; i < n_threads; i++) {
        if (workers[i].vec.len) {
            memcpy(all + off, workers[i].vec.data, workers[i].vec.len * sizeof(NodeRec));
            off += workers[i].vec.len;
        }
        free(workers[i].vec.data);
    }

    qsort(all, total, sizeof(NodeRec), cmp_noderec);

    int64_t *ids = (int64_t *)malloc(total * sizeof(int64_t));
    int32_t *lats = (int32_t *)malloc(total * sizeof(int32_t));
    int32_t *lons = (int32_t *)malloc(total * sizeof(int32_t));
    uint32_t *masks = (uint32_t *)malloc(total * sizeof(uint32_t));
    if (!ids || !lats || !lons || !masks) {
        free(all); free(ids); free(lats); free(lons); free(masks);
        return PBF_ERR_OOM;
    }

    for (size_t i = 0; i < total; i++) {
        ids[i] = all[i].id;
        lats[i] = all[i].lat_e7;
        lons[i] = all[i].lon_e7;
        masks[i] = all[i].mask;
    }
    free(all);

    *out_ids = ids;
    *out_lat_e7 = lats;
    *out_lon_e7 = lons;
    *out_mask = masks;
    *out_count = (int64_t)total;
    return PBF_OK;
}

void pbf_free_nodes(int64_t *ids, int32_t *lats, int32_t *lons, uint32_t *masks) {
    free(ids);
    free(lats);
    free(lons);
    free(masks);
}

/*
 * Look up coordinates for a sorted unique int64 array `sorted_ids[n]`.
 * Pre-fills out_lat_e7 and out_lon_e7 with INT32_MIN (missing sentinel).
 * Returns 0 on success, negative PBF_ERR_* on failure.
 */
int pbf_lookup_nodes_by_ids(const char *path,
                            const int64_t *sorted_ids,
                            int64_t n,
                            int n_threads,
                            progress_cb_t prog_cb,
                            int32_t *out_lat_e7,
                            int32_t *out_lon_e7) {
    if (n <= 0) return PBF_OK;
    for (int64_t i = 0; i < n; i++) {
        out_lat_e7[i] = INT32_MIN;
        out_lon_e7[i] = INT32_MIN;
    }
    LookupSpec ls;
    ls.ids = sorted_ids;
    ls.n = n;
    ls.min_id = sorted_ids[0];
    ls.max_id = sorted_ids[n - 1];
    ls.lat_e7 = out_lat_e7;
    ls.lon_e7 = out_lon_e7;

    if (n_threads < 1) n_threads = 1;
    if (n_threads > 8) n_threads = 8;
    WorkerArg workers[8];
    int rc = run_pbf_node_scan(path, n_threads, NULL, &ls, workers, prog_cb);
    for (int i = 0; i < n_threads; i++) free(workers[i].vec.data);
    return rc;
}

/*
 * Given sorted node IDs `sorted_ids[n]` with exact-box bitmasks `masks[n]`,
 * and a batch of `n_ways` ways whose node refs are concatenated in `refs`
 * with offsets `way_off[0..n_ways]`, compute the OR'd box bitmask for each way.
 */
void pbf_way_box_masks(const int64_t *sorted_ids,
                       const uint32_t *masks,
                       int64_t n,
                       const int64_t *refs,
                       const int64_t *way_off,
                       int64_t n_ways,
                       uint32_t *out_masks) {
    if (n <= 0) {
        memset(out_masks, 0, (size_t)n_ways * sizeof(uint32_t));
        return;
    }
    int64_t min_id = sorted_ids[0];
    int64_t max_id = sorted_ids[n - 1];
    for (int64_t w = 0; w < n_ways; w++) {
        int64_t a = way_off[w], b = way_off[w + 1];
        uint32_t m = 0;
        for (int64_t i = a; i < b; i++) {
            int64_t r = refs[i];
            if (r < min_id || r > max_id) continue;
            int64_t idx = bsearch_id(sorted_ids, n, r);
            if (idx >= 0) m |= masks[idx];
        }
        out_masks[w] = m;
    }
}

uint32_t pbf_way_box_mask_one(const int64_t *sorted_ids,
                              const uint32_t *masks,
                              int64_t n,
                              const int64_t *refs,
                              int64_t n_refs) {
    if (n <= 0 || n_refs <= 0) return 0;
    int64_t min_id = sorted_ids[0];
    int64_t max_id = sorted_ids[n - 1];
    uint32_t m = 0;
    for (int64_t i = 0; i < n_refs; i++) {
        int64_t r = refs[i];
        if (r < min_id || r > max_id) continue;
        int64_t idx = bsearch_id(sorted_ids, n, r);
        if (idx >= 0) m |= masks[idx];
    }
    return m;
}
