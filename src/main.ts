import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { config } from "./config";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Em SIGTERM o Nest chama os hooks onModuleDestroy/beforeApplicationShutdown,
  // onde os workers vão terminar o que estiverem fazendo.
  app.enableShutdownHooks();
  await app.listen(config.port);
  console.log(JSON.stringify({ level: "info", msg: "server started", port: config.port }));
}

bootstrap();
