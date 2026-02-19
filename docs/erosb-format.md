# EROSB Binary Format Specification

Version: `1`  
Status: stable for current app implementation

## Overview

`.erosb` is a simple binary container for one curve.

- Single channel
- Uniform sample rate
- 32-bit floating point samples (`Float32`)
- Little-endian encoding

This format is used by:

- `ErosChart.exportBinary()`
- `ErosChart.decodeBinary()`
- `ErosChart.loadData()`

## File Layout

Header size is fixed to `20` bytes.

| Offset | Size | Type      | Name         | Description |
|-------:|-----:|-----------|--------------|-------------|
| 0      | 4    | bytes[4]  | `magic`      | ASCII `EROS` (`0x45 0x52 0x4F 0x53`) |
| 4      | 2    | uint16 LE | `version`    | Format version, currently `1` |
| 6      | 2    | uint16 LE | `flags`      | Reserved, currently `0` |
| 8      | 4    | uint32 LE | `sampleRate` | Samples per second, must be `> 0` |
| 12     | 4    | uint32 LE | `sampleCount`| Number of float samples in payload |
| 16     | 4    | uint32 LE | `reserved`   | Reserved, currently `0` |
| 20     | ...  | float32[] | `samples`    | `sampleCount` values, little-endian |

Total file size must be:

`20 + sampleCount * 4` bytes

## Validation Rules

A reader should reject the file if:

- file size is `< 20`
- magic is not `EROS`
- version is unsupported
- `sampleRate == 0`
- file size does not match `20 + sampleCount * 4`

## Reference: Writer (TypeScript)

```ts
function encodeErosb(values: Float32Array, sampleRate: number): ArrayBuffer {
  const headerSize = 20;
  const buffer = new ArrayBuffer(headerSize + values.length * 4);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // magic
  bytes.set([0x45, 0x52, 0x4f, 0x53], 0); // "EROS"

  // header
  view.setUint16(4, 1, true); // version
  view.setUint16(6, 0, true); // flags
  view.setUint32(8, Math.max(1, Math.floor(sampleRate)), true);
  view.setUint32(12, values.length, true);
  view.setUint32(16, 0, true); // reserved

  // payload
  new Float32Array(buffer, headerSize, values.length).set(values);
  return buffer;
}
```

## Reference: Reader (TypeScript)

```ts
function decodeErosb(fileBuffer: ArrayBuffer): {
  version: number;
  sampleRate: number;
  values: Float32Array;
} {
  const headerSize = 20;
  if (fileBuffer.byteLength < headerSize) {
    throw new Error("File too small");
  }

  const bytes = new Uint8Array(fileBuffer);
  const view = new DataView(fileBuffer);

  if (
    bytes[0] !== 0x45 ||
    bytes[1] !== 0x52 ||
    bytes[2] !== 0x4f ||
    bytes[3] !== 0x53
  ) {
    throw new Error("Magic mismatch");
  }

  const version = view.getUint16(4, true);
  if (version !== 1) {
    throw new Error(`Unsupported version: ${version}`);
  }

  const sampleRate = view.getUint32(8, true);
  const sampleCount = view.getUint32(12, true);
  if (sampleRate < 1) {
    throw new Error("Invalid sampleRate");
  }

  const expectedSize = headerSize + sampleCount * 4;
  if (fileBuffer.byteLength !== expectedSize) {
    throw new Error("Payload size mismatch");
  }

  const values = new Float32Array(sampleCount);
  values.set(new Float32Array(fileBuffer, headerSize, sampleCount));

  return { version, sampleRate, values };
}
```

## Forward Compatibility Notes

- `flags` and `reserved` are kept for future extensions.
- Future versions may add optional metadata blocks.
- Readers should check `version` before decoding payload semantics.
