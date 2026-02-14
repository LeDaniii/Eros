/**
 * SharedRingBuffer - Thread-sicherer Ringpuffer für Messdaten
 *
 * WARUM SharedArrayBuffer?
 * - Normaler ArrayBuffer: Jeder Thread bekommt eine KOPIE (langsam!)
 * - SharedArrayBuffer: BEIDE Threads sehen den GLEICHEN Speicher (schnell!)
 *
 * WIE funktioniert's?
 * - Worker schreibt neue Daten rein (gRPC Stream)
 * - Renderer liest Daten raus (WebGPU)
 * - Atomics verhindert Race Conditions (thread-sicher!)
 *
 * Memory Layout:
 * [0-3 Bytes]    = Head-Pointer (Int32, wo sind wir im Ring?)
 * [4-Ende]       = Float-Daten (die eigentlichen Messwerte)
 */
export class SharedRingBuffer {
    public readonly buffer: SharedArrayBuffer; // Wir wollen das Original!
    public readonly data: Float32Array;
    public readonly head: Int32Array;

    constructor(size: number) {
        console.log("Erstelle SharedRingBuffer...");

        // WICHTIG: 4 Bytes Header für den Head-Pointer!
        // - 4 Bytes = 1x Int32 (32 bit = 4 Bytes)
        // - size * 4 = Float32-Array (jeder Float = 4 Bytes)
        this.buffer = new SharedArrayBuffer(4 + size * 4);

        // Head-Pointer: Die ersten 4 Bytes (Offset 0)
        // Speichert: Wo schreiben wir als nächstes hin?
        this.head = new Int32Array(this.buffer, 0, 1);

        // Daten-Array: Alles nach den ersten 4 Bytes (Offset 4)
        // Hier landen die eigentlichen Messwerte
        this.data = new Float32Array(this.buffer, 4, size);

        console.log(`SharedRingBuffer erstellt: ${size} Samples (${(size * 4 / 1024).toFixed(1)} KB)`);
    }

    /**
     * Thread-sicheres Lesen des Head-Pointers
     *
     * WARUM Atomics.load()?
     * - Normales this.head[0] könnte "dirty reads" haben
     * - Atomics garantiert: Du siehst den AKTUELLEN Wert, auch wenn der Worker gerade schreibt
     *
     * WAS ist ein "dirty read"?
     * - Worker schreibt: 1000
     * - Renderer liest gleichzeitig: Könnte 999 oder 1000 oder Müll sehen
     * - Atomics verhindert das!
     */
    get currentHead(): number {
        return Atomics.load(this.head, 0);
    }
}