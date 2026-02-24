/**
 * Web Worker für gRPC Daten-Streaming
 *
 * WARUM ein Worker?
 * - Main Thread: Muss UI rendern (60fps)
 * - Network IO (gRPC): Kann Main Thread blockieren
 * - Lösung: Worker macht Network, Main macht Rendering
 *
 * WIE kommuniziert der Worker?
 * - Main → Worker: postMessage({ buffer, head, type: 'start' })
 * - Worker → Shared Memory: Schreibt direkt in SharedArrayBuffer
 * - Shared Memory → Main: Renderer liest direkt (kein Message nötig!)
 *
 * PERFORMANCE:
 * - OHNE Worker: 10kHz Stream = Main Thread friert ein
 * - MIT Worker: Main läuft smooth, Worker holt Daten parallel
 */

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { MeasurementService } from "../../gen/measurements_pb";

// Globale Variablen (Worker-Scope, nicht window!)
let sharedBuffer: Float32Array;   // Die Messdaten (shared memory)
let headPointer: Int32Array;       // Der Ring-Buffer Index (shared memory)
function createMeasurementClient() {
    const transport = createConnectTransport({
        baseUrl: "http://localhost:50051",
        useBinaryFormat: true,  // Protocol Buffers (schneller als JSON!)
    });

    return createClient(MeasurementService, transport);
}

/**
 * Message Handler - empfängt Nachrichten vom Main Thread
 *
 * Zwei Arten von Messages:
 * 1. Setup: { buffer, head } → Verbindet Worker mit SharedArrayBuffer
 * 2. Start: { type: 'start' } → Startet den gRPC Stream
 */
self.onmessage = async (e) => {
    const { buffer, head, type } = e.data;

    // Phase 1: Setup - Main Thread schickt uns den SharedArrayBuffer
    if (buffer && head) {
        console.log("Worker: Setup - verbinde SharedArrayBuffer");

        // headPointer ist schon ein Int32Array vom Main Thread
        headPointer = head;

        // Wir erstellen eine Float32Array VIEW auf den SharedArrayBuffer
        // WICHTIG: Offset 4, weil die ersten 4 Bytes der Head-Pointer sind!
        sharedBuffer = new Float32Array(buffer, 4);

        console.log(`Worker: Setup complete - ${sharedBuffer.length} samples buffer`);
        return;
    }

    // Phase 2: Start - User hat "START STREAM" geklickt
    if (type === 'start') {
        console.log("Worker: Starte gRPC Stream...");
        await startStreaming();
    }
};

/**
 * Startet den gRPC Server-Stream und schreibt Daten in SharedArrayBuffer
 *
 * WAS ist gRPC Server-Streaming?
 * - Client sendet EINE Anfrage: "Gib mir Messdaten"
 * - Server antwortet mit VIELEN Messages (Stream!)
 * - Verbindung bleibt offen bis Stream endet
 *
 * WARUM nicht REST/HTTP?
 * - 10.000 Samples/Sekunde = 10.000 HTTP Requests? NEIN!
 * - gRPC Stream = 1 Connection, viele Messages (effizient!)
 *
 * WIE funktioniert der Ring-Buffer?
 * - currentHead = 0, 1, 2, ... 99999, 0, 1, 2... (Ring!)
 * - Wenn voll: Alte Daten werden überschrieben
 * - Modulo Operator (%): 100000 % 100000 = 0 (zurück zum Start)
 */
async function startStreaming() {
    // Client erstellen (type-safe dank Protobuf!)
    const client = createMeasurementClient();

    try {
        console.log("Worker: Verbinde mit gRPC Server...");

        // Starte den Stream (gibt AsyncIterable zurück)
        const response = client.streamMeasurements({});

        // for await: Wartet auf jede neue Batch vom Server
        // Loop läuft solange bis Server den Stream beendet
        for await (const batch of response) {
            // Thread-sicheres Lesen des aktuellen Head-Pointers
            let currentHead = Atomics.load(headPointer, 0);

            // Batch enthält z.B. 100 Samples (10ms @ 10kHz)
            if (batch.values && batch.values.length > 0) {
                // Schreibe alle Werte in den Ring-Buffer
                for (let i = 0; i < batch.values.length; i++) {
                    sharedBuffer[currentHead] = batch.values[i];

                    // Ring-Buffer: Wenn Ende erreicht, von vorne anfangen
                    currentHead = (currentHead + 1) % sharedBuffer.length;
                }

                // Thread-sicheres Schreiben des neuen Head-Pointers
                // Der Renderer sieht sofort die neuen Daten!
                Atomics.store(headPointer, 0, currentHead);

                // Debug-Output alle 10.000 Samples (1 Sekunde @ 10kHz)
                if (currentHead % 10000 === 0) {
                    console.log(`Worker: ${currentHead} samples empfangen`);
                }
            }
        }

        console.log("Worker: Stream erfolgreich beendet");
    } catch (error) {
        console.error("Worker: gRPC Stream Fehler:", error);
    }
}

console.log("Worker initialized and ready");
