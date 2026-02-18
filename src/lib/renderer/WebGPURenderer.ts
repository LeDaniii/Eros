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
 *
 * ADAPTIVE DOWNSAMPLING:
 * - Rausgezoomt (>4 Punkte/Pixel): Min/Max pro Pixel-Bucket → ~4000 Vertices
 * - Reingezoomt (≤4 Punkte/Pixel): Exakte Daten → Point-Snapping möglich
 */

import { SharedRingBuffer } from "../core/SharedRingBuffer";
import { Downsampler, DownsampleResult } from "../core/Downsampler";

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
    private dataBuffer: GPUBuffer | null = null;           // Voller Ring-Buffer für Exact Mode
    private downsampledBuffer: GPUBuffer | null = null;    // Kleiner Buffer für Downsampled Mode
    private uniformBuffer: GPUBuffer | null = null;        // Viewport-Infos (Zoom, Min/Max, Mode)

    // === Rendering Resources ===
    private bindGroup: GPUBindGroup | null = null;              // Exact Mode: voller Buffer
    private downsampledBindGroup: GPUBindGroup | null = null;   // Downsampled Mode: kleiner Buffer
    private msaaTexture: GPUTexture | null = null;              // Für Anti-Aliasing
    private readonly sampleCount = 4;                            // 4x MSAA

    // === Data Source ===
    private ringBuffer: SharedRingBuffer | null = null;

    // === Downsampling ===
    private downsampler: Downsampler | null = null;
    private lastDownsampleResult: DownsampleResult | null = null;

    // === Viewport State ===
    private viewport: Viewport = {
        minValue: -2.5,
        maxValue: 2.5,
        startIndex: 0,
        endIndex: 0
    };

    // Manueller Zoom/Pan Override (null = zeige alles)
    private viewportOverride: { start: number; end: number } | null = null;

    // === Line Color ===
    private lineColor: [number, number, number, number] = [0.0, 1.0, 0.0, 1.0];

    constructor(private canvas: HTMLCanvasElement) { }

    public setDataSource(rb: SharedRingBuffer) {
        this.ringBuffer = rb;
        this.createGPUResources();
    }

    public setLineColor(hexColor: string) {
        this.lineColor = this.hexToRGBA(hexColor);
    }

    private hexToRGBA(hex: string): [number, number, number, number] {
        hex = hex.replace('#', '');
        if (hex.length === 3) {
            hex = hex.split('').map(c => c + c).join('');
        }
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return [r / 255, g / 255, b / 255, 1.0];
    }

    public setViewport(startIndex: number, endIndex: number) {
        this.viewportOverride = {
            start: Math.floor(startIndex),
            end: Math.floor(endIndex)
        };
    }

    public resetViewport() {
        this.viewportOverride = null;
    }

    public getViewport(): Viewport {
        return { ...this.viewport };
    }

    /** Returns the last downsample result (includes globalMin/globalMax) */
    public getLastDownsampleResult(): DownsampleResult | null {
        return this.lastDownsampleResult;
    }

    private createGPUResources() {
        if (!this.device || !this.ringBuffer) return;

        // Voller Buffer für Exact Mode
        this.dataBuffer = this.device.createBuffer({
            size: this.ringBuffer.data.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Kleiner Buffer für Downsampled Mode (2 floats pro Pixel)
        const maxDownsampledSize = this.canvas.width * 2 * 4;
        this.downsampledBuffer = this.device.createBuffer({
            size: Math.max(maxDownsampledSize, 256),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Uniform Buffer: 12 floats = 48 bytes
        // resolution(2f) + minValue(1f) + maxValue(1f) + startIndex(1f) + endIndex(1f)
        // + mode(1f) + vertexCount(1f) + lineColor(4f)
        this.uniformBuffer = this.device.createBuffer({
            size: 48,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Bind Group für Exact Mode (voller dataBuffer)
        this.bindGroup = this.device.createBindGroup({
            layout: this.pipeline!.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.dataBuffer } },
                { binding: 1, resource: { buffer: this.uniformBuffer } }
            ]
        });

        // Bind Group für Downsampled Mode (kleiner Buffer)
        this.downsampledBindGroup = this.device.createBindGroup({
            layout: this.pipeline!.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.downsampledBuffer } },
                { binding: 1, resource: { buffer: this.uniformBuffer } }
            ]
        });

        // Downsampler initialisieren
        this.downsampler = new Downsampler(this.canvas.width);
    }

    async initialize() {
        const adapter = await navigator.gpu?.requestAdapter({
            powerPreference: 'high-performance'
        });

        if (!adapter) throw new Error("WebGPU nicht unterstützt (braucht Chrome/Edge 113+)");

        this.device = await adapter.requestDevice();

        this.context = this.canvas.getContext('webgpu');
        if (!this.context) throw new Error("WebGPU Context failed");

        this.context.configure({
            device: this.device,
            format: navigator.gpu.getPreferredCanvasFormat(),
            alphaMode: 'premultiplied',
        });

        await this.setupPipeline();
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
     * WGSL Shader Code - Dual-Mode (Exact + Downsampled)
     *
     * EXACT MODE (mode < 0.5):
     * - Daten liegen im vollen Ring-Buffer
     * - Index: startIndex + vertex_index
     * - X-Position: vertex_index / visibleCount
     *
     * DOWNSAMPLED MODE (mode >= 0.5):
     * - Daten liegen im kompakten Buffer [min0, max0, min1, max1, ...]
     * - Index: vertex_index (direkt, da Buffer schon kompakt)
     * - X-Position: floor(vertex_index / 2) / bucketCount (Min+Max teilen sich X)
     */
    private getWGSLCode(): string {
        return `
        struct Uniforms {
            resolution: vec2<f32>,  // Canvas-Größe (width, height)
            minValue: f32,          // Y-Achse Minimum (für Scaling)
            maxValue: f32,          // Y-Achse Maximum (für Scaling)
            startIndex: f32,        // Erster sichtbarer Sample (Exact Mode)
            endIndex: f32,          // Letzter sichtbarer Sample (Exact Mode)
            mode: f32,              // 0.0 = exact, 1.0 = downsampled
            vertexCount: f32,       // Anzahl Vertices (für Downsampled X-Berechnung)
            lineColor: vec4<f32>,   // Linienfarbe (RGBA)
        }

        @group(0) @binding(0) var<storage, read> data: array<f32>;
        @group(0) @binding(1) var<uniform> uniforms: Uniforms;

        struct VertexOutput {
            @builtin(position) position: vec4<f32>,
            @location(0) color: vec4<f32>,
        };

        @vertex
        fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
            var out: VertexOutput;

            // Daten-Index: In Exact Mode offset by startIndex, in Downsampled direkt
            let dataIndex = select(u32(uniforms.startIndex) + idx, idx, uniforms.mode > 0.5);
            let val = data[dataIndex];

            var x: f32;

            if (uniforms.mode < 0.5) {
                // === EXACT MODE ===
                let visibleCount = uniforms.endIndex - uniforms.startIndex;
                let normalizedX = f32(idx) / visibleCount;
                x = normalizedX * 2.0 - 1.0;
            } else {
                // === DOWNSAMPLED MODE ===
                // [min0, max0, min1, max1, ...] → Min+Max teilen sich X-Position
                let bucketCount = uniforms.vertexCount / 2.0;
                let bucketIndex = f32(idx / 2u);
                let normalizedX = (bucketIndex + 0.5) / bucketCount;
                x = normalizedX * 2.0 - 1.0;
            }

            // Y-Position: gleich für beide Modi (Auto-Scaling)
            let valueRange = uniforms.maxValue - uniforms.minValue;
            let normalizedY = (val - uniforms.minValue) / valueRange;
            let y = (normalizedY * 2.0 - 1.0) * 0.95;

            out.position = vec4<f32>(x, y, 0.0, 1.0);
            out.color = uniforms.lineColor;

            return out;
        }

        @fragment
        fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
            return color;
        }
    `;
    }

    /**
     * Berechnet den sichtbaren Bereich (Viewport).
     * Min/Max wird NICHT mehr hier berechnet — das macht der Downsampler als Nebenprodukt.
     */
    private updateViewport() {
        if (!this.ringBuffer) return;

        const currentHead = this.ringBuffer.currentHead;

        if (this.viewportOverride) {
            this.viewport.startIndex = Math.max(0, this.viewportOverride.start);
            this.viewport.endIndex = Math.min(currentHead, this.viewportOverride.end);
        } else {
            this.viewport.startIndex = 0;
            this.viewport.endIndex = Math.max(currentHead, 1);
        }
    }

    /**
     * Rendert einen Frame
     *
     * ABLAUF mit Downsampling:
     * 1. Viewport berechnen (welcher Bereich sichtbar?)
     * 2. Downsampler entscheidet: Exact oder Downsampled?
     * 3. Je nach Modus: kleinen oder großen Buffer zur GPU uploaden
     * 4. Shader rendert mit passendem Modus
     */
    public render() {
        if (!this.device || !this.ringBuffer || !this.dataBuffer ||
            !this.uniformBuffer || !this.pipeline || !this.bindGroup ||
            !this.context || !this.msaaTexture || !this.downsampler ||
            !this.downsampledBuffer || !this.downsampledBindGroup) return;

        const currentHead = this.ringBuffer.currentHead;
        if (currentHead < 2) return;

        this.updateViewport();

        // === DOWNSAMPLING ENTSCHEIDUNG ===
        const result = this.downsampler.process(
            this.ringBuffer.data,
            this.viewport.startIndex,
            this.viewport.endIndex,
            this.canvas.width
        );
        this.lastDownsampleResult = result;

        // Min/Max vom Downsampler übernehmen (gratis Nebenprodukt!)
        const range = result.globalMax - result.globalMin;
        const padding = range * 0.05;
        this.viewport.minValue = result.globalMin - padding;
        this.viewport.maxValue = result.globalMax + padding;

        // === BUFFER + BIND GROUP WÄHLEN ===
        let activeBindGroup: GPUBindGroup;
        let drawCount: number;
        let mode: number;

        if (result.isDownsampled) {
            // DOWNSAMPLED: Nur kleinen Buffer uploaden (~16KB statt 2.8MB)
            this.device.queue.writeBuffer(
                this.downsampledBuffer, 0,
                result.data.buffer,
                result.data.byteOffset,
                result.vertexCount * 4
            );
            activeBindGroup = this.downsampledBindGroup;
            drawCount = result.vertexCount;
            mode = 1.0;
        } else {
            // EXACT: Ring-Buffer uploaden (nur bis currentHead, nicht ganzen Buffer)
            this.device.queue.writeBuffer(
                this.dataBuffer, 0,
                this.ringBuffer.data.buffer,
                this.ringBuffer.data.byteOffset,
                currentHead * 4
            );
            activeBindGroup = this.bindGroup;
            drawCount = Math.floor(this.viewport.endIndex - this.viewport.startIndex);
            mode = 0.0;
        }

        // === UNIFORMS ===
        const uniformData = new Float32Array([
            this.canvas.width,           // resolution.x
            this.canvas.height,          // resolution.y
            this.viewport.minValue,      // minValue
            this.viewport.maxValue,      // maxValue
            this.viewport.startIndex,    // startIndex (Exact Mode)
            this.viewport.endIndex,      // endIndex (Exact Mode)
            mode,                        // 0.0 = exact, 1.0 = downsampled
            result.vertexCount,          // vertexCount (Downsampled Mode)
            this.lineColor[0],           // lineColor.r
            this.lineColor[1],           // lineColor.g
            this.lineColor[2],           // lineColor.b
            this.lineColor[3],           // lineColor.a
        ]);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

        // === RENDER PASS ===
        const commandEncoder = this.device.createCommandEncoder();
        const currentTexture = this.context.getCurrentTexture();

        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: this.msaaTexture.createView(),
                resolveTarget: currentTexture.createView(),
                clearValue: { r: 0.05, g: 0.05, b: 0.05, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });

        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, activeBindGroup);
        renderPass.draw(drawCount);
        renderPass.end();

        this.device.queue.submit([commandEncoder.finish()]);
    }

    public resize(width: number, height: number) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.createMSAATexture();

        // Downsampler Buffer anpassen
        this.downsampler?.onResize(width);

        // GPU Buffer für Downsampled Mode neu erstellen
        if (this.device && this.pipeline && this.uniformBuffer) {
            this.downsampledBuffer?.destroy();
            this.downsampledBuffer = this.device.createBuffer({
                size: Math.max(width * 2 * 4, 256),
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });

            this.downsampledBindGroup = this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.downsampledBuffer } },
                    { binding: 1, resource: { buffer: this.uniformBuffer } }
                ]
            });
        }
    }
}
