# 🚀 Eros Charts - High-Performance gRPC Streaming Charts

WebGPU-basierte Chart-Library für Echtzeit-Datenvisualisierung über gRPC Streams.

## ✨ Features

- **WebGPU Rendering** - Millionen von Datenpunkten @ 60fps
- **gRPC Server-Streaming** - Effiziente Echtzeit-Daten-Übertragung
- **SharedArrayBuffer** - Lock-free Threading für maximale Performance
- **Auto-Scaling** - Y-Achse passt sich automatisch an
- **Zoom & Pan** - Interaktive Datenexploration
- **TypeScript** - Voll typisierte API

## 🎯 Use Cases

- Embedded/IoT Dashboards (z.B. Prüfstände)
- Scientific Data Visualization
- Monitoring Tools

## 🚀 Quick Start

### 1. Server starten

```bash
cd eros-server
npm install
node server.mjs
```

Server läuft auf `http://localhost:50051`

### 2. Frontend starten

```bash
npm install
npm run dev
```

Öffne `http://localhost:5173`

## 💻 Verwendung

```typescript
import { ErosChart } from './lib/api/ErosChart';

// Chart erstellen
const chart = new ErosChart('#plotCanvas', {
  grpcUrl: 'http://localhost:50051',
  bufferSize: 100_000,   // 10 Sekunden @ 10kHz
  sampleRate: 10_000,    // 10kHz
  lineColor: '#00ff00'   // Optional: Linienfarbe (default: grün)
});

// Initialisieren
await chart.initialize();

// Stream starten
await chart.startStream({ duration: 30 });

// Zoom/Pan
chart.setViewport(5000, 15000);    // Zeige Samples 5k-15k
chart.resetViewport();              // Zurück zur Vollansicht
```

## 📁 Projekt-Struktur

```
eros/
├── src/
│   ├── lib/                    # Die Eros Chart Library
│   │   ├── api/
│   │   │   └── ErosChart.ts   # Haupt-API (Start hier!)
│   │   ├── core/
│   │   │   └── SharedRingBuffer.ts  # Thread-sicherer Ringpuffer
│   │   ├── renderer/
│   │   │   ├── WebGPURenderer.ts    # WebGPU Renderer
│   │   │   └── GridOverlay.ts       # Canvas2D Grid
│   │   ├── worker/
│   │   │   └── data.worker.ts       # gRPC Stream Worker
│   │   └── index.ts            # Public Exports
│   │
│   ├── main.ts                 # Demo App
│   └── gen/                    # Generated Protobuf Code
│
├── eros-server/                # Beispiel gRPC Server
│   ├── server.mjs             # Node.js Server
│   └── gen/                    # Generated Protobuf Code
│
└── src/lib/api/proto/
    └── measurements.proto      # gRPC Schema
```

## 🧠 Wie funktioniert's?

### WebGPU Rendering
```
CPU: Daten in GPU Buffer kopieren
GPU: Vertex Shader läuft PARALLEL für alle Punkte
GPU: Fragment Shader malt die Pixel
Ergebnis: 60fps bei Millionen von Punkten!
```

### SharedArrayBuffer
```
Worker Thread: gRPC Stream → schreibt in SharedArrayBuffer
Main Thread: Renderer → liest aus SharedArrayBuffer
Vorteil: Keine Kopie nötig, ultra-schnell!
```

### gRPC Server-Streaming
```
Client: "Gib mir Messdaten"
Server: Batch 1 (100 Samples)
Server: Batch 2 (100 Samples)
Server: Batch 3 (100 Samples)
...
Vorteil: 1 Connection, viele Messages (effizient!)
```

## 📚 Lern-Kommentare

Der Code ist VOLLSTÄNDIG kommentiert mit:
- **WAS** passiert (für schnelles Verstehen)
- **WARUM** diese Lösung (für Lernen)
- **WIE** es technisch funktioniert (Details)

Perfekt zum Lernen von WebGPU, SharedArrayBuffer, gRPC!

## 🛠️ Technologie-Stack

- **WebGPU** (WGSL Shaders)
- **gRPC / Connect-RPC** (Protocol Buffers)
- **Web Workers** (Background Threading)
- **SharedArrayBuffer + Atomics** (Lock-free Sync)
- **TypeScript** (Type Safety)
- **Vite** (Build Tool)

## Binary Curve Format (`.erosb`)

The app can export and import native binary curve files with the `.erosb` extension.

- Spec: `docs/erosb-format.md`
- APIs: `ErosChart.exportBinary()`, `ErosChart.decodeBinary()`, `ErosChart.loadData()`

## 🔧 Entwicklung

```bash
# TypeScript kompilieren
npm run build

# Dev Server (Hot Reload)
npm run dev

# Protobuf Code generieren
npm run buf:generate
```

## 📦 Als Library nutzen

In `package.json` kannst du das später publishen:

```json
{
  "name": "@eros/charts",
  "main": "./dist/lib/index.js",
  "types": "./dist/lib/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/lib/index.js",
      "types": "./dist/lib/index.d.ts"
    }
  }
}
```

Dann in anderen Projekten:

```bash
npm install @eros/charts
```

```typescript
import { ErosChart } from '@eros/charts';
```

## 🎓 Wichtige Konzepte

### 1. **Warum WebGPU statt Canvas2D?**
Canvas2D ist CPU-basiert und schafft maximal ~10.000 Punkte bei 60fps.
WebGPU nutzt die GPU (parallele Berechnung) → Millionen von Punkten möglich!

### 2. **Warum SharedArrayBuffer?**
Normales ArrayBuffer: Jeder Thread bekommt eine KOPIE (langsam!).
SharedArrayBuffer: BEIDE Threads sehen den GLEICHEN Speicher (schnell!).

### 3. **Warum gRPC Streaming?**
10.000 Samples/Sekunde = 10.000 HTTP Requests wäre irre.
gRPC Stream hält die Verbindung offen und schickt Daten fortlaufend.

## 🚧 TODOs für Production

- [ ] Multi-Channel Support (mehrere Kurven gleichzeitig)
- [ ] Cursors & Measurements
- [ ] Export (PNG/CSV)
- [ ] WebGPU Fallback (Canvas2D für alte Browser)
- [ ] Reconnection Logic
- [ ] npm Package veröffentlichen
- [ ] Dokumentations-Website (VitePress)
- [ ] Unit Tests

## 📄 Lizenz

Noch offen - für private/firmeninternen Gebrauch OK!

---

**Made with ❤️ für Prüfstände und High-Performance Visualisierung**

