import * as http from "node:http";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { create } from "@bufbuild/protobuf";
import { MeasurementService, MeasurementBatchSchema } from "./gen/measurements_pb.js";

// ========================
// Kurven-Generator (aus dem File-Script kopiert)
// ========================

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

class CurveGenerator {
    constructor(durationSeconds, sampleRateHz = 10_000, seed = 123456789) {
        this.sampleRateHz = sampleRateHz;
        this.durationSeconds = durationSeconds;
        this.sampleIntervalSeconds = 1 / sampleRateHz;
        this.totalSamples = Math.floor(sampleRateHz * durationSeconds);

        this.randomNumberFunction = createMulberry32Random(seed);

        // Curve parameters (same as file generator)
        this.lowFrequencyHertz = 3.0;
        this.midFrequencyHertz = 120.0;
        this.highFrequencyHertz = 900.0;
        this.chirpStartHertz = 20.0;
        this.chirpEndHertz = 2500.0;
        this.driftAmplitude = 0.15;
        this.noiseStandardDeviation = 0.03;
        this.stepStartTimeSeconds = durationSeconds * 0.35;
        this.stepSecondTimeSeconds = durationSeconds * 0.62;

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
            0.9 * Math.sin(2 * Math.PI * this.lowFrequencyHertz * timeSeconds) +
            0.25 * Math.sin(2 * Math.PI * this.midFrequencyHertz * timeSeconds) +
            0.08 * Math.sin(2 * Math.PI * this.highFrequencyHertz * timeSeconds);

        // Chirp
        const chirpProgress = timeSeconds / this.durationSeconds;
        const chirpFrequencyHertz = this.chirpStartHertz +
            (this.chirpEndHertz - this.chirpStartHertz) * chirpProgress;
        const chirpSignal = 0.18 * Math.sin(2 * Math.PI * chirpFrequencyHertz * timeSeconds);

        // Drift
        const driftSignal = this.driftAmplitude * (chirpProgress - 0.5);

        // Steps
        let stepSignal = 0;
        if (timeSeconds >= this.stepStartTimeSeconds) stepSignal += 0.35;
        if (timeSeconds >= this.stepSecondTimeSeconds) stepSignal -= 0.55;

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

// ========================
// gRPC Routes
// ========================

const routes = (router) => {
    router.service(MeasurementService, {
        streamMeasurements: async function* streamMeasurements(request) {
            if (!currentGenerator) {
                console.log("Creating new curve generator...");
                currentGenerator = new CurveGenerator(
                    streamConfig.durationSeconds,
                    streamConfig.sampleRateHz
                );
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
    });
};

// ========================
// HTTP Server with REST API
// ========================

const handler = connectNodeAdapter({ routes });

const allowedOrigins = [
    "https://localhost:5173",
    "http://localhost:5173",
];

const allowedHeaders =
    "Content-Type, Connect-Protocol-Version, Connect-Timeout-Ms, Grpc-Timeout, Authorization";

http.createServer((request, response) => {
    const origin = request.headers.origin || "";

    // Erlaubt alle localhost Origins
    if (allowedOrigins.includes(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
    } else {
        response.setHeader("Access-Control-Allow-Origin", allowedOrigins[0]);
    }

    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", allowedHeaders);

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
        }));
        return;
    }

    // gRPC handler
    handler(request, response);
}).listen(50051, () => {
    console.log("Server läuft auf http://localhost:50051");
    console.log("REST API: POST /api/configure, GET /api/status");
});