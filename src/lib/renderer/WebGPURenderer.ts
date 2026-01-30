import { SharedRingBuffer } from "../core/SharedRingBuffer";

export class WebGPURenderer {
    private device: GPUDevice | null = null;
    private context: GPUCanvasContext | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private dataBuffer: GPUBuffer | null = null;
    private bindGroup: GPUBindGroup | null = null; // Neu: Die Verbindung zum Shader

    private ringBuffer: SharedRingBuffer | null = null;

    constructor(private canvas: HTMLCanvasElement) { }

    public setDataSource(rb: SharedRingBuffer) {
        this.ringBuffer = rb;
        this.createGPUResources();
    }

    private createGPUResources() {
        if (!this.device || !this.ringBuffer) return;

        // 1. GPU Buffer erstellen [cite: 13]
        this.dataBuffer = this.device.createBuffer({
            size: this.ringBuffer.data.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // 2. BindGroup erstellen: Verknüpft dataBuffer mit @binding(0) im Shader
        this.bindGroup = this.device.createBindGroup({
            layout: this.pipeline!.getBindGroupLayout(0),
            entries: [{
                binding: 0,
                resource: { buffer: this.dataBuffer }
            }]
        });
    }

    async initialize() {
        const adapter = await navigator.gpu?.requestAdapter({
            powerPreference: 'high-performance'
        });

        if (!adapter) throw new Error("WebGPU nicht unterstützt");
        this.device = await adapter.requestDevice();

        this.context = this.canvas.getContext('webgpu');
        this.context?.configure({
            device: this.device,
            format: navigator.gpu.getPreferredCanvasFormat(),
            alphaMode: 'premultiplied',
        });

        await this.setupPipeline();
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
                targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
            },
            primitive: {
                topology: 'line-strip', // [cite: 14]
            },
        });
    }

    private getWGSLCode(): string {
        return `
            @group(0) @binding(0) var<storage, read> data: array<f32>;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
            };

            @vertex
            fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
                var out: VertexOutput;
                let val = data[idx];
                let totalPoints = f32(arrayLength(&data));
                
                // Mapping: Index auf X (-1 bis 1), Wert auf Y
                let x = (f32(idx) / totalPoints) * 2.0 - 1.0;
                out.position = vec4<f32>(x, val, 0.0, 1.0);
                return out;
            }

            @fragment
            fn fs_main() -> @location(0) vec4<f32> {
                return vec4<f32>(0.0, 1.0, 0.0, 1.0);
            }
        `;
    }

    public render() {
        if (!this.device || !this.ringBuffer || !this.dataBuffer || !this.pipeline || !this.bindGroup || !this.context) return;

        // 1. Schreib-Pointer atomar aus dem Header (Index 0) lesen [cite: 10, 11]
        // Wir nutzen ihn hier noch nicht im Shader, aber wir brauchen ihn für die Sync
        const currentHead = Atomics.load(this.ringBuffer.head, 0);

        // 2. Daten vom SharedArrayBuffer zur GPU kopieren [cite: 13]
        this.device.queue.writeBuffer(
            this.dataBuffer,
            0,
            this.ringBuffer.data.buffer,
            this.ringBuffer.data.byteOffset,
            this.ringBuffer.data.byteLength
        );

        // 3. Command Encoder & Render Pass
        const commandEncoder = this.device.createCommandEncoder();
        const view = this.context.getCurrentTexture().createView();

        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view,
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });

        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, this.bindGroup); // WICHTIG: Verbindet Daten mit Shader
        renderPass.draw(this.ringBuffer.data.length); // Zeichnet alle Punkte im Ring [cite: 14]

        renderPass.end();
        this.device.queue.submit([commandEncoder.finish()]);
    }
}