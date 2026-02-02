import { WebGPURenderer } from "./lib/renderer/WebGPURenderer";
import { GridOverlay } from "./lib/renderer/GridOverlay";
import { SharedRingBuffer } from "./lib/core/SharedRingBuffer";

let isStreaming = false;

function createControlPanel(): HTMLDivElement {
  const panel = document.createElement("div");
  panel.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: rgba(0, 0, 0, 0.9);
    border: 2px solid #00ff00;
    padding: 20px;
    border-radius: 10px;
    font-family: monospace;
    z-index: 1000;
    min-width: 250px;
  `;

  panel.innerHTML = `
    <div style="margin-bottom: 15px; color: #00ff00; font-weight: bold; font-size: 16px;">
      MEASUREMENT CONTROL
    </div>
    <div style="margin-bottom: 10px;">
      <label style="display: block; margin-bottom: 5px; color: #aaa;">Duration (s):</label>
      <input type="number" id="durationInput" value="30" min="1" max="300" 
             style="width: 100%; padding: 8px; background: #222; color: #0f0; border: 1px solid #0f0; font-family: monospace;">
    </div>
    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; color: #aaa;">Sample Rate (Hz):</label>
      <input type="number" id="sampleRateInput" value="10000" step="1000"
             style="width: 100%; padding: 8px; background: #222; color: #0f0; border: 1px solid #0f0; font-family: monospace;">
    </div>
    <button id="startBtn" 
            style="width: 100%; padding: 12px; background: #00ff00; color: black; border: none; cursor: pointer; font-weight: bold; font-size: 14px; border-radius: 5px;">
      ▶ START STREAM
    </button>
    <div id="statsPanel" style="margin-top: 15px; font-size: 12px; color: #0f0; border-top: 1px solid #333; padding-top: 10px;">
      Ready | Scroll to zoom
    </div>
  `;

  return panel;
}

function updateStatus(message: string): void {
  const statusEl = document.getElementById("status");
  const statsEl = document.getElementById("statsPanel");
  if (statusEl) statusEl.textContent = message;
  if (statsEl) statsEl.textContent = message;
}

async function configureStream(durationSeconds: number, sampleRateHz: number): Promise<void> {
  const response = await fetch("http://localhost:50051/api/configure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ durationSeconds, sampleRateHz }),
  });

  if (!response.ok) {
    throw new Error(`Configuration failed: ${response.statusText}`);
  }
}

async function startProject() {
  const canvas = document.getElementById('plotCanvas') as HTMLCanvasElement;
  if (!canvas) return;

  const container = canvas.parentElement!;
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;

  const controlPanel = createControlPanel();
  document.body.appendChild(controlPanel);

  const ringBuffer = new SharedRingBuffer(100_000);
  (window as any).ringBuffer = ringBuffer;

  const renderer = new WebGPURenderer(canvas);
  await renderer.initialize();
  renderer.setDataSource(ringBuffer);

  const gridOverlay = new GridOverlay(canvas);

  const worker = new Worker(
    new URL('./lib/worker/data.worker.ts', import.meta.url),
    { type: 'module' }
  );

  worker.postMessage({
    buffer: ringBuffer.buffer,
    head: ringBuffer.head
  });

  // ========================
  // ZOOM & PAN
  // ========================

  let viewportStart = 0;
  let viewportEnd = 100_000;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartViewportStart = 0;
  let dragStartViewportEnd = 0;

  // Mausrad Zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left) / rect.width; // 0..1

    const currentRange = viewportEnd - viewportStart;
    const zoomFactor = e.deltaY < 0 ? 0.8 : 1.25; // Zoom in/out
    const newRange = Math.max(100, Math.min(100_000, currentRange * zoomFactor));

    // Zoom zum Mauszeiger
    const anchorSample = viewportStart + mouseX * currentRange;
    viewportStart = Math.floor(anchorSample - mouseX * newRange);
    viewportEnd = viewportStart + newRange;

    // Begrenzen
    if (viewportStart < 0) {
      viewportStart = 0;
      viewportEnd = newRange;
    }
    if (viewportEnd > ringBuffer.currentHead) {
      viewportEnd = ringBuffer.currentHead;
      viewportStart = Math.max(0, viewportEnd - newRange);
    }

    renderer.setViewport(viewportStart, viewportEnd);

  }, { passive: false });

  // Pan mit Drag
  canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartViewportStart = viewportStart;
    dragStartViewportEnd = viewportEnd;
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const rect = canvas.getBoundingClientRect();
    const deltaX = e.clientX - dragStartX;
    const deltaSamples = -Math.floor((deltaX / rect.width) * (dragStartViewportEnd - dragStartViewportStart));

    viewportStart = dragStartViewportStart + deltaSamples;
    viewportEnd = dragStartViewportEnd + deltaSamples;

    // Begrenzen
    if (viewportStart < 0) {
      const shift = -viewportStart;
      viewportStart = 0;
      viewportEnd += shift;
    }
    if (viewportEnd > ringBuffer.currentHead) {
      const shift = viewportEnd - ringBuffer.currentHead;
      viewportEnd = ringBuffer.currentHead;
      viewportStart -= shift;
    }

    renderer.setViewport(viewportStart, viewportEnd);
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
    canvas.style.cursor = 'default';
  });

  // Resize Handler
  window.addEventListener('resize', () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.resize(w, h);
    gridOverlay.resize(w, h);
  });

  // Button Logic
  const startBtn = document.getElementById("startBtn") as HTMLButtonElement;
  const durationInput = document.getElementById("durationInput") as HTMLInputElement;
  const sampleRateInput = document.getElementById("sampleRateInput") as HTMLInputElement;

  startBtn.addEventListener("click", async () => {
    if (isStreaming) return;

    const duration = parseFloat(durationInput.value);
    const sampleRate = parseInt(sampleRateInput.value);

    try {
      updateStatus("Configuring server...");
      await configureStream(duration, sampleRate);

      worker.postMessage({ type: 'start' });

      updateStatus(`Streaming: ${duration}s @ ${sampleRate} Hz`);
      isStreaming = true;
      startBtn.disabled = true;
      startBtn.textContent = "⏸ STREAMING...";
      startBtn.style.background = "#666";

      setTimeout(() => {
        isStreaming = false;
        startBtn.disabled = false;
        startBtn.textContent = "▶ START STREAM";
        startBtn.style.background = "#00ff00";
        updateStatus("Stream completed | Scroll to zoom, drag to pan");
      }, duration * 1000 + 2000);

    } catch (error: any) {
      updateStatus(`Error: ${error.message}`);
      isStreaming = false;
    }
  });

  // Render Loop
  let frameCount = 0;
  let lastFpsUpdate = performance.now();
  let lastGridUpdate = 0;

  function frame() {
    renderer.render();

    const now = performance.now();

    if (now - lastGridUpdate > 100) {
      const currentHead = ringBuffer.currentHead;
      if (currentHead > 0) {
        let min = Infinity, max = -Infinity;
        const start = Math.max(0, viewportStart);
        const end = Math.min(currentHead, viewportEnd);

        for (let i = start; i < end; i++) {
          const v = ringBuffer.data[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }

        if (min === Infinity) min = -2.5;
        if (max === -Infinity) max = 2.5;

        gridOverlay.draw(min, max, end - start, 10000);
      } else {
        gridOverlay.draw(-2.5, 2.5, 10000, 10000);
      }
      lastGridUpdate = now;
    }

    frameCount++;
    if (now - lastFpsUpdate >= 1000) {
      const fps = frameCount;
      frameCount = 0;
      lastFpsUpdate = now;
      if (!isStreaming) {
        const range = viewportEnd - viewportStart;
        updateStatus(`Ready | FPS: ${fps} | Zoom: ${(100_000 / range).toFixed(1)}x`);
      }
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  updateStatus("System ready | Scroll to zoom, drag to pan");
}

startProject().catch(console.error);