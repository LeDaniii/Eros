// export class SharedRingBuffer {
//     public readonly buffer: ArrayBuffer; // 'ArrayBuffer' statt 'SharedArrayBuffer' [cite: 9]
//     public readonly data: Float32Array;
//     public readonly head: Int32Array;

//     constructor(size: number) {
//         // Wir nutzen hier normalen Speicher, der keine speziellen Header braucht
//         this.buffer = new ArrayBuffer(4 + size * 4);
//         this.head = new Int32Array(this.buffer, 0, 1);
//         this.data = new Float32Array(this.buffer, 4, size);
//         console.log("SharedRingBuffer (Fallback Mode) erstellt.");
//     }

//     get currentHead(): number {
//         return this.head[0]; // Kein Atomics nötig bei normalem ArrayBuffer
//     }
// }

// src/lib/core/SharedRingBuffer.ts
export class SharedRingBuffer {
    public readonly buffer: SharedArrayBuffer; // Wir wollen das Original!
    public readonly data: Float32Array;
    public readonly head: Int32Array;

    constructor(size: number) {
        console.log("Versuche SharedArrayBuffer zu erstellen...");
        // 4 Bytes Header + Daten
        this.buffer = new SharedArrayBuffer(4 + size * 4);
        this.head = new Int32Array(this.buffer, 0, 1);
        this.data = new Float32Array(this.buffer, 4, size);
        console.log("SharedRingBuffer (Original) erfolgreich erstellt.");
    }

    get currentHead(): number {
        return Atomics.load(this.head, 0); // Das Herzstück der Synchronisation [cite: 10]
    }
}