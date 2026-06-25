const SHA256_BLOCK_SIZE = 64;
const SHA256_OUTPUT_SIZE = 32;

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

export function createHmacSha256Base64Url(
  key: string,
  message: string,
): string {
  const keyBytes = utf8Bytes(key);
  const normalizedKey =
    keyBytes.length > SHA256_BLOCK_SIZE ? sha256(keyBytes) : keyBytes;
  const paddedKey = new Uint8Array(SHA256_BLOCK_SIZE);
  paddedKey.set(normalizedKey);

  const outerPad = new Uint8Array(SHA256_BLOCK_SIZE);
  const innerPad = new Uint8Array(SHA256_BLOCK_SIZE);
  for (let index = 0; index < SHA256_BLOCK_SIZE; index += 1) {
    outerPad[index] = paddedKey[index] ^ 0x5c;
    innerPad[index] = paddedKey[index] ^ 0x36;
  }

  const inner = concatBytes(innerPad, utf8Bytes(message));
  return base64UrlEncode(sha256(concatBytes(outerPad, sha256(inner))));
}

export function createSha256Hex(message: string): string {
  return hexEncode(sha256(utf8Bytes(message)));
}

function sha256(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  const paddedLength =
    Math.ceil((input.length + 9) / SHA256_BLOCK_SIZE) * SHA256_BLOCK_SIZE;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += SHA256_BLOCK_SIZE) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }

    for (let index = 16; index < 64; index += 1) {
      words[index] = add32(
        sigma1(words[index - 2]),
        words[index - 7],
        sigma0(words[index - 15]),
        words[index - 16],
      );
    }

    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];

    for (let index = 0; index < 64; index += 1) {
      const t1 = add32(
        h,
        bigSigma1(e),
        choose(e, f, g),
        K[index],
        words[index],
      );
      const t2 = add32(bigSigma0(a), majority(a, b, c));
      h = g;
      g = f;
      f = e;
      e = add32(d, t1);
      d = c;
      c = b;
      b = a;
      a = add32(t1, t2);
    }

    state[0] = add32(state[0], a);
    state[1] = add32(state[1], b);
    state[2] = add32(state[2], c);
    state[3] = add32(state[3], d);
    state[4] = add32(state[4], e);
    state[5] = add32(state[5], f);
    state[6] = add32(state[6], g);
    state[7] = add32(state[7], h);
  }

  const digest = new Uint8Array(SHA256_OUTPUT_SIZE);
  const digestView = new DataView(digest.buffer);
  for (let index = 0; index < state.length; index += 1) {
    digestView.setUint32(index * 4, state[index]);
  }
  return digest;
}

function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (
      codePoint >= 0xd800 &&
      codePoint <= 0xdbff &&
      index + 1 < value.length
    ) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }

    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    encoded += alphabet[a >> 2];
    encoded += alphabet[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (index + 1 < bytes.length) {
      encoded += alphabet[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    }
    if (index + 2 < bytes.length) {
      encoded += alphabet[c & 0x3f];
    }
  }
  return encoded;
}

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

function rotateRight(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function add32(...values: number[]): number {
  return values.reduce((sum, value) => (sum + value) >>> 0, 0);
}

function choose(x: number, y: number, z: number): number {
  return ((x & y) ^ (~x & z)) >>> 0;
}

function majority(x: number, y: number, z: number): number {
  return ((x & y) ^ (x & z) ^ (y & z)) >>> 0;
}

function bigSigma0(value: number): number {
  return (
    (rotateRight(value, 2) ^
      rotateRight(value, 13) ^
      rotateRight(value, 22)) >>>
    0
  );
}

function bigSigma1(value: number): number {
  return (
    (rotateRight(value, 6) ^
      rotateRight(value, 11) ^
      rotateRight(value, 25)) >>>
    0
  );
}

function sigma0(value: number): number {
  return (rotateRight(value, 7) ^ rotateRight(value, 18) ^ (value >>> 3)) >>> 0;
}

function sigma1(value: number): number {
  return (
    (rotateRight(value, 17) ^ rotateRight(value, 19) ^ (value >>> 10)) >>> 0
  );
}
