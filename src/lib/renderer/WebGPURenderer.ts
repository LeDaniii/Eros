import { SharedRingBuffer } from "../core/SharedRingBuffer";

interface Viewport {
    minValue: number;
    maxValue: number;
    startIndex: number;
    endIndex: number;
}

export class WebGPURenderer {
    private device: GPUDevice | null = null;
    private context: GPUCanvasContext | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private dataBuffer: GPUBuffer | null = null;
    private uniformBuffer: GPUBuffer | null = null;
    private bindGroup: GPUBindGroup | null = null;
    private msaaTexture: GPUTexture | null = null;
    private readonly sampleCount = 4;

    private ringBuffer: SharedRingBuffer | null = null;
    private viewport: Viewport = {
        minValue: -2.5,
        maxValue: 2.5,
        startIndex: 0,
        endIndex: 0
    };

    // NEU: Für Zoom/Pan
    private viewportOverride: { start: number; end: number } | null = null;

    constructor(private canvas: HTMLCanvasElement) { }

    public setDataSource(rb: SharedRingBuffer) {
        this.ringBuffer = rb;
        this.createGPUResources();
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

        this.uniformBuffer = this.device.createBuffer({
            size: 24,
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

    async initialize() {
        const adapter = await navigator.gpu?.requestAdapter({
            powerPreference: 'high-performance'
        });

        if (!adapter) throw new Error("WebGPU nicht unterstützt");
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

    private getWGSLCode(): string {
        return `
        struct Uniforms {
            resolution: vec2<f32>,
            minValue: f32,
            maxValue: f32,
            startIndex: f32,
            endIndex: f32,
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
            
            // FIX: startIndex + idx für korrekten Array-Zugriff!
            let actualIndex = u32(uniforms.startIndex) + idx;
            let val = data[actualIndex];
            
            let visibleCount = uniforms.endIndex - uniforms.startIndex;
            
            // X: Normalisiert über visible samples
            let normalizedX = f32(idx) / visibleCount;
            let x = normalizedX * 2.0 - 1.0;
            
            // Y: Auto-scale
            let valueRange = uniforms.maxValue - uniforms.minValue;
            let normalizedY = (val - uniforms.minValue) / valueRange;
            let y = (normalizedY * 2.0 - 1.0) * 0.95;
            
            out.position = vec4<f32>(x, y, 0.0, 1.0);
            out.color = vec4<f32>(0.0, 1.0, 0.0, 1.0);
            
            return out;
        }

        @fragment
        fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
            return color;
        }
    `;
    }

    // GEÄNDERT: Beachtet jetzt viewportOverride
    private updateViewport() {
        if (!this.ringBuffer) return;

        const currentHead = this.ringBuffer.currentHead;

        // Wenn Viewport manuell gesetzt wurde (Zoom/Pan)
        if (this.viewportOverride) {
            this.viewport.startIndex = Math.max(0, this.viewportOverride.start);
            this.viewport.endIndex = Math.min(currentHead, this.viewportOverride.end);
        } else {
            // Sonst: Gesamte Kurve anzeigen
            this.viewport.startIndex = 0;
            this.viewport.endIndex = Math.max(currentHead, 1);
        }

        // Min/Max über SICHTBARE Daten berechnen
        let min = Infinity;
        let max = -Infinity;

        for (let i = this.viewport.startIndex; i < this.viewport.endIndex; i++) {
            const val = this.ringBuffer.data[i];
            if (val < min) min = val;
            if (val > max) max = val;
        }

        if (min === Infinity) min = -2.5;
        if (max === -Infinity) max = 2.5;

        const range = max - min;
        const padding = range * 0.05;
        this.viewport.minValue = min - padding;
        this.viewport.maxValue = max + padding;
    }

    public render() {
        if (!this.device || !this.ringBuffer || !this.dataBuffer ||
            !this.uniformBuffer || !this.pipeline || !this.bindGroup ||
            !this.context || !this.msaaTexture) return;

        const currentHead = this.ringBuffer.currentHead;
        if (currentHead < 2) return;

        this.updateViewport();

        const uniformData = new Float32Array([
            this.canvas.width,
            this.canvas.height,
            this.viewport.minValue,
            this.viewport.maxValue,
            this.viewport.startIndex,
            this.viewport.endIndex,
        ]);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

        this.device.queue.writeBuffer(
            this.dataBuffer,
            0,
            this.ringBuffer.data.buffer,
            this.ringBuffer.data.byteOffset,
            this.ringBuffer.data.byteLength
        );

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
        renderPass.setBindGroup(0, this.bindGroup);

        const sampleCount = Math.floor(this.viewport.endIndex - this.viewport.startIndex);
        renderPass.draw(sampleCount);

        renderPass.end();
        this.device.queue.submit([commandEncoder.finish()]);
    }

    public resize(width: number, height: number) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.createMSAATexture();
    }
}