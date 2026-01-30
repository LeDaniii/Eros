import * as http from "node:http";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { create } from "@bufbuild/protobuf";
import { MeasurementService, MeasurementBatchSchema } from "./gen/measurements_pb.js";

const routes = (router) => {
    router.service(MeasurementService, {
        streamMeasurements: async function* streamMeasurements(request) {
            let sampleIndex = 0;
            const sampleRate = 10_000;

            while (true) {
                const values = [];
                for (let sampleValueIndex = 0; sampleValueIndex < 100; sampleValueIndex++) {
                    const timeSeconds = sampleIndex / sampleRate;
                    values.push(0.9 * Math.sin(2 * Math.PI * 3.0 * timeSeconds));
                    sampleIndex++;
                }

                yield create(MeasurementBatchSchema, {
                    values,
                    timestampStart: BigInt(Date.now()),
                });

                await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
            }
        },
    });
};

const handler = connectNodeAdapter({ routes });

const allowedOrigin = "https://localhost:5173";
const allowedHeaders =
    "Content-Type, Connect-Protocol-Version, Connect-Timeout-Ms, Grpc-Timeout, Authorization";

http
    .createServer((request, response) => {
        response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
        response.setHeader("Vary", "Origin");
        response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", allowedHeaders);

        if (request.method === "OPTIONS") {
            response.statusCode = 204;
            response.end();
            return;
        }

        handler(request, response);
    })
    .listen(50051, () => {
        console.log("Server läuft auf http://localhost:50051");
    });
