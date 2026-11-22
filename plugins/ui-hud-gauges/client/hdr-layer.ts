// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How much brighter than SDR white the gauges draw on an HDR screen: near the highlights of the
 * HDR video routes (2.2 to 2.5 times, ADR 0091), a little below them, to stay comfortable over a
 * long ride.
 */
export const HDR_GAIN = 1.8;

/** The margin, in dial units of 200, around the dial: the average's mark lies outside the scale. */
export const HDR_MARGIN = 8;

/** WebGPU usage flags (values of the specification); the DOM library declares no constants. */
const TEXTURE_BINDING = 0x04;
const TEXTURE_COPY_DST = 0x02;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const BUFFER_UNIFORM = 0x40;
const BUFFER_COPY_DST = 0x08;

const SHADER = /* wgsl */ `
struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f };

@vertex fn vertex(@builtin(vertex_index) i: u32) -> Out {
  let corner = vec2f(f32(i & 1u), f32(i >> 1u));
  var out: Out;
  out.position = vec4f(corner * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
  out.uv = corner;
  return out;
}

@group(0) @binding(0) var linear: sampler;
@group(0) @binding(1) var picture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> gain: vec4f;

fn decode(x: f32) -> f32 {
  return select(x / 12.92, pow((x + 0.055) / 1.055, 2.4), x > 0.04045);
}

// Display P3 carries the sRGB transfer function, extended beyond 1 for HDR.
fn encode(x: f32) -> f32 {
  return select(12.92 * x, 1.055 * pow(x, 1.0 / 2.4) - 0.055, x > 0.0031308);
}

@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let texel = textureSample(picture, linear, in.uv);
  if (texel.a <= 0.0) {
    return vec4f(0.0);
  }
  // Brighter in linear light, so the colours keep their hue; the alpha stays as it is.
  let c = texel.rgb / texel.a;
  let lit = vec3f(encode(decode(c.r) * gain.x), encode(decode(c.g) * gain.x), encode(decode(c.b) * gain.x));
  return vec4f(lit * texel.a, texel.a);
}`;

interface Gpu {
  readonly device: GPUDevice;
  readonly pipeline: GPURenderPipeline;
  readonly sampler: GPUSampler;
  readonly gain: GPUBuffer;
}

let shared: Promise<Gpu | undefined> | undefined;

/** One device and pipeline for every gauge; undefined without WebGPU or an HDR screen. */
function gpu(): Promise<Gpu | undefined> {
  shared ??= (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu || !matchMedia('(dynamic-range: high)').matches) {
      return undefined;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return undefined;
    }
    const device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: SHADER });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-strip' },
    });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const gain = device.createBuffer({ size: 16, usage: BUFFER_UNIFORM | BUFFER_COPY_DST });
    device.queue.writeBuffer(gain, 0, new Float32Array([HDR_GAIN, 0, 0, 0]));
    return { device, pipeline, sampler, gain };
  })().catch(() => undefined);
  return shared;
}

let fonts: Promise<string> | undefined;

/**
 * The document's text font as `@font-face` rules with the files inline: an SVG shown as an image
 * loads nothing, so without them the numbers would fall back to another font. Latin only, in the
 * weights the dial draws.
 */
function inlineFonts(family: string): Promise<string> {
  fonts ??= (async () => {
    const rules: CSSFontFaceRule[] = [];
    for (const sheet of document.styleSheets) {
      let list: CSSRuleList;
      try {
        list = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of list) {
        if (
          rule instanceof CSSFontFaceRule &&
          rule.style.getPropertyValue('font-family').replaceAll(/["']/g, '').trim() === family &&
          rule.style.getPropertyValue('font-style') !== 'italic' &&
          /latin(?!-ext)/.test(rule.style.getPropertyValue('src'))
        ) {
          rules.push(rule);
        }
      }
    }
    const faces = await Promise.all(
      rules.map(async (rule) => {
        const url = /url\(["']?([^"')]+)["']?\)/.exec(rule.style.getPropertyValue('src'))?.[1];
        if (!url) {
          return '';
        }
        const blob = await (await fetch(new URL(url, rule.parentStyleSheet?.href ?? location.href))).blob();
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        const weight = rule.style.getPropertyValue('font-weight') || '400';
        return `@font-face{font-family:'${family}';font-weight:${weight};src:url(${data}) format('woff2');}`;
      }),
    );
    return faces.join('');
  })().catch(() => '');
  return fonts;
}

export interface HdrLayer {
  /** Draws `svg` again, brighter than SDR white; the latest call wins. */
  draw(svg: SVGSVGElement): void;
  destroy(): void;
}

/**
 * Shows a gauge's SVG on a WebGPU canvas with extended tone mapping, `HDR_GAIN` times as bright,
 * where the platform has such a canvas and the screen is HDR (as ADR 0091 found the Mac's web view
 * has); CSS colours themselves stop at SDR white there. Undefined elsewhere: the SVG shows itself.
 */
export async function createHdrLayer(canvas: HTMLCanvasElement): Promise<HdrLayer | undefined> {
  const shared = await gpu();
  // The DOM library has no overload of `getContext` for 'webgpu'.
  const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (!shared || !context) {
    return undefined;
  }
  const { device, pipeline, sampler, gain } = shared;
  try {
    context.configure({
      device,
      format: 'rgba16float',
      colorSpace: 'display-p3',
      toneMapping: { mode: 'extended' },
      alphaMode: 'premultiplied',
    });
  } catch {
    return undefined;
  }
  if (context.getConfiguration()?.toneMapping?.mode !== 'extended') {
    // Accepted but ignored: values above SDR white would only clip.
    context.unconfigure();
    return undefined;
  }

  let texture: GPUTexture | undefined;
  let bind: GPUBindGroup | undefined;
  let pending: SVGSVGElement | undefined;
  let busy = false;
  let destroyed = false;

  const render = async (svg: SVGSVGElement) => {
    const size = canvas.getBoundingClientRect();
    const scale = devicePixelRatio || 1;
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    const family = getComputedStyle(svg).fontFamily.split(',')[0]?.replaceAll(/["']/g, '').trim() ?? '';
    const copy = svg.cloneNode(true) as SVGSVGElement;
    const from = -HDR_MARGIN;
    const span = 200 + 2 * HDR_MARGIN;
    copy.setAttribute('viewBox', `${from} ${from} ${span} ${span}`);
    copy.setAttribute('width', String(width));
    copy.setAttribute('height', String(height));
    copy.setAttribute('font-family', getComputedStyle(svg).fontFamily);
    copy.style.cssText = '';
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `${await inlineFonts(family)} text{font-variant-numeric:tabular-nums}`;
    copy.prepend(style);
    const url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }),
    );
    try {
      const image = new Image(width, height);
      image.src = url;
      await image.decode();
      if (destroyed) {
        return;
      }
      if (texture?.width !== width || texture.height !== height) {
        texture?.destroy();
        texture = device.createTexture({
          size: [width, height],
          format: 'rgba8unorm',
          usage: TEXTURE_BINDING | TEXTURE_COPY_DST | TEXTURE_RENDER_ATTACHMENT,
        });
        bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: sampler },
            { binding: 1, resource: texture.createView() },
            { binding: 2, resource: { buffer: gain } },
          ],
        });
        canvas.width = width;
        canvas.height = height;
      }
      // A decoded SVG image in WebKit already carries premultiplied alpha; asking
      // `copyExternalImageToTexture` to premultiply again multiplies RGB by alpha a second time
      // and darkens translucent gradients towards black when the shader divides by alpha once.
      device.queue.copyExternalImageToTexture(
        { source: image },
        { texture, colorSpace: 'display-p3', premultipliedAlpha: false },
        [width, height],
      );
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind ?? null);
      pass.draw(4);
      pass.end();
      device.queue.submit([encoder.finish()]);
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const next = () => {
    if (busy || destroyed || !pending) {
      return;
    }
    const svg = pending;
    pending = undefined;
    busy = true;
    render(svg)
      .catch(() => undefined)
      .finally(() => {
        busy = false;
        next();
      });
  };

  return {
    draw(svg) {
      pending = svg;
      next();
    },
    destroy() {
      destroyed = true;
      texture?.destroy();
      context.unconfigure();
    },
  };
}
