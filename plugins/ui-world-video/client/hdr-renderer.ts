// SPDX-License-Identifier: AGPL-3.0-or-later

import { BT2020_TO_DISPLAY_P3, pqToNits, REFERENCE_WHITE_NITS, yuvToRgb } from './hdr.ts';
import type { VideoColour } from './video-index.ts';

/** Entries of the PQ lookup table: PQ signal 0 to 1 to luminance over SDR white. */
const LUT_SIZE = 4096;

/**
 * WebGPU usage flags (values of the WebGPU specification): TypeScript's DOM library types WebGPU
 * but declares neither `GPUBufferUsage` nor `GPUTextureUsage`.
 */
const BUFFER_COPY_DST = 0x08;
const BUFFER_UNIFORM = 0x40;
const TEXTURE_COPY_DST = 0x02;
const TEXTURE_BINDING = 0x04;

/** What happened to a frame given to the renderer. */
export type HdrDraw = 'drawn' | 'busy' | 'unsupported';

export interface HdrRenderer {
  /** Copies and shows the frame; 'busy' while the previous one is still being copied. */
  draw(frame: VideoFrame): HdrDraw;
  destroy(): void;
}

const SHADER = /* wgsl */ `
struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f };

@vertex fn vertex(@builtin(vertex_index) i: u32) -> Out {
  var corners = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var out: Out;
  out.position = vec4f(corners[i], 0, 1);
  out.uv = vec2f((corners[i].x + 1) / 2, (1 - corners[i].y) / 2);
  return out;
}

struct Colour { yuv: mat3x4f, primaries: mat3x3f };
@group(0) @binding(0) var linear: sampler;
@group(0) @binding(1) var luma: texture_2d<f32>;
@group(0) @binding(2) var chroma: texture_2d<f32>;
@group(0) @binding(3) var<uniform> colour: Colour;
@group(0) @binding(4) var pq: texture_1d<f32>;

fn nits(signal: f32) -> f32 {
  let at = clamp(signal, 0.0, 1.0) * f32(${LUT_SIZE - 1});
  let low = u32(floor(at));
  let high = min(low + 1u, ${LUT_SIZE - 1}u);
  return mix(textureLoad(pq, low, 0).r, textureLoad(pq, high, 0).r, fract(at));
}

// Display P3 carries the sRGB transfer function, extended beyond 1 for HDR.
fn encode(x: f32) -> f32 {
  let a = abs(x);
  return sign(x) * select(12.92 * a, 1.055 * pow(a, 1.0 / 2.4) - 0.055, a > 0.0031308);
}

@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let sample = vec4f(textureSample(luma, linear, in.uv).r, textureSample(chroma, linear, in.uv).rg, 1.0);
  let signal: vec3f = sample * colour.yuv;
  let light = colour.primaries * vec3f(nits(signal.r), nits(signal.g), nits(signal.b));
  return vec4f(encode(light.r), encode(light.g), encode(light.b), 1.0);
}`;

/**
 * Shows PQ video frames in HDR on a WebGPU canvas (ADR 0091). WebKit decodes to 8-bit NV12 and
 * converts to SDR wherever it turns a frame into pixels itself (a 2D canvas, `importExternalTexture`),
 * so the renderer copies the planes and does the conversion: the BT.2020 matrix, the PQ curve with
 * BT.2408's 203 cd/m² as SDR white, BT.2020 to Display P3 on an `rgba16float` canvas with extended
 * tone mapping. Undefined where the platform has no such canvas; the 2D canvas shows the video then.
 */
export async function createHdrRenderer(canvas: HTMLCanvasElement, colour: VideoColour): Promise<HdrRenderer | undefined> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    return undefined;
  }
  const device = await adapter.requestDevice();
  // The DOM library has no overload of `getContext` for 'webgpu'.
  const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (!context) {
    device.destroy();
    return undefined;
  }
  try {
    context.configure({ device, format: 'rgba16float', colorSpace: 'display-p3', toneMapping: { mode: 'extended' }, alphaMode: 'opaque' });
  } catch {
    device.destroy();
    return undefined;
  }
  if (context.getConfiguration()?.toneMapping?.mode !== 'extended') {
    // Accepted but ignored: values above SDR white would only clip.
    context.unconfigure();
    device.destroy();
    return undefined;
  }

  const module = device.createShaderModule({ code: SHADER });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vertex' },
    fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
    primitive: { topology: 'triangle-list' },
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

  const uniform = device.createBuffer({ size: 96, usage: BUFFER_UNIFORM | BUFFER_COPY_DST });
  // `sample * yuv` takes each of the mat3x4f's columns as a row of the matrix: its rows go in as
  // they are. The mat3x3f's columns are padded to four floats.
  const p3 = BT2020_TO_DISPLAY_P3;
  const uniformData = new Float32Array(24);
  uniformData.set(yuvToRgb(colour.fullRange), 0);
  [0, 1, 2].forEach((c) => uniformData.set(p3.slice(3 * c, 3 * c + 3), 12 + 4 * c));
  device.queue.writeBuffer(uniform, 0, uniformData);

  const lut = new Float32Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i += 1) {
    lut[i] = pqToNits(i / (LUT_SIZE - 1)) / REFERENCE_WHITE_NITS;
  }
  const pq = device.createTexture({ dimension: '1d', size: [LUT_SIZE], format: 'r32float', usage: TEXTURE_BINDING | TEXTURE_COPY_DST });
  device.queue.writeTexture({ texture: pq }, lut, {}, [LUT_SIZE]);

  let planes: { width: number; height: number; luma: GPUTexture; chroma: GPUTexture; bytes: Uint8Array; bind: GPUBindGroup } | undefined;
  let busy = false;
  let destroyed = false;

  const planesFor = (width: number, height: number, size: number) => {
    if (planes?.width === width && planes.height === height && planes.bytes.length >= size) {
      return planes;
    }
    planes?.luma.destroy();
    planes?.chroma.destroy();
    const usage = TEXTURE_BINDING | TEXTURE_COPY_DST;
    const luma = device.createTexture({ size: [width, height], format: 'r8unorm', usage });
    const chroma = device.createTexture({ size: [Math.ceil(width / 2), Math.ceil(height / 2)], format: 'rg8unorm', usage });
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: luma.createView() },
        { binding: 2, resource: chroma.createView() },
        { binding: 3, resource: { buffer: uniform } },
        { binding: 4, resource: pq.createView() },
      ],
    });
    planes = { width, height, luma, chroma, bytes: new Uint8Array(size), bind };
    return planes;
  };

  return {
    draw(frame) {
      if (frame.format !== 'NV12') {
        return 'unsupported';
      }
      if (busy) {
        return 'busy';
      }
      busy = true;
      const width = frame.visibleRect?.width ?? frame.codedWidth;
      const height = frame.visibleRect?.height ?? frame.codedHeight;
      const target = planesFor(width, height, frame.allocationSize());
      // The player closes its frames as the ride moves on: the copy reads from a clone of its own.
      const copy = frame.clone();
      copy
        .copyTo(target.bytes)
        .then((layout) => {
          if (destroyed) {
            return;
          }
          const [y, uv] = layout;
          device.queue.writeTexture({ texture: target.luma }, target.bytes, { offset: y?.offset ?? 0, bytesPerRow: y?.stride ?? width }, [width, height]);
          device.queue.writeTexture(
            { texture: target.chroma },
            target.bytes,
            { offset: uv?.offset ?? 0, bytesPerRow: uv?.stride ?? width },
            [Math.ceil(width / 2), Math.ceil(height / 2)],
          );
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, target.bind);
          pass.draw(3);
          pass.end();
          device.queue.submit([encoder.finish()]);
        })
        .catch(() => undefined)
        .finally(() => {
          copy.close();
          busy = false;
        });
      return 'drawn';
    },
    destroy() {
      destroyed = true;
      context.unconfigure();
      device.destroy();
    },
  };
}
