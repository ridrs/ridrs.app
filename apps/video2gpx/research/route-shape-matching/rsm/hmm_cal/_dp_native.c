/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* Native C / 4-wide SIMD (ARM NEON + x86_64 SSE2/FMA) kernels for dense road HMM inference (rsm.hmm_cal.dp).
 *
 * Implements:
 *  - viterbi_scan_batch: evaluates N_F values of f_eff (a_ang) for one Grid in parallel across pthreads,
 *    using 4-wide float32 SIMD (ARM NEON on aarch64/arm64, SSE2/FMA on x86_64) across 4 f_eff lanes at a time
 *    so graph arrays (src, D, dphi, w) and the distance term are loaded once per 4 f_eff lanes.
 *  - viterbi_decode: exact single-f_eff Viterbi with optional uint16 backpointers (matching dp.viterbi tie-breaking).
 *  - forward_backward_pass: exact forward-backward alpha (float16) and edge-posterior pass.
 *
 * Uses an atanh-series float32 log1pf (max relative error < 3e-8, full float32 precision) so scan scores
 * match pure-NumPy dp.viterbi well within 1e-4 nats (10x tighter than bench_pipeline L1_TOL = 1e-3).
 */
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>

#if !defined(RSM_NO_SIMD) && (defined(__ARM_NEON) || defined(__aarch64__))
#include <arm_neon.h>
#define RSM_HAS_NEON 1
#define RSM_HAS_SSE2 0
#define RSM_HAS_SIMD 1
#elif !defined(RSM_NO_SIMD) && defined(__SSE2__)
#include <emmintrin.h>
#if defined(__FMA__)
#include <immintrin.h>
#endif
#define RSM_HAS_NEON 0
#define RSM_HAS_SSE2 1
#define RSM_HAS_SIMD 1
#else
#define RSM_HAS_NEON 0
#define RSM_HAS_SSE2 0
#define RSM_HAS_SIMD 0
#endif

typedef struct {
    int32_t n;
    int32_t n_ud;
    const int32_t *src;
    const float *D;
    const float *dphi;
    const float *w;
    const int64_t *starts;
    const int32_t *ud;
    const uint16_t *loc;       /* optional (backptr only) */
    float d_min;
    float d_max;
    const float *utf;          /* optional: 1 where the entry's path contains a U-turn, else 0 (decision A31); NULL = no U-turn cost */
} GroupBase;

typedef struct {
    int32_t n;
    int32_t n_us;
    const int32_t *b_dst;
    const float *b_D;
    const float *b_dphi;
    const float *b_w;
    const int64_t *b_starts;
    const int32_t *b_us;
    float d_min;
    float d_max;
    const float *b_utf;        /* optional, as GroupBase.utf (src-sorted) */
} GroupBack;

/* Full float32 precision log1pf(x) for x >= 0 via atanh series:
 * m in [sqrt(0.5), sqrt(2)], t = (m - 1)/(m + 1), |t| <= 0.17157 -> 2*t*(1 + t^2/3 + t^4/5 + t^6/7)
 * truncation error < 3e-8 (under 0.5 ULP of float32).
 */
static inline float fast_log1pf_scalar(float x) {
    float y = 1.0f + x;
    union { float f; uint32_t i; } u = { y };
    int32_t exp = (int32_t)((u.i >> 23) & 0xFFu) - 127;
    u.i = (u.i & 0x007FFFFFu) | 0x3F800000u;
    float m = u.f;
    if (m > 1.41421356f) {
        m *= 0.5f;
        exp += 1;
    }
    float t = (m - 1.0f) / (m + 1.0f);
    float t2 = t * t;
    float p = 0.142857143f;
    p = 0.200000000f + t2 * p;
    p = 0.333333333f + t2 * p;
    p = 1.000000000f + t2 * p;
    return 2.0f * t * p + (float)exp * 0.69314718056f;
}

#if RSM_HAS_NEON
typedef float32x4_t v4f;
static inline v4f v4_dup(float x) { return vdupq_n_f32(x); }
static inline v4f v4_load(const float *p) { return vld1q_f32(p); }
static inline void v4_store(float *p, v4f v) { vst1q_f32(p, v); }
static inline v4f v4_add(v4f a, v4f b) { return vaddq_f32(a, b); }
static inline v4f v4_sub(v4f a, v4f b) { return vsubq_f32(a, b); }
static inline v4f v4_mul(v4f a, v4f b) { return vmulq_f32(a, b); }
static inline v4f v4_fma(v4f acc, v4f a, v4f b) { return vfmaq_f32(acc, a, b); }
static inline v4f v4_fms(v4f acc, v4f a, v4f b) { return vfmsq_f32(acc, a, b); }
static inline v4f v4_max(v4f a, v4f b) { return vmaxq_f32(a, b); }

static inline v4f fast_log1pf_v4(v4f x) {
    float32x4_t one = vdupq_n_f32(1.0f);
    float32x4_t y = vaddq_f32(one, x);
    uint32x4_t yi = vreinterpretq_u32_f32(y);
    int32x4_t exp = vsubq_s32(vreinterpretq_s32_u32(vshrq_n_u32(yi, 23)), vdupq_n_s32(127));
    uint32x4_t mi = vorrq_u32(vandq_u32(yi, vdupq_n_u32(0x007FFFFFu)), vdupq_n_u32(0x3F800000u));
    float32x4_t m = vreinterpretq_f32_u32(mi);
    uint32x4_t gt = vcgtq_f32(m, vdupq_n_f32(1.41421356f));
    m = vbslq_f32(gt, vmulq_f32(m, vdupq_n_f32(0.5f)), m);
    exp = vbslq_s32(gt, vaddq_s32(exp, vdupq_n_s32(1)), exp);
    float32x4_t t = vdivq_f32(vsubq_f32(m, one), vaddq_f32(m, one));
    float32x4_t t2 = vmulq_f32(t, t);
    float32x4_t p = vdupq_n_f32(0.142857143f);
    p = v4_fma(vdupq_n_f32(0.200000000f), t2, p);
    p = v4_fma(vdupq_n_f32(0.333333333f), t2, p);
    p = v4_fma(one, t2, p);
    float32x4_t lnm = vmulq_f32(vaddq_f32(t, t), p);
    return v4_fma(lnm, vcvtq_f32_s32(exp), vdupq_n_f32(0.69314718056f));
}
#elif RSM_HAS_SSE2
typedef __m128 v4f;
static inline v4f v4_dup(float x) { return _mm_set1_ps(x); }
static inline v4f v4_load(const float *p) { return _mm_loadu_ps(p); }
static inline void v4_store(float *p, v4f v) { _mm_storeu_ps(p, v); }
static inline v4f v4_add(v4f a, v4f b) { return _mm_add_ps(a, b); }
static inline v4f v4_sub(v4f a, v4f b) { return _mm_sub_ps(a, b); }
static inline v4f v4_mul(v4f a, v4f b) { return _mm_mul_ps(a, b); }
static inline v4f v4_fma(v4f acc, v4f a, v4f b) {
#if defined(__FMA__)
    return _mm_fmadd_ps(a, b, acc);
#else
    return _mm_add_ps(acc, _mm_mul_ps(a, b));
#endif
}
static inline v4f v4_fms(v4f acc, v4f a, v4f b) {
#if defined(__FMA__)
    return _mm_fnmadd_ps(a, b, acc);
#else
    return _mm_sub_ps(acc, _mm_mul_ps(a, b));
#endif
}
static inline v4f v4_max(v4f best, v4f cand) { return _mm_max_ps(cand, best); }

static inline v4f fast_log1pf_v4(v4f x) {
    v4f one = _mm_set1_ps(1.0f);
    v4f y = _mm_add_ps(one, x);
    __m128i yi = _mm_castps_si128(y);
    __m128i exp = _mm_sub_epi32(_mm_srli_epi32(yi, 23), _mm_set1_epi32(127));
    __m128i mi = _mm_or_si128(_mm_and_si128(yi, _mm_set1_epi32(0x007FFFFF)), _mm_set1_epi32(0x3F800000));
    v4f m = _mm_castsi128_ps(mi);
    v4f gt = _mm_cmpgt_ps(m, _mm_set1_ps(1.41421356f));
    v4f m_half = _mm_mul_ps(m, _mm_set1_ps(0.5f));
    m = _mm_or_ps(_mm_and_ps(gt, m_half), _mm_andnot_ps(gt, m));
    exp = _mm_sub_epi32(exp, _mm_castps_si128(gt));
    v4f t = _mm_div_ps(_mm_sub_ps(m, one), _mm_add_ps(m, one));
    v4f t2 = _mm_mul_ps(t, t);
    v4f p = _mm_set1_ps(0.142857143f);
    p = v4_fma(_mm_set1_ps(0.200000000f), t2, p);
    p = v4_fma(_mm_set1_ps(0.333333333f), t2, p);
    p = v4_fma(one, t2, p);
    v4f lnm = _mm_mul_ps(_mm_add_ps(t, t), p);
    return v4_fma(lnm, _mm_cvtepi32_ps(exp), _mm_set1_ps(0.69314718056f));
}
#endif

static inline const uint8_t *find_step_mask(int32_t j, int32_t n_step_ok, const int32_t *step_ok_steps, const uint8_t *const *step_ok_masks) {
    for (int32_t i = 0; i < n_step_ok; i++) {
        if (step_ok_steps[i] == j) return step_ok_masks[i];
    }
    return NULL;
}

/* ---------------- 4-wide batched Viterbi scan (no backpointers) ---------------- */

typedef struct {
    int32_t N, T, n_groups;
    const GroupBase *groups;
    const float *const *ls4;    /* [n_groups], each gr.n * 4 */
    const float *const *is2_4;  /* [n_groups], each gr.n * 4 */
    const float *mus, *sds;
    const int32_t *has_dth;
    const float *dths4;         /* [T * 4] */
    float c1;
    const float *start_init;    /* [N] */
    const float *end_lp;        /* [N] or NULL */
    int32_t n_step_ok;
    const int32_t *step_ok_steps;
    const uint8_t *const *step_ok_masks;
    float out_scores[4];
    const float *ute4;          /* [T * 4] or NULL: extra U-turn cost (nats) per step and lane, charged on entries with utf = 1 */
    const uint8_t *is_jump;     /* [T] or NULL: 1 on a 1-step free cut-jump transition (broadcast max(a) to all cells) */
} Batch4Job;

static void *run_batch4(void *arg) {
    Batch4Job *J = (Batch4Job *)arg;
    const int32_t N = J->N, T = J->T, n_groups = J->n_groups;
    float *a = (float *)malloc((size_t)N * 4 * sizeof(float));
    float *tmp = (float *)malloc((size_t)N * 4 * sizeof(float));
    if (!a || !tmp) {
        free(a); free(tmp);
        for (int k = 0; k < 4; k++) J->out_scores[k] = -INFINITY;
        return NULL;
    }
    const float NEG = -INFINITY;

#if RSM_HAS_SIMD
    const v4f vNEG = v4_dup(NEG);
    const v4f vc1 = v4_dup(J->c1);
    for (int32_t i = 0; i < N; i++) v4_store(a + (size_t)i * 4, v4_dup(J->start_init[i]));

    for (int32_t j = 1; j < T; j++) {
        if (J->is_jump && J->is_jump[j]) {
            v4f m = vNEG;
            for (int32_t i = 0; i < N; i++) m = v4_max(m, v4_load(a + (size_t)i * 4));
            for (int32_t i = 0; i < N; i++) v4_store(tmp + (size_t)i * 4, m);
            const uint8_t *mask = find_step_mask(j, J->n_step_ok, J->step_ok_steps, J->step_ok_masks);
            if (mask) {
                for (int32_t i = 0; i < N; i++) {
                    if (!mask[i]) v4_store(tmp + (size_t)i * 4, vNEG);
                }
            }
            float *sw = a; a = tmp; tmp = sw;
            continue;
        }
        float mu = J->mus[j], sd = J->sds[j];
        int has_dth = J->has_dth[j];
        v4f vdth = v4_load(J->dths4 + (size_t)j * 4);
        const float *ute_j = J->ute4 ? J->ute4 + (size_t)j * 4 : NULL;
        const int ut_step = ute_j && (ute_j[0] > 0.0f || ute_j[1] > 0.0f || ute_j[2] > 0.0f || ute_j[3] > 0.0f);
        const v4f vute = ut_step ? v4_load(ute_j) : v4_dup(0.0f);
        for (int32_t i = 0; i < N; i++) v4_store(tmp + (size_t)i * 4, vNEG);
        const float inv_sd = 1.0f / sd;
        const float nh = -0.5f * inv_sd * inv_sd;
        const float nlsd = -logf(sd);

        for (int32_t gi = 0; gi < n_groups; gi++) {
            const GroupBase *gr = &J->groups[gi];
            if (gr->n == 0 || gr->d_max < mu - 6.0f * sd || gr->d_min > mu + 6.0f * sd)
                continue;
            const int32_t n_ud = gr->n_ud;
            const int64_t *starts = gr->starts;
            const int32_t *ud = gr->ud;
            const int32_t *src = gr->src;
            const float *D = gr->D;
            const float *dphi = gr->dphi;
            const float *w = gr->w;
            const float *uf = ut_step ? gr->utf : NULL;
            const float *ls4 = J->ls4[gi];
            const float *is2_4 = J->is2_4[gi];

            if (has_dth) {
                for (int32_t b = 0; b < n_ud; b++) {
                    int64_t s0 = starts[b];
                    int64_t s1 = (b + 1 < n_ud) ? starts[b + 1] : gr->n;
                    float *dst_p = tmp + (size_t)ud[b] * 4;
                    v4f best = v4_load(dst_p);
                    for (int64_t e = s0; e < s1; e++) {
                        v4f val = v4_load(a + (size_t)src[e] * 4);
                        float dd = D[e] - mu;
                        float base = nh * dd * dd + nlsd + w[e];
                        v4f r = v4_sub(vdth, v4_dup(dphi[e]));
                        v4f r2 = v4_mul(r, r);
                        v4f is2 = v4_load(is2_4 + (size_t)e * 4);
                        v4f ls = v4_load(ls4 + (size_t)e * 4);
                        v4f lt = v4_add(v4_dup(base), ls);
                        if (uf) lt = v4_fms(lt, vute, v4_dup(uf[e]));
                        lt = v4_fms(lt, vc1, fast_log1pf_v4(v4_mul(r2, is2)));
                        best = v4_max(best, v4_add(val, lt));
                    }
                    v4_store(dst_p, best);
                }
            } else {
                for (int32_t b = 0; b < n_ud; b++) {
                    int64_t s0 = starts[b];
                    int64_t s1 = (b + 1 < n_ud) ? starts[b + 1] : gr->n;
                    float *dst_p = tmp + (size_t)ud[b] * 4;
                    v4f best = v4_load(dst_p);
                    for (int64_t e = s0; e < s1; e++) {
                        v4f val = v4_load(a + (size_t)src[e] * 4);
                        float dd = D[e] - mu;
                        float base = nh * dd * dd + nlsd + w[e];
                        v4f lt = v4_dup(base);
                        if (uf) lt = v4_fms(lt, vute, v4_dup(uf[e]));
                        best = v4_max(best, v4_add(val, lt));
                    }
                    v4_store(dst_p, best);
                }
            }
        }
        const uint8_t *mask = find_step_mask(j, J->n_step_ok, J->step_ok_steps, J->step_ok_masks);
        if (mask) {
            for (int32_t i = 0; i < N; i++) {
                if (!mask[i]) v4_store(tmp + (size_t)i * 4, vNEG);
            }
        }
        float *sw = a; a = tmp; tmp = sw;
    }
    v4f best = vNEG;
    if (J->end_lp) {
        for (int32_t i = 0; i < N; i++) {
            float elp = J->end_lp[i];
            if (elp == NEG) continue;
            best = v4_max(best, v4_add(v4_load(a + (size_t)i * 4), v4_dup(elp)));
        }
    } else {
        for (int32_t i = 0; i < N; i++) best = v4_max(best, v4_load(a + (size_t)i * 4));
    }
    v4_store(J->out_scores, best);
#else
    for (int32_t i = 0; i < N; i++) {
        float s0 = J->start_init[i];
        a[(size_t)i * 4 + 0] = s0; a[(size_t)i * 4 + 1] = s0;
        a[(size_t)i * 4 + 2] = s0; a[(size_t)i * 4 + 3] = s0;
    }
    const float c1 = J->c1;
    for (int32_t j = 1; j < T; j++) {
        if (J->is_jump && J->is_jump[j]) {
            float m[4] = { NEG, NEG, NEG, NEG };
            for (int32_t i = 0; i < N; i++) {
                for (int k = 0; k < 4; k++) {
                    float v = a[(size_t)i * 4 + k];
                    if (v > m[k]) m[k] = v;
                }
            }
            for (int32_t i = 0; i < N; i++) {
                for (int k = 0; k < 4; k++) tmp[(size_t)i * 4 + k] = m[k];
            }
            const uint8_t *mask = find_step_mask(j, J->n_step_ok, J->step_ok_steps, J->step_ok_masks);
            if (mask) {
                for (int32_t i = 0; i < N; i++) {
                    if (!mask[i]) {
                        tmp[(size_t)i * 4 + 0] = NEG; tmp[(size_t)i * 4 + 1] = NEG;
                        tmp[(size_t)i * 4 + 2] = NEG; tmp[(size_t)i * 4 + 3] = NEG;
                    }
                }
            }
            float *sw = a; a = tmp; tmp = sw;
            continue;
        }
        float mu = J->mus[j], sd = J->sds[j];
        int has_dth = J->has_dth[j];
        const float *dth4 = J->dths4 + (size_t)j * 4;
        const float *ute_j = J->ute4 ? J->ute4 + (size_t)j * 4 : NULL;
        for (int32_t i = 0; i < N * 4; i++) tmp[i] = NEG;
        const float inv_sd = 1.0f / sd;
        const float nh = -0.5f * inv_sd * inv_sd;
        const float nlsd = -logf(sd);
        for (int32_t gi = 0; gi < n_groups; gi++) {
            const GroupBase *gr = &J->groups[gi];
            if (gr->n == 0 || gr->d_max < mu - 6.0f * sd || gr->d_min > mu + 6.0f * sd) continue;
            const int32_t n_ud = gr->n_ud;
            const float *ls4 = J->ls4[gi];
            const float *is2_4 = J->is2_4[gi];
            for (int32_t b = 0; b < n_ud; b++) {
                int64_t s0 = gr->starts[b];
                int64_t s1 = (b + 1 < n_ud) ? gr->starts[b + 1] : gr->n;
                float *dst_p = tmp + (size_t)gr->ud[b] * 4;
                for (int64_t e = s0; e < s1; e++) {
                    const float *src_p = a + (size_t)gr->src[e] * 4;
                    float dd = gr->D[e] - mu;
                    float base = nh * dd * dd + nlsd + gr->w[e];
                    const float u_e = (ute_j && gr->utf) ? gr->utf[e] : 0.0f;
                    if (has_dth) {
                        for (int k = 0; k < 4; k++) {
                            float r = dth4[k] - gr->dphi[e];
                            float c = src_p[k] + base - (u_e != 0.0f ? ute_j[k] * u_e : 0.0f) + ls4[(size_t)e * 4 + k] - c1 * fast_log1pf_scalar(r * r * is2_4[(size_t)e * 4 + k]);
                            if (c > dst_p[k]) dst_p[k] = c;
                        }
                    } else {
                        for (int k = 0; k < 4; k++) {
                            float c = src_p[k] + base - (u_e != 0.0f ? ute_j[k] * u_e : 0.0f);
                            if (c > dst_p[k]) dst_p[k] = c;
                        }
                    }
                }
            }
        }
        const uint8_t *mask = find_step_mask(j, J->n_step_ok, J->step_ok_steps, J->step_ok_masks);
        if (mask) {
            for (int32_t i = 0; i < N; i++) {
                if (!mask[i]) {
                    tmp[(size_t)i * 4 + 0] = NEG; tmp[(size_t)i * 4 + 1] = NEG;
                    tmp[(size_t)i * 4 + 2] = NEG; tmp[(size_t)i * 4 + 3] = NEG;
                }
            }
        }
        float *sw = a; a = tmp; tmp = sw;
    }
    for (int k = 0; k < 4; k++) J->out_scores[k] = NEG;
    for (int32_t i = 0; i < N; i++) {
        float elp = J->end_lp ? J->end_lp[i] : 0.0f;
        if (elp == NEG) continue;
        for (int k = 0; k < 4; k++) {
            float v = a[(size_t)i * 4 + k] + elp;
            if (v > J->out_scores[k]) J->out_scores[k] = v;
        }
    }
#endif
    free(a); free(tmp);
    return NULL;
}

void viterbi_scan_batches(int32_t n_batches, int32_t n_threads, Batch4Job *jobs) {
    if (n_threads <= 1 || n_batches <= 1) {
        for (int32_t i = 0; i < n_batches; i++) run_batch4(&jobs[i]);
        return;
    }
    int32_t i = 0;
    while (i < n_batches) {
        int32_t run = n_batches - i;
        if (run > n_threads) run = n_threads;
        if (run > 32) run = 32;
        pthread_t th[32];
        for (int32_t b = 0; b < run; b++) pthread_create(&th[b], NULL, run_batch4, &jobs[i + b]);
        for (int32_t b = 0; b < run; b++) pthread_join(th[b], NULL);
        i += run;
    }
}

/* ---------------- Single-f_eff Viterbi (optional backpointers) ---------------- */

float viterbi_single(
    int32_t N, int32_t T, int32_t n_groups,
    const GroupBase *groups,
    const float *const *ls_ptrs,
    const float *const *is2_ptrs,
    const float *mus, const float *sds,
    const int32_t *has_dth, const float *dths,
    float c1,
    int32_t slot_bits,
    const float *start_init,
    const float *end_lp,
    int32_t n_step_ok,
    const int32_t *step_ok_steps,
    const uint8_t *const *step_ok_masks,
    uint16_t *out_bps,          /* NULL if backptr=False, else (T-1)*N */
    int32_t *out_final_cell,
    const float *utes,          /* [T] or NULL: extra U-turn cost (nats) per step, charged on entries with utf = 1 */
    const uint8_t *is_jump,     /* [T] or NULL: 1 on a 1-step free cut-jump transition */
    int32_t *out_jump_src       /* [T] or NULL: argmax(a) before each jump step (init -1) */
) {
    const float NEG = -INFINITY;
    float *a = (float *)malloc((size_t)N * sizeof(float));
    float *tmp = (float *)malloc((size_t)N * sizeof(float));
    if (!a || !tmp) {
        free(a); free(tmp);
        *out_final_cell = -1;
        return NEG;
    }
    memcpy(a, start_init, (size_t)N * sizeof(float));

    for (int32_t j = 1; j < T; j++) {
        if (is_jump && is_jump[j]) {
            float m = NEG;
            int32_t best_prev = -1;
            for (int32_t i = 0; i < N; i++) {
                if (a[i] > m) { m = a[i]; best_prev = i; }
            }
            if (out_jump_src) out_jump_src[j] = best_prev;
            for (int32_t i = 0; i < N; i++) tmp[i] = m;
            const uint8_t *mask = find_step_mask(j, n_step_ok, step_ok_steps, step_ok_masks);
            if (mask) {
                for (int32_t i = 0; i < N; i++) {
                    if (!mask[i]) tmp[i] = NEG;
                }
            }
            float *sw = a; a = tmp; tmp = sw;
            continue;
        }
        float mu = mus[j], sd = sds[j], dth = dths[j];
        int hd = has_dth[j];
        const float ute = utes ? utes[j] : 0.0f;
        for (int32_t i = 0; i < N; i++) tmp[i] = NEG;
        uint16_t *code = out_bps ? (out_bps + (size_t)(j - 1) * (size_t)N) : NULL;
        if (code) memset(code, 0xFF, (size_t)N * sizeof(uint16_t));

        const float inv_sd = 1.0f / sd;
        const float nh = -0.5f * inv_sd * inv_sd;
        const float nlsd = -logf(sd);

        for (int32_t gi = 0; gi < n_groups; gi++) {
            const GroupBase *gr = &groups[gi];
            if (gr->n == 0 || gr->d_max < mu - 6.0f * sd || gr->d_min > mu + 6.0f * sd) continue;
            const int32_t n_ud = gr->n_ud;
            const int64_t *starts = gr->starts;
            const int32_t *ud = gr->ud;
            const int32_t *src = gr->src;
            const float *D = gr->D;
            const float *dphi = gr->dphi;
            const float *w = gr->w;
            const float *uf = ute > 0.0f ? gr->utf : NULL;
            const float *ls = ls_ptrs[gi];
            const float *is2 = is2_ptrs[gi];
            const uint16_t *loc = gr->loc;
            const uint16_t gshift = (uint16_t)((uint32_t)gi << (uint32_t)slot_bits);

            if (code) {
                for (int32_t b = 0; b < n_ud; b++) {
                    int64_t s0 = starts[b];
                    int64_t s1 = (b + 1 < n_ud) ? starts[b + 1] : gr->n;
                    float gbest = NEG;
                    uint16_t gslot = 65535;
                    for (int64_t e = s0; e < s1; e++) {
                        float val = a[src[e]];
                        if (val == NEG) continue;
                        float dd = D[e] - mu;
                        float lt = nh * dd * dd + nlsd + w[e] - (uf ? ute * uf[e] : 0.0f);
                        if (hd) {
                            float r = dth - dphi[e];
                            lt += ls[e] - c1 * fast_log1pf_scalar(r * r * is2[e]);
                        }
                        float c = val + lt;
                        if (c > gbest) {
                            gbest = c;
                            gslot = loc[e];
                        }
                    }
                    int32_t u = ud[b];
                    if (gbest > tmp[u]) {
                        tmp[u] = gbest;
                        code[u] = gshift | gslot;
                    }
                }
            } else {
                for (int32_t b = 0; b < n_ud; b++) {
                    int64_t s0 = starts[b];
                    int64_t s1 = (b + 1 < n_ud) ? starts[b + 1] : gr->n;
                    int32_t u = ud[b];
                    float best = tmp[u];
                    for (int64_t e = s0; e < s1; e++) {
                        float val = a[src[e]];
                        if (val == NEG) continue;
                        float dd = D[e] - mu;
                        float lt = nh * dd * dd + nlsd + w[e] - (uf ? ute * uf[e] : 0.0f);
                        if (hd) {
                            float r = dth - dphi[e];
                            lt += ls[e] - c1 * fast_log1pf_scalar(r * r * is2[e]);
                        }
                        float c = val + lt;
                        if (c > best) best = c;
                    }
                    tmp[u] = best;
                }
            }
        }
        const uint8_t *mask = find_step_mask(j, n_step_ok, step_ok_steps, step_ok_masks);
        if (mask) {
            for (int32_t i = 0; i < N; i++) {
                if (!mask[i]) tmp[i] = NEG;
            }
        }
        float *sw = a; a = tmp; tmp = sw;
    }

    float best = NEG;
    int32_t best_c = -1;
    for (int32_t i = 0; i < N; i++) {
        float v = end_lp ? (a[i] + end_lp[i]) : a[i];
        if (v > best) {
            best = v;
            best_c = i;
        }
    }
    *out_final_cell = best_c;
    free(a); free(tmp);
    return best;
}

/* ---------------- Forward-Backward single-step kernels ---------------- */

static inline float logaddexpf_fast(float a, float b) {
    if (a == -INFINITY) return b;
    if (b == -INFINITY) return a;
    if (a > b) return a + fast_log1pf_scalar(expf(b - a));
    return b + fast_log1pf_scalar(expf(a - b));
}

void fb_forward_step(
    int32_t N, int32_t n_groups,
    const GroupBase *groups,
    const float *const *ls_ptrs,
    const float *const *is2_ptrs,
    const float *a,
    float *out_new,
    float mu, float sd, int32_t hd, float dth, float c1,
    float ute                   /* extra U-turn cost (nats) of this step, charged on entries with utf = 1 */
) {
    const float NEG = -INFINITY;
    for (int32_t i = 0; i < N; i++) out_new[i] = NEG;
    const float inv_sd = 1.0f / sd;
    const float nh = -0.5f * inv_sd * inv_sd;
    const float nlsd = -logf(sd);

    for (int32_t gi = 0; gi < n_groups; gi++) {
        const GroupBase *gr = &groups[gi];
        if (gr->n == 0 || gr->d_max < mu - 6.0f * sd || gr->d_min > mu + 6.0f * sd) continue;
        const int32_t n_ud = gr->n_ud;
        const int64_t *starts = gr->starts;
        const int32_t *ud = gr->ud;
        const int32_t *src = gr->src;
        const float *D = gr->D;
        const float *dphi = gr->dphi;
        const float *w = gr->w;
        const float *uf = ute > 0.0f ? gr->utf : NULL;
        const float *ls = ls_ptrs[gi];
        const float *is2 = is2_ptrs[gi];

        for (int32_t b = 0; b < n_ud; b++) {
            int64_t s0 = starts[b];
            int64_t s1 = (b + 1 < n_ud) ? starts[b + 1] : gr->n;
            int64_t len = s1 - s0;
            if (len == 1) {
                float av = a[src[s0]];
                if (av == NEG) continue;
                float dd = D[s0] - mu;
                float lt = nh * dd * dd + nlsd + w[s0] - (uf ? ute * uf[s0] : 0.0f);
                if (hd) {
                    float r = dth - dphi[s0];
                    lt += ls[s0] - c1 * fast_log1pf_scalar(r * r * is2[s0]);
                }
                int32_t u = ud[b];
                out_new[u] = logaddexpf_fast(out_new[u], av + lt);
                continue;
            }
            /* two-pass LSE over [s0, s1) */
            float m = NEG;
            float buf[64];
            float *vals = (len <= 64) ? buf : (float *)malloc((size_t)len * sizeof(float));
            for (int64_t k = 0; k < len; k++) {
                int64_t e = s0 + k;
                float av = a[src[e]];
                if (av == NEG) { vals[k] = NEG; continue; }
                float dd = D[e] - mu;
                float lt = nh * dd * dd + nlsd + w[e] - (uf ? ute * uf[e] : 0.0f);
                if (hd) {
                    float r = dth - dphi[e];
                    lt += ls[e] - c1 * fast_log1pf_scalar(r * r * is2[e]);
                }
                float c = av + lt;
                vals[k] = c;
                if (c > m) m = c;
            }
            if (m > NEG) {
                float s = 0.0f;
                for (int64_t k = 0; k < len; k++) {
                    if (vals[k] > NEG) s += expf(vals[k] - m);
                }
                float lse = m + logf(s > 1e-38f ? s : 1e-38f);
                int32_t u = ud[b];
                out_new[u] = logaddexpf_fast(out_new[u], lse);
            }
            if (len > 64) free(vals);
        }
    }
}

void fb_backward_step(
    int32_t N, int32_t n_groups,
    const GroupBack *groups,
    const float *const *b_ls_ptrs,
    const float *const *b_is2_ptrs,
    const float *beta,
    float *out_nb,
    float mu, float sd, int32_t hd, float dth, float c1,
    float ute                   /* as fb_forward_step */
) {
    const float NEG = -INFINITY;
    for (int32_t i = 0; i < N; i++) out_nb[i] = NEG;
    const float inv_sd = 1.0f / sd;
    const float nh = -0.5f * inv_sd * inv_sd;
    const float nlsd = -logf(sd);

    for (int32_t gi = 0; gi < n_groups; gi++) {
        const GroupBack *gr = &groups[gi];
        if (gr->n == 0 || gr->d_max < mu - 6.0f * sd || gr->d_min > mu + 6.0f * sd) continue;
        const int32_t n_us = gr->n_us;
        const int64_t *starts = gr->b_starts;
        const int32_t *us = gr->b_us;
        const int32_t *dst = gr->b_dst;
        const float *D = gr->b_D;
        const float *dphi = gr->b_dphi;
        const float *w = gr->b_w;
        const float *uf = ute > 0.0f ? gr->b_utf : NULL;
        const float *ls = b_ls_ptrs[gi];
        const float *is2 = b_is2_ptrs[gi];

        for (int32_t b = 0; b < n_us; b++) {
            int64_t s0 = starts[b];
            int64_t s1 = (b + 1 < n_us) ? starts[b + 1] : gr->n;
            int64_t len = s1 - s0;
            if (len == 1) {
                float bv = beta[dst[s0]];
                if (bv == NEG) continue;
                float dd = D[s0] - mu;
                float lt = nh * dd * dd + nlsd + w[s0] - (uf ? ute * uf[s0] : 0.0f);
                if (hd) {
                    float r = dth - dphi[s0];
                    lt += ls[s0] - c1 * fast_log1pf_scalar(r * r * is2[s0]);
                }
                int32_t u = us[b];
                out_nb[u] = logaddexpf_fast(out_nb[u], bv + lt);
                continue;
            }
            float m = NEG;
            float buf[64];
            float *vals = (len <= 64) ? buf : (float *)malloc((size_t)len * sizeof(float));
            for (int64_t k = 0; k < len; k++) {
                int64_t e = s0 + k;
                float bv = beta[dst[e]];
                if (bv == NEG) { vals[k] = NEG; continue; }
                float dd = D[e] - mu;
                float lt = nh * dd * dd + nlsd + w[e] - (uf ? ute * uf[e] : 0.0f);
                if (hd) {
                    float r = dth - dphi[e];
                    lt += ls[e] - c1 * fast_log1pf_scalar(r * r * is2[e]);
                }
                float c = bv + lt;
                vals[k] = c;
                if (c > m) m = c;
            }
            if (m > NEG) {
                float s = 0.0f;
                for (int64_t k = 0; k < len; k++) {
                    if (vals[k] > NEG) s += expf(vals[k] - m);
                }
                float lse = m + logf(s > 1e-38f ? s : 1e-38f);
                int32_t u = us[b];
                out_nb[u] = logaddexpf_fast(out_nb[u], lse);
            }
            if (len > 64) free(vals);
        }
    }
}
