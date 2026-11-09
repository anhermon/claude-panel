// A scene's terminal picture: read the pixel size from a PNG's IHDR chunk and
// turn it into a cell box with the same aspect. Pure, no `$`.
//
// The engine refuses a whole pane tree that holds an Image whose bytes lack a
// complete IHDR chunk after the signature, so the same check is made here: a
// file that fails it is not used as a face (the scene shows its art or alt).

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const IHDR_TAG = [0x49, 0x48, 0x44, 0x52] // "IHDR"
const IHDR_DATA_BYTES = 13
const LENGTH_AT = 8
const TAG_AT = 12
const WIDTH_AT = 16
const HEIGHT_AT = 20
const HEADER_BYTES = 33 // signature (8) + IHDR chunk: length (4) + "IHDR" (4) + data (13) + CRC (4)
const BASE64_CHARS_PER_3_BYTES = 4
const HEADER_BASE64_CHARS = (HEADER_BYTES / 3) * BASE64_CHARS_PER_3_BYTES // 33 bytes = 44 chars, no padding
const BYTE_BITS = 8

/** A terminal cell is about twice as tall as it is wide. */
export const CELL_ASPECT = 2
export const IMAGE_MAX_ROWS = 20
/** The Image element takes 1..255 columns. */
export const IMAGE_MAX_COLUMNS = 255

export type PixelSize = { width: number; height: number }
export type CellBox = { columns: number; rows: number }

const matches = (bytes: readonly number[], at: number, want: readonly number[]): boolean =>
  want.every((b, i) => bytes[at + i] === b)

const uint32 = (bytes: readonly number[], at: number): number =>
  bytes.slice(at, at + 4).reduce((n, b) => n * 2 ** BYTE_BITS + b, 0)

/** The pixel size of a PNG given as base64 (only its first 33 bytes are read), or null if it is not one. */
export function pngSize(base64: string): PixelSize | null {
  let bytes: number[]
  try {
    bytes = Array.from(atob(base64.slice(0, HEADER_BASE64_CHARS)), c => c.charCodeAt(0))
  } catch {
    return null
  }
  if (bytes.length < HEADER_BYTES || !matches(bytes, 0, SIGNATURE) || !matches(bytes, TAG_AT, IHDR_TAG)) return null
  if (uint32(bytes, LENGTH_AT) !== IHDR_DATA_BYTES) return null
  const width = uint32(bytes, WIDTH_AT)
  const height = uint32(bytes, HEIGHT_AT)
  return width > 0 && height > 0 ? { width, height } : null
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/**
 * The cell box for a picture: as wide as `maxColumns` allows, as tall as its
 * aspect ratio asks, at most IMAGE_MAX_ROWS (then narrower, keeping the aspect).
 */
export function imageBox(size: PixelSize, maxColumns: number): CellBox {
  const widest = clamp(Math.floor(maxColumns), 1, IMAGE_MAX_COLUMNS)
  let columns = widest
  let rows = Math.round((columns * size.height) / (size.width * CELL_ASPECT))
  if (rows > IMAGE_MAX_ROWS) {
    rows = IMAGE_MAX_ROWS
    columns = Math.round((rows * CELL_ASPECT * size.width) / size.height)
  }
  return { columns: clamp(columns, 1, widest), rows: clamp(rows, 1, IMAGE_MAX_ROWS) }
}
