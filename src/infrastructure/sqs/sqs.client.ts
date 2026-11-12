import { SQSClient } from "@aws-sdk/client-sqs";
import { config } from "../../config";

export const SQS_CLIENT = Symbol("SQS_CLIENT");

export function createSqsClient(): SQSClient {
  return new SQSClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    // LocalStack aceita qualquer credencial.
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });
}
