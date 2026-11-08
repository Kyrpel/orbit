import { CHAT_IMAGE_LIMITS, CHAT_IMAGE_TYPES, type ChatImageType } from '@orbit/shared';

/*
  Pasting into a session prompt, as in Claude Code: an image becomes `[Image #1]` in the
  text and travels with the message; a long paste becomes `[Pasted text #1 +42 lines]` in
  the box, and the full text is what gets sent. Deleting a token drops what it stands for.
*/

export interface PastedText {
  n: number;
  text: string;
}

export interface AttachedImage {
  n: number;
  name: string;
  mediaType: ChatImageType;
  /** Base64, without the `data:` prefix. */
  data: string;
  /** A data URL for the thumbnail. */
  preview: string;
  width: number;
  height: number;
}

export const imageToken = (n: number) => `[Image #${n}]`;
export const lineCount = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').length;
export const pasteToken = (p: PastedText) => `[Pasted text #${p.n} +${lineCount(p.text)} lines]`;

/** Claude Code folds a paste that is longer than a few lines. */
export const shouldFold = (text: string) => lineCount(text) > 3 || text.length > 800;

/** The message as sent: every paste token replaced by the text it stands for. */
export function expandPastes(value: string, pastes: PastedText[]): string {
  let out = value;
  for (const p of pastes) out = out.split(pasteToken(p)).join(p.text);
  return out;
}

/** Images whose token is still in the text (deleting `[Image #2]` drops image 2). */
export function usedImages<T extends { n: number }>(value: string, images: T[]): T[] {
  return images.filter((i) => value.includes(imageToken(i.n)));
}

/** Inserts `insert` over the selection, with a space before it when it would touch a word. */
export function insertAt(value: string, start: number, end: number, insert: string): { value: string; caret: number } {
  const before = value.slice(0, start);
  const text = `${before && !/\s$/.test(before) ? ' ' : ''}${insert}`;
  return { value: before + text + value.slice(end), caret: before.length + text.length };
}

/** Splits text into plain parts and `[Image #n]` tokens, to show tokens as links to their image. */
export function splitImageTokens(text: string): (string | { n: number })[] {
  const out: (string | { n: number })[] = [];
  let last = 0;
  for (const m of text.matchAll(/\[Image #(\d+)\]/g)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push({ n: Number(m[1]) });
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Claude reads images at up to about this many pixels on the long side; larger ones only cost more. */
const MAX_EDGE = 1568;

const blobOf = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('That image could not be read.'))), type, quality));

/** Reads a pasted or dropped image, scaled down when it is larger than the agent can use. */
export async function readImage(file: Blob, name: string): Promise<Omit<AttachedImage, 'n'>> {
  const type = file.type as ChatImageType;
  if (!(CHAT_IMAGE_TYPES as readonly string[]).includes(type)) throw new Error('Only PNG, JPEG, GIF and WebP images can be attached.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That image could not be read.'));
      i.src = url;
    });
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    let blob: Blob = file;
    let mediaType: ChatImageType = type;
    // Small images go as they are (an animated GIF keeps its frames); large ones are redrawn smaller.
    if (scale < 1 || file.size > CHAT_IMAGE_LIMITS.maxBytes * 0.7) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);
      mediaType = type === 'image/png' ? 'image/png' : 'image/jpeg';
      blob = await blobOf(canvas, mediaType, 0.9);
      if (blob.size > CHAT_IMAGE_LIMITS.maxBytes) {
        mediaType = 'image/jpeg';
        blob = await blobOf(canvas, mediaType, 0.82);
      }
    }
    if (blob.size > CHAT_IMAGE_LIMITS.maxBytes) throw new Error('That image is larger than 5 MB.');
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('That image could not be read.'));
      r.readAsDataURL(blob);
    });
    return { name: (name || 'image').slice(0, 80), mediaType, data: dataUrl.slice(dataUrl.indexOf(',') + 1), preview: dataUrl, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}
