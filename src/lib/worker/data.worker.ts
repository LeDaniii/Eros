// // src/lib/worker/data.worker.ts

// let sharedBuffer: Float32Array;
// let headPointer: Int32Array;

// self.onmessage = (e) => {
//     const { buffer, head } = e.data;

//     // KORREKTUR 1: Offset beachten!
//     // Wir müssen die ersten 4 Bytes überspringen, da dort der Head-Pointer liegt.
//     // Sonst schreiben wir Daten in den Header.
//     sharedBuffer = new Float32Array(buffer, 4);

//     headPointer = new Int32Array(head);

//     console.log("Worker: Shared Memory gekoppelt. Starte Simulation...");

//     // KORREKTUR 2: Simulation erst starten, WENN der Buffer da ist!
//     simulateIncomingData();
// };

// function simulateIncomingData() {
//     // Hier brauchen wir kein if(!sharedBuffer) mehr, da wir sicher sind, dass er existiert

//     let time = 0; // Lokale Zeit für die Sinus-Berechnung

//     setInterval(() => {
//         let currentHead = Atomics.load(headPointer, 0);

//         // Schreibe 100 neue Punkte (entspricht 10ms bei 10kHz)
//         for (let i = 0; i < 100; i++) {
//             // Wir erhöhen die Zeit langsam, damit eine schöne Welle entsteht
//             time += 0.002;

//             // Sinus mit Amplitude 0.5
//             const val = Math.sin(time * 0.5)

//             sharedBuffer[currentHead] = val;
//             currentHead = (currentHead + 1) % sharedBuffer.length;
//         }

//         Atomics.store(headPointer, 0, currentHead);
//     }, 10);
// }


// src/lib/core/worker/data.worker.ts
// src/lib/core/worker/data.worker.ts
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { MeasurementService } from "../../gen/measurements_pb";

let sharedBuffer: Float32Array;
let headPointer: Int32Array;

self.onmessage = async (e) => {
    const { buffer, head } = e.data;
    sharedBuffer = new Float32Array(buffer, 4);
    headPointer = new Int32Array(head);

    const transport = createConnectTransport({
        baseUrl: "http://localhost:50051",
    });

    // In v2 nutzen wir das Schema direkt
    const client = createClient(MeasurementService, transport);

    try {
        console.log("Worker: Verbindung steht. Warte auf Daten...");

        // v2 Syntax: Wir rufen die Methode auf und erhalten einen AsyncIterable
        const response = client.streamMeasurements({});

        for await (const batch of response) {
            let currentHead = Atomics.load(headPointer, 0);

            // batch ist vom Typ MeasurementBatch
            if (batch.values && batch.values.length > 0) {
                for (let i = 0; i < batch.values.length; i++) {
                    sharedBuffer[currentHead] = batch.values[i];
                    currentHead = (currentHead + 1) % sharedBuffer.length;
                }

                // Nur einmal pro Batch den Pointer updaten (Performance!)
                Atomics.store(headPointer, 0, currentHead);
            }
        }
    } catch (error) {
        console.error("gRPC Stream Error im Worker:", error);
    }
};