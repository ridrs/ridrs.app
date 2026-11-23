/* SPDX-License-Identifier: AGPL-3.0-or-later */
/*
 * Batched forward-backward pyramidal Lucas-Kanade optical flow on Apple Metal.
 *
 * Compiled on macOS into _lk_metal_<arch>.so by dev.sh / scripts/build-sidecar.sh:
 *   clang -O3 -shared -fPIC -fobjc-arc -framework Foundation -framework Metal \
 *         -o _lk_metal_$(uname -m).so _lk_metal.m
 *
 * Design:
 * - Embeds the MSL shader source and compiles in-memory via [MTLDevice newLibraryWithSource:...],
 *   so no external .metal/.metallib files or Xcode MetalToolchain are required at build or runtime.
 * - Pre-allocates a pool of N pyramid texture slots (level 0 R8Unorm, levels 1..max_level R32Float).
 * - Each batch uploads newly arrived frames, downsamples them with an OpenCV-matching 5x5 Gaussian
 *   pyramid ([1,4,6,4,1]/16 via 3x3 bilinear taps), and dispatches all forward-backward LK pairs in
 *   a single MTLCommandBuffer (1 threadgroup of 64 threads per point, Scharr template gradients cached
 *   in threadgroup memory, simd_sum reductions).
 * - Deterministic: each pair's output depends only on (frame_a, frame_b, pts, LKParams), independent
 *   of batching or slot indices.
 */
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MAX_PYR_LEVELS 5
#define MAX_HALF_WIN 10

typedef struct {
    int32_t n_pts;
    int32_t max_level;
    int32_t half_win;
    int32_t max_iter;
    float eps2;
} LKParams;

static const char *const kMetalSource =
"#include <metal_stdlib>\n"
"using namespace metal;\n"
"\n"
"struct LKParams {\n"
"    int n_pts;\n"
"    int max_level;\n"
"    int half_win;\n"
"    int max_iter;\n"
"    float eps2;\n"
"};\n"
"\n"
"kernel void pyr_down_gauss(\n"
"    texture2d<float, access::sample> src [[texture(0)]],\n"
"    texture2d<float, access::write> dst [[texture(1)]],\n"
"    uint2 gid [[thread_position_in_grid]]\n"
") {\n"
"    if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;\n"
"    constexpr sampler s(coord::pixel, filter::linear, address::clamp_to_edge);\n"
"    const float off[3] = { -1.2f, 0.0f, 1.2f };\n"
"    const float w[3]   = { 0.3125f, 0.375f, 0.3125f };\n"
"    float2 c = float2(gid) * 2.0f + float2(0.5f, 0.5f);\n"
"    float sum = 0.0f;\n"
"    for (int j = 0; j < 3; j++) {\n"
"        for (int i = 0; i < 3; i++) {\n"
"            sum += w[j] * w[i] * src.sample(s, c + float2(off[i], off[j])).r;\n"
"        }\n"
"    }\n"
"    dst.write(float4(sum, 0.0f, 0.0f, 1.0f), gid);\n"
"}\n"
"\n"
"static inline bool track_one_tg(\n"
"    array<texture2d<float, access::sample>, 5> prev_pyr,\n"
"    array<texture2d<float, access::sample>, 5> next_pyr,\n"
"    float2 pt0,\n"
"    constant LKParams &P,\n"
"    uint tid,\n"
"    threadgroup float *sh_I0,\n"
"    threadgroup float *sh_Ix,\n"
"    threadgroup float *sh_Iy,\n"
"    threadgroup float *sh_red,\n"
"    thread float2 &pt_out\n"
") {\n"
"    constexpr sampler s(coord::pixel, filter::linear, address::clamp_to_edge);\n"
"    const int hw = P.half_win;\n"
"    const int win = 2 * hw + 1;\n"
"    const int n_pix = win * win;\n"
"    float2 g = float2(0.0f);\n"
"\n"
"    for (int lvl = P.max_level; lvl >= 0; lvl--) {\n"
"        float sc = 1.0f / float(1 << lvl);\n"
"        float2 p0 = pt0 * sc + float2(0.5f, 0.5f);\n"
"        float w = float(prev_pyr[lvl].get_width());\n"
"        float h = float(prev_pyr[lvl].get_height());\n"
"        if (lvl < P.max_level) g *= 2.0f;\n"
"        threadgroup_barrier(mem_flags::mem_threadgroup);\n"
"\n"
"        float lxx = 0.0f, lxy = 0.0f, lyy = 0.0f;\n"
"        for (int idx = (int)tid; idx < n_pix; idx += 64) {\n"
"            int dy = idx / win - hw;\n"
"            int dx = idx % win - hw;\n"
"            float2 q = p0 + float2(dx, dy);\n"
"            float i0 = prev_pyr[lvl].sample(s, q).r;\n"
"            float tl = prev_pyr[lvl].sample(s, q + float2(-1.0f, -1.0f)).r;\n"
"            float tc = prev_pyr[lvl].sample(s, q + float2( 0.0f, -1.0f)).r;\n"
"            float tr = prev_pyr[lvl].sample(s, q + float2( 1.0f, -1.0f)).r;\n"
"            float ml = prev_pyr[lvl].sample(s, q + float2(-1.0f,  0.0f)).r;\n"
"            float mr = prev_pyr[lvl].sample(s, q + float2( 1.0f,  0.0f)).r;\n"
"            float bl = prev_pyr[lvl].sample(s, q + float2(-1.0f,  1.0f)).r;\n"
"            float bc = prev_pyr[lvl].sample(s, q + float2( 0.0f,  1.0f)).r;\n"
"            float br = prev_pyr[lvl].sample(s, q + float2( 1.0f,  1.0f)).r;\n"
"            float ix = (3.0f * (tr - tl) + 10.0f * (mr - ml) + 3.0f * (br - bl)) * (1.0f / 32.0f);\n"
"            float iy = (3.0f * (bl - tl) + 10.0f * (bc - tc) + 3.0f * (br - tr)) * (1.0f / 32.0f);\n"
"            sh_I0[idx] = i0;\n"
"            sh_Ix[idx] = ix;\n"
"            sh_Iy[idx] = iy;\n"
"            lxx += ix * ix;\n"
"            lxy += ix * iy;\n"
"            lyy += iy * iy;\n"
"        }\n"
"        float sxx = simd_sum(lxx), sxy = simd_sum(lxy), syy = simd_sum(lyy);\n"
"        if ((tid & 31u) == 0u) {\n"
"            uint sg = tid >> 5;\n"
"            sh_red[sg * 3 + 0] = sxx;\n"
"            sh_red[sg * 3 + 1] = sxy;\n"
"            sh_red[sg * 3 + 2] = syy;\n"
"        }\n"
"        threadgroup_barrier(mem_flags::mem_threadgroup);\n"
"        float Gxx = sh_red[0] + sh_red[3];\n"
"        float Gxy = sh_red[1] + sh_red[4];\n"
"        float Gyy = sh_red[2] + sh_red[5];\n"
"        threadgroup_barrier(mem_flags::mem_threadgroup);\n"
"        float det = Gxx * Gyy - Gxy * Gxy;\n"
"        float min_eig = 0.5f * ((Gxx + Gyy) - sqrt(max(0.0f, (Gxx - Gyy) * (Gxx - Gyy) + 4.0f * Gxy * Gxy))) / float(n_pix);\n"
"        if (det < 1e-12f || min_eig < 1e-6f) return false;\n"
"        float inv_det = 1.0f / det;\n"
"\n"
"        float2 v = g;\n"
"        for (int it = 0; it < P.max_iter; it++) {\n"
"            float2 p1 = p0 + v;\n"
"            if (p1.x < 0.0f || p1.x >= w || p1.y < 0.0f || p1.y >= h) return false;\n"
"            float lbx = 0.0f, lby = 0.0f;\n"
"            for (int idx = (int)tid; idx < n_pix; idx += 64) {\n"
"                int dy = idx / win - hw;\n"
"                int dx = idx % win - hw;\n"
"                float I1 = next_pyr[lvl].sample(s, p1 + float2(dx, dy)).r;\n"
"                float diff = sh_I0[idx] - I1;\n"
"                lbx += diff * sh_Ix[idx];\n"
"                lby += diff * sh_Iy[idx];\n"
"            }\n"
"            float sbx = simd_sum(lbx), sby = simd_sum(lby);\n"
"            if ((tid & 31u) == 0u) {\n"
"                uint sg = tid >> 5;\n"
"                sh_red[sg * 2 + 0] = sbx;\n"
"                sh_red[sg * 2 + 1] = sby;\n"
"            }\n"
"            threadgroup_barrier(mem_flags::mem_threadgroup);\n"
"            float bx = sh_red[0] + sh_red[2];\n"
"            float by = sh_red[1] + sh_red[3];\n"
"            threadgroup_barrier(mem_flags::mem_threadgroup);\n"
"            float2 d = float2((Gyy * bx - Gxy * by) * inv_det, (Gxx * by - Gxy * bx) * inv_det);\n"
"            v += d;\n"
"            if (dot(d, d) < P.eps2) break;\n"
"        }\n"
"        g = v;\n"
"    }\n"
"    float2 out = pt0 + g;\n"
"    if (out.x < 0.0f || out.x >= float(prev_pyr[0].get_width()) || out.y < 0.0f || out.y >= float(prev_pyr[0].get_height())) return false;\n"
"    pt_out = out;\n"
"    return true;\n"
"}\n"
"\n"
"kernel void lk_fb_tg(\n"
"    array<texture2d<float, access::sample>, 5> pyr_a [[texture(0)]],\n"
"    array<texture2d<float, access::sample>, 5> pyr_b [[texture(5)]],\n"
"    device const float2 *pts_in [[buffer(0)]],\n"
"    device float4 *out_flow_fb [[buffer(1)]],\n"
"    constant LKParams &P [[buffer(2)]],\n"
"    uint tgid [[threadgroup_position_in_grid]],\n"
"    uint tid [[thread_index_in_threadgroup]]\n"
") {\n"
"    if ((int)tgid >= P.n_pts) return;\n"
"    threadgroup float sh_I0[441];\n"
"    threadgroup float sh_Ix[441];\n"
"    threadgroup float sh_Iy[441];\n"
"    threadgroup float sh_red[8];\n"
"\n"
"    float2 p0 = pts_in[tgid];\n"
"    float2 p1, bk;\n"
"    bool ok1 = track_one_tg(pyr_a, pyr_b, p0, P, tid, sh_I0, sh_Ix, sh_Iy, sh_red, p1);\n"
"    if (!ok1) {\n"
"        if (tid == 0) out_flow_fb[tgid] = float4(0.0f, 0.0f, 99.0f, 0.0f);\n"
"        return;\n"
"    }\n"
"    bool ok2 = track_one_tg(pyr_b, pyr_a, p1, P, tid, sh_I0, sh_Ix, sh_Iy, sh_red, bk);\n"
"    if (tid == 0) {\n"
"        float fb = ok2 ? length(bk - p0) : 99.0f;\n"
"        out_flow_fb[tgid] = float4(p1.x - p0.x, p1.y - p0.y, fb, ok2 ? 1.0f : 0.0f);\n"
"    }\n"
"}\n";

@interface RsmMetalCtx : NSObject
@property (nonatomic, strong) id<MTLDevice> dev;
@property (nonatomic, strong) id<MTLCommandQueue> queue;
@property (nonatomic, strong) id<MTLComputePipelineState> psoDown;
@property (nonatomic, strong) id<MTLComputePipelineState> psoLK;
@property (nonatomic, strong) NSMutableArray<NSMutableArray<id<MTLTexture>> *> *pyrs;
@property (nonatomic, strong) id<MTLBuffer> bufPts;
@property (nonatomic, strong) id<MTLBuffer> bufOut;
@property (nonatomic, assign) int width;
@property (nonatomic, assign) int height;
@property (nonatomic, assign) int maxLevel;
@property (nonatomic, assign) int nSlots;
@property (nonatomic, assign) int ptsCap;
@end

@implementation RsmMetalCtx
@end

int rsm_metal_available(void) {
    @autoreleasepool {
        id<MTLDevice> dev = MTLCreateSystemDefaultDevice();
        return dev != nil ? 1 : 0;
    }
}

void *rsm_metal_create(int width, int height, int max_level, int n_slots, int init_pts_cap) {
    if (width <= 0 || height <= 0 || max_level < 0 || max_level >= MAX_PYR_LEVELS || n_slots < 2) {
        return NULL;
    }
    if (init_pts_cap < 1024) init_pts_cap = 1024;
    @autoreleasepool {
        id<MTLDevice> dev = MTLCreateSystemDefaultDevice();
        if (!dev) return NULL;
        NSError *err = nil;
        NSString *src = [NSString stringWithUTF8String:kMetalSource];
        id<MTLLibrary> lib = [dev newLibraryWithSource:src options:nil error:&err];
        if (!lib) return NULL;
        id<MTLFunction> fnDown = [lib newFunctionWithName:@"pyr_down_gauss"];
        id<MTLFunction> fnLK = [lib newFunctionWithName:@"lk_fb_tg"];
        if (!fnDown || !fnLK) return NULL;
        id<MTLComputePipelineState> psoDown = [dev newComputePipelineStateWithFunction:fnDown error:&err];
        id<MTLComputePipelineState> psoLK = [dev newComputePipelineStateWithFunction:fnLK error:&err];
        if (!psoDown || !psoLK) return NULL;
        id<MTLCommandQueue> queue = [dev newCommandQueue];
        if (!queue) return NULL;

        RsmMetalCtx *ctx = [RsmMetalCtx new];
        ctx.dev = dev;
        ctx.queue = queue;
        ctx.psoDown = psoDown;
        ctx.psoLK = psoLK;
        ctx.width = width;
        ctx.height = height;
        ctx.maxLevel = max_level;
        ctx.nSlots = n_slots;
        ctx.ptsCap = init_pts_cap;

        NSMutableArray *pyrs = [NSMutableArray arrayWithCapacity:(NSUInteger)n_slots];
        for (int s = 0; s < n_slots; s++) {
            NSMutableArray *levels = [NSMutableArray arrayWithCapacity:MAX_PYR_LEVELS];
            int lw = width, lh = height;
            for (int l = 0; l < MAX_PYR_LEVELS; l++) {
                MTLPixelFormat fmt = (l == 0) ? MTLPixelFormatR8Unorm : MTLPixelFormatR32Float;
                MTLTextureDescriptor *td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:fmt
                                                                                              width:(NSUInteger)lw
                                                                                             height:(NSUInteger)lh
                                                                                          mipmapped:NO];
                td.usage = MTLTextureUsageShaderRead | MTLTextureUsageShaderWrite;
                td.storageMode = MTLStorageModeShared;
                id<MTLTexture> tex = [dev newTextureWithDescriptor:td];
                if (!tex) return NULL;
                [levels addObject:tex];
                lw = (lw + 1) / 2;
                lh = (lh + 1) / 2;
                if (lw < 1) lw = 1;
                if (lh < 1) lh = 1;
            }
            [pyrs addObject:levels];
        }
        ctx.pyrs = pyrs;
        ctx.bufPts = [dev newBufferWithLength:(NSUInteger)init_pts_cap * 2 * sizeof(float)
                                      options:MTLResourceStorageModeShared];
        ctx.bufOut = [dev newBufferWithLength:(NSUInteger)init_pts_cap * 4 * sizeof(float)
                                      options:MTLResourceStorageModeShared];
        if (!ctx.bufPts || !ctx.bufOut) return NULL;
        return (__bridge_retained void *)ctx;
    }
}

void rsm_metal_destroy(void *handle) {
    if (!handle) return;
    @autoreleasepool {
        RsmMetalCtx *ctx = (__bridge_transfer RsmMetalCtx *)handle;
        (void)ctx;
    }
}

int rsm_metal_run_batch(
    void *handle,
    int n_upload,
    const uint8_t *const *upload_ptrs,
    const int32_t *upload_slots,
    int n_pairs,
    const int32_t *slot_a,
    const int32_t *slot_b,
    const int32_t *pt_off,
    const int32_t *pt_cnt,
    int total_pts,
    const float *pts_xy,
    int half_win,
    int max_level,
    int max_iter,
    float eps2,
    float *out_flow_fb
) {
    if (!handle) return -1;
    if (half_win < 1 || half_win > MAX_HALF_WIN) return -2;
    @autoreleasepool {
        RsmMetalCtx *ctx = (__bridge RsmMetalCtx *)handle;
        if (max_level < 0 || max_level > ctx.maxLevel) return -3;

        if (total_pts > ctx.ptsCap) {
            int new_cap = ctx.ptsCap;
            while (new_cap < total_pts) new_cap *= 2;
            ctx.bufPts = [ctx.dev newBufferWithLength:(NSUInteger)new_cap * 2 * sizeof(float)
                                              options:MTLResourceStorageModeShared];
            ctx.bufOut = [ctx.dev newBufferWithLength:(NSUInteger)new_cap * 4 * sizeof(float)
                                              options:MTLResourceStorageModeShared];
            if (!ctx.bufPts || !ctx.bufOut) return -4;
            ctx.ptsCap = new_cap;
        }

        const int W = ctx.width;
        const int H = ctx.height;
        for (int i = 0; i < n_upload; i++) {
            int s = upload_slots[i];
            if (s < 0 || s >= ctx.nSlots) return -5;
            [ctx.pyrs[s][0] replaceRegion:MTLRegionMake2D(0, 0, (NSUInteger)W, (NSUInteger)H)
                              mipmapLevel:0
                                withBytes:upload_ptrs[i]
                              bytesPerRow:(NSUInteger)W];
        }

        if (total_pts > 0) {
            memcpy(ctx.bufPts.contents, pts_xy, (size_t)total_pts * 2 * sizeof(float));
        }

        if (n_upload == 0 && total_pts == 0) {
            return 0;
        }

        id<MTLCommandBuffer> cb = [ctx.queue commandBuffer];
        if (!cb) return -6;
        id<MTLComputeCommandEncoder> enc = [cb computeCommandEncoder];
        if (!enc) return -7;

        if (n_upload > 0 && max_level > 0) {
            [enc setComputePipelineState:ctx.psoDown];
            for (int i = 0; i < n_upload; i++) {
                int s = upload_slots[i];
                for (int l = 1; l <= max_level; l++) {
                    id<MTLTexture> srcTex = ctx.pyrs[s][l - 1];
                    id<MTLTexture> dstTex = ctx.pyrs[s][l];
                    [enc setTexture:srcTex atIndex:0];
                    [enc setTexture:dstTex atIndex:1];
                    [enc dispatchThreads:MTLSizeMake(dstTex.width, dstTex.height, 1)
                   threadsPerThreadgroup:MTLSizeMake(16, 16, 1)];
                }
            }
        }

        if (total_pts > 0) {
            [enc setComputePipelineState:ctx.psoLK];
            for (int i = 0; i < n_pairs; i++) {
                int cnt = pt_cnt[i];
                if (cnt <= 0) continue;
                int sa = slot_a[i], sb = slot_b[i];
                if (sa < 0 || sa >= ctx.nSlots || sb < 0 || sb >= ctx.nSlots) {
                    [enc endEncoding];
                    return -8;
                }
                int off = pt_off[i];
                for (int l = 0; l < MAX_PYR_LEVELS; l++) {
                    [enc setTexture:ctx.pyrs[sa][l] atIndex:(NSUInteger)l];
                    [enc setTexture:ctx.pyrs[sb][l] atIndex:(NSUInteger)(MAX_PYR_LEVELS + l)];
                }
                [enc setBuffer:ctx.bufPts offset:(NSUInteger)off * 2 * sizeof(float) atIndex:0];
                [enc setBuffer:ctx.bufOut offset:(NSUInteger)off * 4 * sizeof(float) atIndex:1];
                LKParams params = { cnt, max_level, half_win, max_iter, eps2 };
                [enc setBytes:&params length:sizeof(params) atIndex:2];
                [enc dispatchThreadgroups:MTLSizeMake((NSUInteger)cnt, 1, 1)
                    threadsPerThreadgroup:MTLSizeMake(64, 1, 1)];
            }
        }

        [enc endEncoding];
        [cb commit];
        [cb waitUntilCompleted];
        if (cb.error != nil) return -9;

        if (total_pts > 0) {
            memcpy(out_flow_fb, ctx.bufOut.contents, (size_t)total_pts * 4 * sizeof(float));
        }
        return 0;
    }
}
