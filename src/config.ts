/** Configuração lida das variáveis de ambiente, com defaults para o docker-compose local. */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  database: {
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? "wagering",
    password: process.env.DB_PASSWORD ?? "wagering",
    name: process.env.DB_NAME ?? "wagering",
  },
  sqs: {
    endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    region: process.env.AWS_REGION ?? "us-east-1",
    queueName: process.env.SQS_QUEUE_NAME ?? "wager-transactions.fifo",
    dlqName: process.env.SQS_DLQ_NAME ?? "wager-transactions-dlq.fifo",
  },
} as const;
