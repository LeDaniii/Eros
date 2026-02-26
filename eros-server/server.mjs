import * as http from "node:http";
import { once } from "node:events";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { create } from "@bufbuild/protobuf";
import {
    MeasurementService,
    MeasurementBatchSchema,
    BooleanStatusTickSchema,
} from "./gen/measurements_pb.js";
import { createReadStream, statSync } from "node:fs";

// ========================
// Kurven-Generator (aus dem File-Script kopiert)
// ========================

const EROS_BINARY_MAGIC = new Uint8Array([0x45, 0x52, 0x4f, 0x53]); // "EROS"
const EROS_BINARY_VERSION = 1;
const EROS_BINARY_HEADER_SIZE = 20;
const EROS_BINARY_MAX_SAMPLE_COUNT = 0xffffffff;
const EROS_BINARY_MAX_FILE_SIZE_BYTES = EROS_BINARY_HEADER_SIZE + EROS_BINARY_MAX_SAMPLE_COUNT * 4;
const DEMO_BINARY_PATTERN_SAMPLE_COUNT = 262_144; // 1 MiB float payload chunk

function createMulberry32Random(seedNumber) {
    let internalState = seedNumber >>> 0;
    return function nextRandomNumber() {
        internalState = (internalState + 0x6D2B79F5) >>> 0;
        let tempValue = Math.imul(internalState ^ (internalState >>> 15), 1 | internalState);
        tempValue = (tempValue + Math.imul(tempValue ^ (tempValue >>> 7), 61 | tempValue)) ^ tempValue;
        return ((tempValue ^ (tempValue >>> 14)) >>> 0) / 4294967296;
    };
}

function gaussianNoise(randomNumberFunction) {
    let firstUniform = 0;
    let secondUniform = 0;
    while (firstUniform === 0) firstUniform = randomNumberFunction();
    while (secondUniform === 0) secondUniform = randomNumberFunction();
    const magnitude = Math.sqrt(-2.0 * Math.log(firstUniform));
    const angle = 2.0 * Math.PI * secondUniform;
    return magnitude * Math.cos(angle);
}

function clampNumber(value, minimumValue, maximumValue) {
    return Math.max(minimumValue, Math.min(maximumValue, value));
}

function randomRange(randomNumberFunction, minimumValue, maximumValue) {
    return minimumValue + (maximumValue - minimumValue) * randomNumberFunction();
}

function createStreamSeed() {
    // Generate a different 32-bit seed per stream while keeping the same signal model.
    return ((Date.now() & 0xffffffff) ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

class CurveGenerator {
    constructor(durationSeconds, sampleRateHz = 10_000, seed = 123456789) {
        this.sampleRateHz = sampleRateHz;
        this.durationSeconds = durationSeconds;
        this.sampleIntervalSeconds = 1 / sampleRateHz;
        this.totalSamples = Math.floor(sampleRateHz * durationSeconds);

        this.randomNumberFunction = createMulberry32Random(seed);

        // Per-stream randomized parameters so long-duration curves differ in macro shape too.
        this.lowFrequencyHertz = randomRange(this.randomNumberFunction, 2.2, 4.8);
        this.midFrequencyHertz = randomRange(this.randomNumberFunction, 80.0, 180.0);
        this.highFrequencyHertz = randomRange(this.randomNumberFunction, 650.0, 1300.0);
        this.lowFrequencyAmplitude = randomRange(this.randomNumberFunction, 0.7, 1.05);
        this.midFrequencyAmplitude = randomRange(this.randomNumberFunction, 0.15, 0.32);
        this.highFrequencyAmplitude = randomRange(this.randomNumberFunction, 0.04, 0.12);
        this.lowFrequencyPhaseRadians = randomRange(this.randomNumberFunction, 0, 2 * Math.PI);
        this.midFrequencyPhaseRadians = randomRange(this.randomNumberFunction, 0, 2 * Math.PI);
        this.highFrequencyPhaseRadians = randomRange(this.randomNumberFunction, 0, 2 * Math.PI);

        this.chirpStartHertz = randomRange(this.randomNumberFunction, 10.0, 50.0);
        this.chirpEndHertz = randomRange(this.randomNumberFunction, 1800.0, 3200.0);
        this.chirpAmplitude = randomRange(this.randomNumberFunction, 0.10, 0.24);
        this.chirpPhaseRadians = randomRange(this.randomNumberFunction, 0, 2 * Math.PI);

        const driftSign = this.randomNumberFunction() < 0.5 ? -1 : 1;
        this.driftAmplitude = randomRange(this.randomNumberFunction, 0.08, 0.22) * driftSign;
        this.noiseStandardDeviation = randomRange(this.randomNumberFunction, 0.02, 0.05);

        this.stepStartTimeSeconds = durationSeconds * randomRange(this.randomNumberFunction, 0.24, 0.42);
        this.stepSecondTimeSeconds = durationSeconds * randomRange(this.randomNumberFunction, 0.54, 0.80);
        if (this.stepSecondTimeSeconds <= this.stepStartTimeSeconds + 0.05) {
            this.stepSecondTimeSeconds = Math.min(durationSeconds * 0.95, this.stepStartTimeSeconds + 0.05);
        }
        this.stepFirstAmplitude = randomRange(this.randomNumberFunction, 0.22, 0.45);
        this.stepSecondAmplitude = -randomRange(this.randomNumberFunction, 0.35, 0.70);

        // Pre-generate spike times
        const spikeCount = Math.max(5, Math.floor(durationSeconds * 2));
        this.spikeTimesSeconds = [];
        for (let i = 0; i < spikeCount; i++) {
            this.spikeTimesSeconds.push(this.randomNumberFunction() * durationSeconds);
        }
        this.spikeTimesSeconds.sort((a, b) => a - b);
        this.spikePointerIndex = 0;

        // Pre-generate bursts
        const burstCount = Math.max(2, Math.floor(durationSeconds / 8));
        this.burstDefinitions = [];
        for (let i = 0; i < burstCount; i++) {
            const burstStartSeconds = this.randomNumberFunction() * durationSeconds;
            const burstDurationSeconds = 0.05 + this.randomNumberFunction() * 0.2;
            const burstFrequencyHertz = 800 + this.randomNumberFunction() * 3000;
            const burstAmplitude = 0.10 + this.randomNumberFunction() * 0.25;
            this.burstDefinitions.push({
                burstStartSeconds,
                burstEndSeconds: burstStartSeconds + burstDurationSeconds,
                burstFrequencyHertz,
                burstAmplitude,
            });
        }
    }

    getSampleAtIndex(sampleIndex) {
        const timeSeconds = sampleIndex * this.sampleIntervalSeconds;

        // Baseline (multi-frequency sine)
        const baseline =
            this.lowFrequencyAmplitude *
            Math.sin(2 * Math.PI * this.lowFrequencyHertz * timeSeconds + this.lowFrequencyPhaseRadians) +
            this.midFrequencyAmplitude *
            Math.sin(2 * Math.PI * this.midFrequencyHertz * timeSeconds + this.midFrequencyPhaseRadians) +
            this.highFrequencyAmplitude *
            Math.sin(2 * Math.PI * this.highFrequencyHertz * timeSeconds + this.highFrequencyPhaseRadians);

        // Chirp
        const chirpProgress = timeSeconds / this.durationSeconds;
        const chirpFrequencyHertz = this.chirpStartHertz +
            (this.chirpEndHertz - this.chirpStartHertz) * chirpProgress;
        const chirpSignal = this.chirpAmplitude *
            Math.sin(2 * Math.PI * chirpFrequencyHertz * timeSeconds + this.chirpPhaseRadians);

        // Drift
        const driftSignal = this.driftAmplitude * (chirpProgress - 0.5);

        // Steps
        let stepSignal = 0;
        if (timeSeconds >= this.stepStartTimeSeconds) stepSignal += this.stepFirstAmplitude;
        if (timeSeconds >= this.stepSecondTimeSeconds) stepSignal += this.stepSecondAmplitude;

        // Bursts
        let burstSignal = 0;
        for (const burst of this.burstDefinitions) {
            if (timeSeconds >= burst.burstStartSeconds && timeSeconds <= burst.burstEndSeconds) {
                const burstTimeSeconds = timeSeconds - burst.burstStartSeconds;
                const fadeProgress = (timeSeconds - burst.burstStartSeconds) /
                    (burst.burstEndSeconds - burst.burstStartSeconds);
                const fadeWindow = Math.sin(Math.PI * clampNumber(fadeProgress, 0, 1));
                burstSignal += burst.burstAmplitude * fadeWindow *
                    Math.sin(2 * Math.PI * burst.burstFrequencyHertz * burstTimeSeconds);
            }
        }

        // Spikes
        let spikeSignal = 0;
        while (this.spikePointerIndex < this.spikeTimesSeconds.length &&
            this.spikeTimesSeconds[this.spikePointerIndex] < timeSeconds) {
            const spikeTimeSeconds = this.spikeTimesSeconds[this.spikePointerIndex];
            const timeDifferenceSeconds = timeSeconds - spikeTimeSeconds;

            if (timeDifferenceSeconds >= 0 && timeDifferenceSeconds < 0.002) {
                const spikeAmplitude = 1.2 + this.randomNumberFunction() * 1.8;
                const impulse = Math.exp(-timeDifferenceSeconds * 2200) * spikeAmplitude;
                const ringing = 0.15 * Math.sin(2 * Math.PI *
                    (2000 + this.randomNumberFunction() * 4000) * timeDifferenceSeconds);
                spikeSignal += impulse + ringing;
            } else {
                this.spikePointerIndex++;
            }
            break;
        }

        // Noise
        const noiseSignal = this.noiseStandardDeviation * gaussianNoise(this.randomNumberFunction);

        const combinedValue = baseline + chirpSignal + driftSignal +
            stepSignal + burstSignal + spikeSignal + noiseSignal;

        return clampNumber(combinedValue, -2.5, 2.5);
    }
}

// ========================
// Stream State Management
// ========================

let currentGenerator = null;
let streamConfig = {
    durationSeconds: 30,
    sampleRateHz: 10_000,
    isStreaming: false,
};

let booleanStatusStream = {
    currentValue: false,
    timestamp: BigInt(Date.now()),
    sequence: 0,
    listeners: new Set(),
    intervalHandle: null,
};

function publishBooleanStatusTick(nextValue) {
    booleanStatusStream.currentValue = nextValue;
    booleanStatusStream.timestamp = BigInt(Date.now());
    booleanStatusStream.sequence += 1;

    for (const listener of booleanStatusStream.listeners) {
        listener();
    }
}

function waitForNextBooleanStatusTick(lastSequence, abortSignal) {
    if (booleanStatusStream.sequence > lastSequence) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const onTick = () => {
            cleanup();
            resolve();
        };

        const onAbort = () => {
            cleanup();
            resolve();
        };

        const cleanup = () => {
            booleanStatusStream.listeners.delete(onTick);
            abortSignal?.removeEventListener?.("abort", onAbort);
        };

        booleanStatusStream.listeners.add(onTick);
        abortSignal?.addEventListener?.("abort", onAbort, { once: true });
    });
}

function startBooleanStatusTicker() {
    if (booleanStatusStream.intervalHandle) return;

    const emitTick = () => {
        const nextValue = Math.random() >= 0.5;
        publishBooleanStatusTick(nextValue);
        console.log(`[Bool-Stream] Tick: ${nextValue ? 1 : 0}`);
    };

    emitTick();
    booleanStatusStream.intervalHandle = setInterval(emitTick, 1000);
    console.log("Bool-Status-Ticker gestartet (1x pro Sekunde).");
}

// ========================
// gRPC Routes
// ========================

const routes = (router) => {
    router.service(MeasurementService, {
        streamMeasurements: async function* streamMeasurements(request) {
            if (!currentGenerator) {
                const streamSeed = createStreamSeed();
                console.log("Creating new curve generator...");
                currentGenerator = new CurveGenerator(
                    streamConfig.durationSeconds,
                    streamConfig.sampleRateHz,
                    streamSeed
                );
                console.log(`Using stream seed: ${streamSeed}`);
            }

            streamConfig.isStreaming = true;
            let sampleIndex = 0;
            const batchSize = 100;
            const maxSamples = currentGenerator.totalSamples;

            console.log(`Starting stream: ${streamConfig.durationSeconds}s @ ${streamConfig.sampleRateHz} Hz`);

            while (sampleIndex < maxSamples) {
                const values = [];

                for (let i = 0; i < batchSize && sampleIndex < maxSamples; i++) {
                    values.push(currentGenerator.getSampleAtIndex(sampleIndex));
                    sampleIndex++;
                }

                yield create(MeasurementBatchSchema, {
                    values,
                    timestampStart: BigInt(Date.now()),
                });

                // Simulate real-time streaming (10ms = 100 samples at 10kHz)
                await new Promise((resolve) => setTimeout(resolve, 10));
            }

            console.log("Stream completed.");
            streamConfig.isStreaming = false;
            currentGenerator = null;
        },
        streamBooleanStatus: async function* streamBooleanStatus(_request, context) {
            console.log("Boolean status stream client connected.");
            let lastSequence = 0;

            try {
                while (!context?.signal?.aborted) {
                    await waitForNextBooleanStatusTick(lastSequence, context?.signal);

                    if (context?.signal?.aborted) {
                        break;
                    }

                    if (booleanStatusStream.sequence <= lastSequence) {
                        continue;
                    }

                    lastSequence = booleanStatusStream.sequence;
                    yield create(BooleanStatusTickSchema, {
                        value: booleanStatusStream.currentValue,
                        timestamp: booleanStatusStream.timestamp,
                    });
                }
            } finally {
                console.log("Boolean status stream client disconnected.");
            }
        },
    });
};

// ========================
// HTTP Server with REST API
// ========================

const handler = connectNodeAdapter({ routes });

const allowedOrigins = [
    "https://localhost:5173",
    "http://localhost:5173"
];

const allowedHeaders =
    "Content-Type, Connect-Protocol-Version, Connect-Timeout-Ms, Grpc-Timeout, Authorization";
const exposedHeaders = "Content-Length, Content-Disposition, X-File-Name";

function isLanOrLocalhostOrigin(origin) {
    if (!origin) return false;

    try {
        const parsedOrigin = new URL(origin);
        const hostname = parsedOrigin.hostname;

        if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
            return true;
        }

        if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return true;
        if (/^192\.168\.\d+\.\d+$/.test(hostname)) return true;

        const private172 = hostname.match(/^172\.(\d+)\.\d+\.\d+$/);
        if (private172) {
            const secondOctet = Number(private172[1]);
            return secondOctet >= 16 && secondOctet <= 31;
        }

        return false;
    } catch {
        return false;
    }
}

function parsePositiveNumber(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
}

function parseDemoBinaryRequestParams(requestUrl, fallbackSampleRateHz = 10_000) {
    const url = new URL(requestUrl ?? "/", "http://localhost");
    const sizeParam = url.searchParams.get("size");
    const sizeBytesParam = url.searchParams.get("sizeBytes");
    const unitParam = (url.searchParams.get("unit") ?? "gb").toLowerCase();

    const unitMultipliers = {
        b: 1,
        byte: 1,
        bytes: 1,
        kb: 1024,
        mb: 1024 ** 2,
        gb: 1024 ** 3,
    };

    let requestedBytes = null;

    if (sizeBytesParam !== null) {
        requestedBytes = Math.floor(parsePositiveNumber(sizeBytesParam) ?? NaN);
    } else {
        const sizeValue = parsePositiveNumber(sizeParam ?? "2");
        const multiplier = unitMultipliers[unitParam];
        if (sizeValue !== null && multiplier) {
            requestedBytes = Math.floor(sizeValue * multiplier);
        }
    }

    if (!Number.isFinite(requestedBytes) || requestedBytes === null) {
        throw new Error("Ungültige Zielgröße. Verwende z.B. ?size=2&unit=gb");
    }

    if (requestedBytes < EROS_BINARY_HEADER_SIZE + 4) {
        throw new Error(`Zielgröße zu klein (mindestens ${EROS_BINARY_HEADER_SIZE + 4} Bytes).`);
    }

    if (requestedBytes > EROS_BINARY_MAX_FILE_SIZE_BYTES) {
        throw new Error(`Zielgröße zu groß (max ${EROS_BINARY_MAX_FILE_SIZE_BYTES} Bytes).`);
    }

    const requestedSampleRate = Math.floor(
        parsePositiveNumber(url.searchParams.get("sampleRateHz")) ?? fallbackSampleRateHz
    );
    const sampleRateHz = Math.max(1, Math.min(requestedSampleRate, 2_000_000_000));

    const sampleCount = Math.floor((requestedBytes - EROS_BINARY_HEADER_SIZE) / 4);
    const actualBytes = EROS_BINARY_HEADER_SIZE + sampleCount * 4;
    const durationSeconds = sampleCount / sampleRateHz;

    return {
        requestedBytes,
        actualBytes,
        sampleCount,
        sampleRateHz,
        durationSeconds,
        unitParam,
    };
}

function createErosBinaryHeaderBuffer(sampleRateHz, sampleCount) {
    const headerBuffer = Buffer.alloc(EROS_BINARY_HEADER_SIZE);
    headerBuffer.set(EROS_BINARY_MAGIC, 0);
    headerBuffer.writeUInt16LE(EROS_BINARY_VERSION, 4);
    headerBuffer.writeUInt16LE(0, 6); // flags/reserved
    headerBuffer.writeUInt32LE(sampleRateHz >>> 0, 8);
    headerBuffer.writeUInt32LE(sampleCount >>> 0, 12);
    headerBuffer.writeUInt32LE(0, 16); // reserved
    return headerBuffer;
}

function createDemoBinaryPatternBuffer(sampleRateHz) {
    const sampleCount = DEMO_BINARY_PATTERN_SAMPLE_COUNT;
    const payloadBuffer = new ArrayBuffer(sampleCount * 4);
    const view = new DataView(payloadBuffer);
    const twoPi = Math.PI * 2;
    const effectiveSampleRateHz = Math.max(1, sampleRateHz);
    let lcgState = 0xA5F153C1;

    for (let i = 0; i < sampleCount; i++) {
        lcgState = (Math.imul(lcgState, 1664525) + 1013904223) >>> 0;
        const noise = ((lcgState & 0xffff) / 0xffff) * 2 - 1;
        const t = i / effectiveSampleRateHz;

        let value =
            0.92 * Math.sin(twoPi * 3.2 * t) +
            0.18 * Math.sin(twoPi * 117 * t + 0.31) +
            0.06 * Math.sin(twoPi * 1410 * t + 1.17) +
            0.025 * noise;

        // Short periodic pulses so overlays/zooming still show visible events.
        const pulsePosition = i % 8192;
        if (pulsePosition < 12) {
            value += (12 - pulsePosition) * 0.12;
        }

        view.setFloat32(i * 4, clampNumber(value, -2.5, 2.5), true);
    }

    return Buffer.from(payloadBuffer);
}

async function writeChunkWithBackpressure(response, chunkBuffer) {
    if (response.destroyed || response.writableEnded) {
        return false;
    }

    if (response.write(chunkBuffer)) {
        return true;
    }

    await Promise.race([
        once(response, "drain"),
        once(response, "close"),
    ]);

    return !(response.destroyed || response.writableEnded);
}

async function streamDemoBinaryFile(response, options) {
    const { sampleRateHz, sampleCount, actualBytes } = options;
    const headerBuffer = createErosBinaryHeaderBuffer(sampleRateHz, sampleCount);
    const payloadPatternBuffer = createDemoBinaryPatternBuffer(sampleRateHz);
    const payloadPatternSampleCount = payloadPatternBuffer.byteLength / 4;

    response.statusCode = 200;
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Length", String(actualBytes));
    response.setHeader("Cache-Control", "no-store");

    const fileName =
        `eros-demo-${Math.round(actualBytes / (1024 * 1024))}MiB-${sampleRateHz}Hz.erosb`;
    response.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    response.setHeader("X-File-Name", fileName);

    let writeOk = await writeChunkWithBackpressure(response, headerBuffer);
    if (!writeOk) {
        return;
    }

    let remainingSamples = sampleCount;
    while (remainingSamples > 0) {
        const chunkSamples = Math.min(remainingSamples, payloadPatternSampleCount);
        const chunkBytes = chunkSamples * 4;
        const chunkBuffer = chunkSamples === payloadPatternSampleCount
            ? payloadPatternBuffer
            : payloadPatternBuffer.subarray(0, chunkBytes);

        writeOk = await writeChunkWithBackpressure(response, chunkBuffer);
        if (!writeOk) {
            return;
        }

        remainingSamples -= chunkSamples;
    }

    response.end();
}

startBooleanStatusTicker();

http.createServer((request, response) => {
    const origin = request.headers.origin || "";

    // Erlaubt localhost und private LAN-IPs fuer Browser im lokalen Netz
    if (allowedOrigins.includes(origin) || isLanOrLocalhostOrigin(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
    } else {
        response.setHeader("Access-Control-Allow-Origin", allowedOrigins[0]);
    }

    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", allowedHeaders);
    response.setHeader("Access-Control-Expose-Headers", exposedHeaders);

    if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
    }

    // REST API for configuration
    if (request.method === "POST" && request.url === "/api/configure") {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
            try {
                const config = JSON.parse(body);

                if (config.durationSeconds !== undefined) {
                    streamConfig.durationSeconds = Number(config.durationSeconds);
                }
                if (config.sampleRateHz !== undefined) {
                    streamConfig.sampleRateHz = Number(config.sampleRateHz);
                }

                // Reset generator with new config
                currentGenerator = null;

                response.statusCode = 200;
                response.setHeader("Content-Type", "application/json");
                response.end(JSON.stringify({
                    success: true,
                    config: streamConfig,
                }));
            } catch (error) {
                response.statusCode = 400;
                response.end(JSON.stringify({ error: error.message }));
            }
        });
        return;
    }

    if (request.method === "GET" && request.url === "/api/status") {
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
            isStreaming: streamConfig.isStreaming,
            config: streamConfig,
            booleanStatus: {
                running: Boolean(booleanStatusStream.intervalHandle),
                currentValue: booleanStatusStream.currentValue,
                sequence: booleanStatusStream.sequence,
            },
        }));
        return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/generate-demo-binary")) {
        let requestOptions;

        try {
            requestOptions = parseDemoBinaryRequestParams(request.url, streamConfig.sampleRateHz);
        } catch (error) {
            response.statusCode = 400;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
            }));
            return;
        }

        console.log(
            `[DemoBinary] Streaming ${requestOptions.actualBytes} bytes ` +
            `(${requestOptions.sampleCount} samples @ ${requestOptions.sampleRateHz} Hz, ` +
            `${requestOptions.durationSeconds.toFixed(2)} s)`
        );

        void streamDemoBinaryFile(response, requestOptions).catch((error) => {
            console.error("[DemoBinary] Stream failed:", error);
            if (!response.headersSent) {
                response.statusCode = 500;
                response.setHeader("Content-Type", "application/json");
                response.end(JSON.stringify({ error: "Demo-Binary-Generierung fehlgeschlagen." }));
                return;
            }

            if (!response.writableEnded) {
                response.destroy(error);
            }
        });

        return;
    }

    if (request.method === "GET" && request.url === "/api/download") {
        const filePath = "C:\\Users\\dmatzer\\Downloads\\eros-curve-2026-02-23T22-02-18-167Z.erosb";
        const stats = statSync(filePath);

        response.statusCode = 200;
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader("Content-Length", String(stats.size));
        response.setHeader("Content-Disposition", 'attachment; filename="eros-curve.erosb"');
        response.setHeader("X-File-Name", "eros-curve.erosb");

        createReadStream(filePath).pipe(response);
        return;
    }

    // gRPC handler
    handler(request, response);
}).listen(50051, "0.0.0.0", () => {
    console.log("Server läuft auf http://localhost:50051");
    console.log("REST API: POST /api/configure, GET /api/status");
    console.log("RPC: StreamMeasurements, StreamBooleanStatus");
});
