const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export type IdPrefix =
  | 'msn'
  | 'repo'
  | 'int'
  | 'prj'
  | 'run'
  | 'job'
  | 'apr'
  | 'trg'
  | 'fx'
  | 'ver'
  | 'rev'
  | 'mr'
  | 'rvw'
  | 'usr'
  | 'cmd'
  | 'chat'
  | 'msg'
  | 'img';

/** Random, URL-safe, lowercase id body. 256 is divisible by 32, so each character is uniform. */
export function randomId(length = 10): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}

export function newId(prefix: IdPrefix, length = 10): string {
  return `${prefix}_${randomId(length)}`;
}

/** Short, human-friendly id suffix (used in branch names). */
export function shortId(id: string): string {
  const body = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
  return body.slice(0, 6);
}
