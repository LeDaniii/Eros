import { WebGPURenderer } from "./lib/renderer/WebGPURenderer";
import { SharedRingBuffer } from "./lib/core/SharedRingBuffer";

async function startProject() {
  // 1. Das Canvas aus dem HTML holen
  const canvas = document.getElementById('plotCanvas') as HTMLCanvasElement;
  if (!canvas) return;

  console.log("Starte WebGPU-Datenvisualisierung...");
  // 2. SharedRingBuffer erstellen (z.B. für 10.000 Messpunkte)
  // Das Layout besteht aus Header (Pointer) und Body (Daten) [cite: 11]
  const ringBuffer = new SharedRingBuffer(10000);

  console.log("Hallo 1");
  // 3. Renderer initialisieren
  const renderer = new WebGPURenderer(canvas);
  console.log("Hallo 2");
  await renderer.initialize(); // [cite: 21]
  console.log("Hallo 3");
  // Dem Renderer sagen, wo er die Daten findet
  renderer.setDataSource(ringBuffer);
  console.log("Hallo 4");

  // 4. Den Data-Ingestor Worker starten [cite: 4, 6]
  const worker = new Worker(
    new URL('./lib/worker/data.worker.ts', import.meta.url),
    { type: 'module' }
  );

  console.log("Hallo 5");
  console.log(worker)
  // Dem Worker den SharedArrayBuffer schicken [cite: 4]
  // Wir schicken nur die Referenz, keine Kopie! 
  worker.postMessage({
    buffer: ringBuffer.buffer,
    head: ringBuffer.head
  });

  // 5. Die Render-Schleife (The Heartbeat)
  function frame() {
    // Der Renderer liest den aktuellen Schreib-Pointer via Atomics [cite: 10]
    // und schiebt die Daten in die GPU-Pipeline [cite: 12, 13]
    renderer.render();

    // Nächsten Frame anfordern (normalerweise 60-120 FPS)
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  console.log("System läuft: 10kHz Ingest im Worker, WebGPU Rendering aktiv.");
}

startProject().catch(console.error);