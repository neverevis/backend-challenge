import { MikroORM } from "@mikro-orm/postgresql";
import mikroOrmConfig from "./mikro-orm.config";

/**
 * Uso:
 *   bun run db:migrate         aplica todas as pendentes
 *   bun run db:rollback        desfaz a última
 */
const command = process.argv[2] ?? "up";

const orm = await MikroORM.init(mikroOrmConfig);
const migrator = orm.getMigrator();
try {
  if (command === "up") {
    const applied = await migrator.up();
    console.log(JSON.stringify({ level: "info", msg: "migrations applied", migrations: applied.map((m) => m.name) }));
  } else if (command === "down") {
    const reverted = await migrator.down();
    console.log(JSON.stringify({ level: "info", msg: "migration reverted", migrations: reverted.map((m) => m.name) }));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} finally {
  await orm.close();
}
