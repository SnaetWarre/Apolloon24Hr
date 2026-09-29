import type { LabelImageUpload } from '../types';

/** Longest side of a stored logo: sharp on the big screens, where a logo is about 1.1em of large text. */
export const LABEL_IMAGE_SIZE = 256;

/** Larger sources are first brought down to this, so trimming never reads a full camera photo. */
const WORKING_SIZE = 1024;

/** Pixels at or below this alpha count as empty margin. */
const ALPHA_THRESHOLD = 8;

const MIME_BY_EXTENSION: Record<string, string> = {
  apng: 'image/apng',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jfif: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

declare global {
  interface Window {
    /** Only set inside the desktop app. */
    apolloonDesktop?: {
      pickImage: () => Promise<{ name: string; bytes: Uint8Array } | null>;
    };
  }
}

export type Box = { x: number; y: number; width: number; height: number };

/**
 * Size that fits `width`×`height` inside a `max` square, keeping the aspect ratio.
 * Pixel images are never enlarged; vector images can be.
 */
export function fitWithin(
  width: number,
  height: number,
  max: number,
  enlarge = false
): { width: number; height: number } {
  const scale = enlarge ? max / Math.max(width, height) : Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Smallest box around the visible pixels of RGBA data, or null when every pixel is transparent. */
export function opaqueBounds(data: ArrayLike<number>, width: number, height: number): Box | null {
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] <= ALPHA_THRESHOLD) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (bottom < 0) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Lets the user pick an image; the desktop app opens its dialog in Downloads. */
export async function pickImageFile(): Promise<Blob | null> {
  if (window.apolloonDesktop) {
    const picked = await window.apolloonDesktop.pickImage();
    if (!picked) return null;
    const extension = picked.name.split('.').pop()?.toLowerCase() ?? '';
    return new Blob([picked.bytes as Uint8Array<ArrayBuffer>], { type: MIME_BY_EXTENSION[extension] ?? '' });
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `image/*,${Object.keys(MIME_BY_EXTENSION)
      .map((extension) => `.${extension}`)
      .join(',')}`;
    input.hidden = true;
    const finish = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

/** Decodes any format the browser can read, trims empty margins and scales it to a small stored logo. */
export async function prepareLabelImage(file: Blob): Promise<LabelImageUpload> {
  const image = await decodeImage(file);
  // SVGs with only a viewBox report no size of their own.
  const sourceWidth = image.naturalWidth || WORKING_SIZE;
  const sourceHeight = image.naturalHeight || WORKING_SIZE;

  const working = fitWithin(sourceWidth, sourceHeight, WORKING_SIZE, file.type === 'image/svg+xml');
  let canvas = drawScaled(image, sourceWidth, sourceHeight, working.width, working.height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const bounds = opaqueBounds(
    context.getImageData(0, 0, canvas.width, canvas.height).data,
    canvas.width,
    canvas.height
  );
  if (bounds && (bounds.width < canvas.width || bounds.height < canvas.height)) {
    const trimmed = createCanvas(bounds.width, bounds.height);
    trimmed
      .getContext('2d')!
      .drawImage(canvas, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
    canvas = trimmed;
  }

  const target = fitWithin(canvas.width, canvas.height, LABEL_IMAGE_SIZE);
  const output = drawScaled(canvas, canvas.width, canvas.height, target.width, target.height);
  return encode(output);
}

async function decodeImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } catch {
    throw new Error('Geen leesbare afbeelding. Kies PNG, JPG, GIF, WebP, AVIF, BMP of SVG.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Scales in halving steps: one big jump skips most source pixels and leaves
 * the logo jagged, while each halving averages every pixel it drops.
 */
function drawScaled(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number
): HTMLCanvasElement {
  let current = source;
  let currentWidth = sourceWidth;
  let currentHeight = sourceHeight;
  while (currentWidth / 2 >= width && currentHeight / 2 >= height) {
    const step = createCanvas(Math.round(currentWidth / 2), Math.round(currentHeight / 2));
    paint(step, current);
    current = step;
    currentWidth = step.width;
    currentHeight = step.height;
  }
  const canvas = createCanvas(width, height);
  paint(canvas, current);
  return canvas;
}

function paint(target: HTMLCanvasElement, source: CanvasImageSource) {
  const context = target.getContext('2d')!;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, target.width, target.height);
}

async function encode(canvas: HTMLCanvasElement): Promise<LabelImageUpload> {
  const webp = await toBlob(canvas, 'image/webp', 0.92);
  const blob = webp?.type === 'image/webp' ? webp : await toBlob(canvas, 'image/png');
  if (!blob) throw new Error('Logo verkleinen mislukt');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Logo verkleinen mislukt'));
    reader.readAsDataURL(blob);
  });
  return {
    mime: blob.type === 'image/webp' ? 'image/webp' : 'image/png',
    dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
  };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
