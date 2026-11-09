// A PNG signature + a complete IHDR chunk (33 bytes) of the given pixel size, as
// base64: all the mod reads of a picture's bytes to size its box, and all the
// engine's Image checks of it up front. The chunk's CRC is left zero.
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const IHDR_LENGTH = [0, 0, 0, 13]
const IHDR_TAG = [0x49, 0x48, 0x44, 0x52]
const BIT_DEPTH_8 = 8
const COLOR_TYPE_RGBA = 6
const CRC_ZERO = [0, 0, 0, 0]
const BYTE_MASK = 0xff
const UINT32_BYTES = 4
const BYTE_BITS = 8

const uint32 = (n: number): number[] =>
  Array.from({ length: UINT32_BYTES }, (_, i) => Math.floor(n / 2 ** (BYTE_BITS * (UINT32_BYTES - 1 - i))) & BYTE_MASK)

export function pngHeader(width: number, height: number): string {
  const data = [...uint32(width), ...uint32(height), BIT_DEPTH_8, COLOR_TYPE_RGBA, 0, 0, 0]
  return btoa(String.fromCharCode(...SIGNATURE, ...IHDR_LENGTH, ...IHDR_TAG, ...data, ...CRC_ZERO))
}
