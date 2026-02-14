/**
 * WebGPU Renderer - Hardware-beschleunigtes Rendering für Millionen von Datenpunkten
 *
 * WARUM WebGPU statt Canvas2D?
 * - Canvas2D: CPU-basiert, max ~10.000 Punkte @ 60fps
 * - WebGPU: GPU-basiert, MILLIONEN Punkte @ 60fps
 *
 * WIE funktioniert WebGPU?
 * 1. Daten werden in GPU-Speicher kopiert (GPUBuffer)
 * 2. GPU führt Shader-Programme aus (PARALLEL für alle Punkte!)
 * 3. Vertex Shader: Berechnet Position jedes Punktes
 * 4. Fragment Shader: Malt die Pixel
 *
 * WAS ist MSAA?
 * - Multi-Sample Anti-Aliasing (4x)
 * - Macht Linien glatt statt pixelig
 * - GPU rendert mit 4-facher Auflösung, dann downsampled
 *
 * Performance-Trick: line-strip Topology
 * - Statt jeden Punkt einzeln: Verbinde Punkte als Linie
 * - 100.000 Punkte = 99.999 Linien (GPU macht das automatisch!)
 */

import { SharedRingBuffer } from "../core/SharedRingBuffer";

interface Viewport {
    minValue: number;    // Y-Achse Minimum (für Auto-Scaling)
    maxValue: number;    // Y-Achse Maximum (für Auto-Scaling)
    startIndex: number;  // Erster sichtbarer Sample (für Zoom)
    endIndex: number;    // Letzter sichtbarer Sample (für Zoom)
}

export class WebGPURenderer {
    // === GPU Core Resources ===
    private device: GPUDevice | null = null;           // Die GPU selbst (logisches Gerät)
    private context: GPUCanvasContext | null = null;   // Verbindung zwischen GPU und Canvas
    private pipeline: GPURenderPipeline | null = null; // Shader-Pipeline (Vertex + Fragment Shader)

    // === GPU Memory Buffers ===
    private dataBuffer: GPUBuffer | null = null;     // Enthält die Messwerte (Float32Array)
    private uniformBuffer: GPUBuffer | null = null;  // Enthält Viewport-Infos (Zoom, Min/Max)

    // === Rendering Resources ===
    private bindGroup: GPUBindGroup | null = null;   // Verbindet Shader mit Buffern
    private msaaTexture: GPUTexture | null = null;   // Für Anti-Aliasing
    private readonly sampleCount = 4;                 // 4x MSAA (Multi-Sample Anti-Aliasing)

    // === Data Source ===
    private ringBuffer: SharedRingBuffer | null = null;

    // === Viewport State ===
    private viewport: Viewport = {
        minValue: -2.5,   // Y-Achse unten (wird automatisch berechnet)
        maxValue: 2.5,    // Y-Achse oben (wird automatisch berechnet)
        startIndex: 0,    // Erster sichtbarer Datenpunkt
        endIndex: 0       // Letzter sichtbarer Datenpunkt
    };

    // Manueller Zoom/Pan Override (null = zeige alles)
    private viewportOverride: { start: number; end: number } | null = null;

    // === Line Color ===
    private lineColor: [number, number, number, number] = [0.0, 1.0, 0.0, 1.0]; // Default: Grün (RGBA)

    constructor(private canvas: HTMLCanvasElement) { }

    public setDataSource(rb: SharedRingBuffer) {
        this.ringBuffer = rb;
        this.createGPUResources();
    }

    /**
     * Setzt die Linienfarbe
     * @param hexColor - Farbe als Hex-String (z.B. '#00ff00' für Grün)
     */
    public setLineColor(hexColor: string) {
        this.lineColor = this.hexToRGBA(hexColor);
    }

    /**
     * Konvertiert Hex-Farbe zu RGBA (für GPU Shader)
     * @param hex - Hex-String wie '#00ff00' oder '#0f0'
     * @returns RGBA Array [r, g, b, a] mit Werten 0.0-1.0
     */
    private hexToRGBA(hex: string): [number, number, number, number] {
        // Entferne '#' falls vorhanden
        hex = hex.replace('#', '');

        // Kurze Form (#RGB) zu langer Form (#RRGGBB) expandieren
        if (hex.length === 3) {
            hex = hex.split('').map(c => c + c).join('');
        }

        // Parse Hex zu RGB (0-255)
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);

        // Konvertiere zu 0.0-1.0 (GPU braucht das so)
        return [r / 255, g / 255, b / 255, 1.0];
    }

    // NEU: Viewport setzen
    public setViewport(startIndex: number, endIndex: number) {
        this.viewportOverride = {
            start: Math.floor(startIndex),
            end: Math.floor(endIndex)
        };
    }

    // NEU: Viewport zurücksetzen
    public resetViewport() {
        this.viewportOverride = null;
    }

    private createGPUResources() {
        if (!this.device || !this.ringBuffer) return;

        this.dataBuffer = this.device.createBuffer({
            size: this.ringBuffer.data.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Uniform Buffer: 6 floats (24 bytes) + 8 bytes padding + 4 floats für Farbe (16 bytes) = 48 bytes
        // WICHTIG: vec4<f32> muss an 16-Byte Grenzen aligned sein!
        this.uniformBuffer = this.device.createBuffer({
            size: 48,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.bindGroup = this.device.createBindGroup({
            layout: this.pipeline!.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.dataBuffer } },
                { binding: 1, resource: { buffer: this.uniformBuffer } }
            ]
        });
    }

    /**
     * Initialisiert WebGPU
     *
     * WAS passiert hier?
     * 1. Fordert GPU-Zugriff an (requestAdapter)
     * 2. Erstellt ein logisches GPU-Gerät (requestDevice)
     * 3. Verbindet GPU mit Canvas (context)
     * 4. Kompiliert Shader (setupPipeline)
     * 5. Erstellt MSAA Texture (Anti-Aliasing)
     *
     * WARUM 'high-performance'?
     * - Laptop haben oft 2 GPUs: Integriert (stromsparend) + Dediziert (schnell)
     * - Wir wollen die schnelle GPU für viele Datenpunkte!
     */
    async initialize() {
        // Fordere GPU-Adapter an (wie: "Gib mir Zugriff auf die Grafikkarte")
        const adapter = await navigator.gpu?.requestAdapter({
            powerPreference: 'high-performance'  // Wähle die schnellste GPU
        });

        if (!adapter) throw new Error("WebGPU nicht unterstützt (braucht Chrome/Edge 113+)");

        // Erstelle logisches GPU-Gerät (unser Interface zur Hardware)
        this.device = await adapter.requestDevice();

        // Hole WebGPU Context vom Canvas (wie getContext('2d'), aber für GPU)
        this.context = this.canvas.getContext('webgpu');
        if (!this.context) throw new Error("WebGPU Context failed");

        // Konfiguriere Canvas für GPU-Rendering
        this.context.configure({
            device: this.device,
            format: navigator.gpu.getPreferredCanvasFormat(),  // Meist 'bgra8unorm'
            alphaMode: 'premultiplied',  // Für transparente Überlagerungen
        });

        // Kompiliere Shader und erstelle Render-Pipeline
        await this.setupPipeline();

        // Erstelle Texture für Anti-Aliasing
        this.createMSAATexture();
    }

    private createMSAATexture() {
        if (!this.device) return;

        this.msaaTexture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height],
            sampleCount: this.sampleCount,
            format: navigator.gpu.getPreferredCanvasFormat(),
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
    }

    private async setupPipeline() {
        if (!this.device) return;

        const shaderModule = this.device.createShaderModule({
            code: this.getWGSLCode()
        });

        this.pipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: navigator.gpu.getPreferredCanvasFormat(),
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                    },
                }],
            },
            primitive: {
                topology: 'line-strip',
            },
            multisample: {
                count: this.sampleCount,
            },
        });
    }

    /**
     * WGSL Shader Code - Das Herz des Renderers!
     *
     * WAS ist ein Shader?
     * - Ein Mini-Programm das auf der GPU läuft
     * - Wird PARALLEL für alle Punkte ausgeführt (darum so schnell!)
     * - Geschrieben in WGSL (WebGPU Shading Language)
     *
     * ZWEI Arten von Shadern:
     * 1. VERTEX SHADER: Berechnet Position jedes Punktes (X/Y Koordinaten)
     * 2. FRAGMENT SHADER: Malt die Pixel (Farbe)
     *
     * GPU Koordinatensystem:
     * - X: -1 (links) bis +1 (rechts)
     * - Y: -1 (unten) bis +1 (oben)
     * - Z: 0 (vorne) bis 1 (hinten) - brauchen wir nicht für 2D
     */
    private getWGSLCode(): string {
        return `
        // ============================================
        // DATEN-STRUKTUREN (wie TypeScript Interfaces)
        // ============================================

        // Uniforms = Daten die für ALLE Vertices gleich sind
        // (Viewport, Zoom-Level, Farbe, etc.)
        struct Uniforms {
            resolution: vec2<f32>,  // Canvas-Größe (width, height)
            minValue: f32,          // Y-Achse Minimum (für Scaling)
            maxValue: f32,          // Y-Achse Maximum (für Scaling)
            startIndex: f32,        // Erster sichtbarer Sample (Zoom)
            endIndex: f32,          // Letzter sichtbarer Sample (Zoom)
            lineColor: vec4<f32>,   // Linienfarbe (RGBA)
        }

        // Binding 0: Die Messdaten (SharedArrayBuffer Daten!)
        // storage = Großer Speicher (kann Millionen Floats enthalten)
        // read = Shader liest nur, schreibt nicht
        @group(0) @binding(0) var<storage, read> data: array<f32>;

        // Binding 1: Die Uniform-Daten (Viewport Info)
        // uniform = Kleiner Speicher, aber ultra-schneller Zugriff
        @group(0) @binding(1) var<uniform> uniforms: Uniforms;

        // Output des Vertex-Shaders (geht zum Fragment-Shader)
        struct VertexOutput {
            @builtin(position) position: vec4<f32>,  // Wo ist der Punkt?
            @location(0) color: vec4<f32>,           // Welche Farbe?
        };

        // ============================================
        // VERTEX SHADER - Läuft für JEDEN Datenpunkt
        // ============================================
        @vertex
        fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
            var out: VertexOutput;

            // WICHTIG: idx ist relativ (0, 1, 2, ...)
            // Aber wir zeigen vielleicht nur Samples 5000-10000 (Zoom!)
            // → Wir müssen startIndex addieren!
            let actualIndex = u32(uniforms.startIndex) + idx;
            let val = data[actualIndex];  // Holt den Messwert aus dem Buffer

            // Wie viele Samples sind sichtbar? (für X-Achsen Berechnung)
            let visibleCount = uniforms.endIndex - uniforms.startIndex;

            // ========== X-POSITION BERECHNEN ==========
            // idx geht von 0 bis visibleCount
            // Wir wollen: 0 → -1 (links), visibleCount → +1 (rechts)
            let normalizedX = f32(idx) / visibleCount;  // 0.0 bis 1.0
            let x = normalizedX * 2.0 - 1.0;            // -1.0 bis +1.0

            // ========== Y-POSITION BERECHNEN ==========
            // Auto-Scaling: Messwerte passen sich an Min/Max an
            let valueRange = uniforms.maxValue - uniforms.minValue;
            let normalizedY = (val - uniforms.minValue) / valueRange;  // 0.0 bis 1.0
            let y = (normalizedY * 2.0 - 1.0) * 0.95;  // -0.95 bis +0.95 (5% Padding)

            // Setze Position (vec4 weil GPU will x,y,z,w - w=1.0 ist Standard)
            out.position = vec4<f32>(x, y, 0.0, 1.0);

            // Setze Farbe (aus Uniforms statt hardcoded!)
            out.color = uniforms.lineColor;

            return out;
        }

        // ============================================
        // FRAGMENT SHADER - Malt die Pixel
        // ============================================
        // Dieser Shader ist trivial: Nimm die Farbe vom Vertex Shader
        @fragment
        fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
            return color;  // Einfach die Farbe zurückgeben (grün)
        }
    `;
    }

    /**
     * Berechnet den Viewport (welcher Bereich ist sichtbar?)
     *
     * ZWEI Modi:
     * 1. Auto-View: Zeige alle Daten (von 0 bis currentHead)
     * 2. Zoom/Pan: Zeige nur einen Ausschnitt (viewportOverride)
     *
     * Auto-Scaling:
     * - Findet Min/Max der SICHTBAREN Daten
     * - Y-Achse passt sich automatisch an
     * - +5% Padding oben/unten (sieht besser aus)
     */
    private updateViewport() {
        if (!this.ringBuffer) return;

        const currentHead = this.ringBuffer.currentHead;

        // ========== BEREICH FESTLEGEN ==========
        if (this.viewportOverride) {
            // User hat gezoomt/gepannt → Zeige nur den gewählten Bereich
            this.viewport.startIndex = Math.max(0, this.viewportOverride.start);
            this.viewport.endIndex = Math.min(currentHead, this.viewportOverride.end);
        } else {
            // Kein Zoom → Zeige alles von Anfang bis jetzt
            this.viewport.startIndex = 0;
            this.viewport.endIndex = Math.max(currentHead, 1);
        }

        // ========== AUTO-SCALING (Y-Achse) ==========
        // Finde Min/Max über SICHTBARE Daten (nicht alle!)
        let min = Infinity;
        let max = -Infinity;

        for (let i = this.viewport.startIndex; i < this.viewport.endIndex; i++) {
            const val = this.ringBuffer.data[i];
            if (val < min) min = val;
            if (val > max) max = val;
        }

        // Fallback falls keine Daten vorhanden
        if (min === Infinity) min = -2.5;
        if (max === -Infinity) max = 2.5;

        // 5% Padding oben/unten (sonst klebt Kurve am Rand)
        const range = max - min;
        const padding = range * 0.05;
        this.viewport.minValue = min - padding;
        this.viewport.maxValue = max + padding;
    }

    /**
     * Rendert einen Frame (wird 60x pro Sekunde aufgerufen!)
     *
     * ABLAUF:
     * 1. Viewport berechnen (welcher Bereich ist sichtbar?)
     * 2. Uniforms updaten (Viewport-Info an GPU schicken)
     * 3. Daten updaten (SharedArrayBuffer → GPU Buffer kopieren)
     * 4. Render Pass erstellen (GPU-Kommandos aufzeichnen)
     * 5. Draw Call (GPU: "Mal die Kurve!")
     * 6. Submit (GPU: "Los, führe die Kommandos aus!")
     *
     * WARUM so umständlich?
     * - GPU arbeitet ASYNCHRON (wir schicken Kommandos, GPU macht sie später)
     * - CommandEncoder = Liste von Kommandos
     * - submit() = Schick die Liste an die GPU
     */
    public render() {
        // Sicherheits-Check: Ist alles initialisiert?
        if (!this.device || !this.ringBuffer || !this.dataBuffer ||
            !this.uniformBuffer || !this.pipeline || !this.bindGroup ||
            !this.context || !this.msaaTexture) return;

        const currentHead = this.ringBuffer.currentHead;
        if (currentHead < 2) return;  // Mindestens 2 Punkte für eine Linie

        // Berechne Viewport (Auto-Scaling, Zoom/Pan)
        this.updateViewport();

        // ========== UNIFORMS UPDATEN ==========
        // Diese Daten gehen an den Shader (siehe Uniforms struct im WGSL Code!)
        const uniformData = new Float32Array([
            this.canvas.width,           // Offset 0:  resolution.x
            this.canvas.height,          // Offset 4:  resolution.y
            this.viewport.minValue,      // Offset 8:  minValue (Y-Achse unten)
            this.viewport.maxValue,      // Offset 12: maxValue (Y-Achse oben)
            this.viewport.startIndex,    // Offset 16: startIndex (Zoom Start)
            this.viewport.endIndex,      // Offset 20: endIndex (Zoom Ende)
            0, 0,                        // Offset 24/28: PADDING (8 bytes) für Alignment!
            this.lineColor[0],           // Offset 32: lineColor.r
            this.lineColor[1],           // Offset 36: lineColor.g
            this.lineColor[2],           // Offset 40: lineColor.b
            this.lineColor[3],           // Offset 44: lineColor.a
        ]);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

        // ========== DATEN UPDATEN ==========
        // Kopiere SharedArrayBuffer → GPU Buffer
        // WICHTIG: Jeder Frame! (Daten ändern sich live)
        this.device.queue.writeBuffer(
            this.dataBuffer,                    // Ziel: GPU Buffer
            0,                                   // Offset im GPU Buffer
            this.ringBuffer.data.buffer,        // Quelle: SharedArrayBuffer
            this.ringBuffer.data.byteOffset,    // Offset in Quelle (4 Bytes Header!)
            this.ringBuffer.data.byteLength     // Wie viele Bytes kopieren?
        );

        // ========== RENDER PASS ==========
        // CommandEncoder = "Aufnahme" von GPU-Befehlen
        const commandEncoder = this.device.createCommandEncoder();

        // Hole aktuelle Canvas-Texture (wohin wir rendern)
        const currentTexture = this.context.getCurrentTexture();

        // Starte Render Pass (wie: "Öffne Photoshop, neue Ebene")
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: this.msaaTexture.createView(),           // Render in MSAA Texture (4x Auflösung)
                resolveTarget: currentTexture.createView(),    // Dann downsample ins Canvas
                clearValue: { r: 0.05, g: 0.05, b: 0.05, a: 1 }, // Hintergrund: Dunkelgrau
                loadOp: 'clear',   // Lösche vorherigen Frame
                storeOp: 'store',  // Speichere das Resultat
            }],
        });

        // Setze Pipeline (welche Shader benutzen?)
        renderPass.setPipeline(this.pipeline);

        // Binde Daten (Shader kann jetzt auf dataBuffer + uniformBuffer zugreifen)
        renderPass.setBindGroup(0, this.bindGroup);

        // ========== DRAW CALL ==========
        // Sag der GPU: "Male X Vertices als line-strip"
        const sampleCount = Math.floor(this.viewport.endIndex - this.viewport.startIndex);
        renderPass.draw(sampleCount);  // GPU führt Vertex Shader sampleCount-mal aus!

        renderPass.end();

        // ========== SUBMIT ==========
        // Schick alle Kommandos an die GPU (jetzt passiert's wirklich!)
        this.device.queue.submit([commandEncoder.finish()]);
    }

    public resize(width: number, height: number) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.createMSAATexture();
    }
}