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
    const { buffer, head, type } = e.data;

    if (buffer && head) {
        console.log("Worker: Received data");
        console.log("Worker: buffer:", buffer);
        console.log("Worker: head:", head);
        // ENTFERNT: console.log("Worker: head type:", head.constructor.name);

        // head ist ein Int32Array, buffer ist SharedArrayBuffer
        headPointer = head;
        sharedBuffer = new Float32Array(buffer, 4);

        console.log("Worker: Setup complete");
        console.log("Worker: headPointer.buffer instanceof SharedArrayBuffer:", headPointer.buffer instanceof SharedArrayBuffer);
        console.log("Worker: sharedBuffer.buffer instanceof SharedArrayBuffer:", sharedBuffer.buffer instanceof SharedArrayBuffer);
        return;
    }

    if (type === 'start') {
        console.log("Worker: Start signal received");
        await startStreaming();
    }
};

async function startStreaming() {
    const transport = createConnectTransport({
        baseUrl: "http://localhost:50051",
        useBinaryFormat: true,
    });

    const client = createClient(MeasurementService, transport);

    try {
        console.log("Worker: Connecting to gRPC server...");
        const response = client.streamMeasurements({});

        for await (const batch of response) {
            let currentHead = Atomics.load(headPointer, 0);

            if (batch.values && batch.values.length > 0) {
                for (let i = 0; i < batch.values.length; i++) {
                    sharedBuffer[currentHead] = batch.values[i];
                    currentHead = (currentHead + 1) % sharedBuffer.length;
                }

                Atomics.store(headPointer, 0, currentHead);

                if (currentHead % 10000 === 0) {
                    console.log(`Worker: Wrote ${currentHead} samples, value at 0:`, sharedBuffer[0]);
                }
            }
        }

        console.log("Worker: Stream completed successfully");
    } catch (error) {
        console.error("gRPC Stream Error:", error);
    }
}

console.log("Worker initialized and ready");