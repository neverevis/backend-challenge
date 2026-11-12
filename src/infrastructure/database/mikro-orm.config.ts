import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { config } from "../../config";

export default defineConfig({
  host: config.database.host,
  port: config.database.port,
  user: config.database.user,
  password: config.database.password,
  dbName: config.database.name,
  // As entidades de persistência entram aqui nas próximas etapas.
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    path: "src/infrastructure/database/migrations",
    transactional: true,
  },
  pool: { min: 2, max: 20 },
  debug: false,
});
