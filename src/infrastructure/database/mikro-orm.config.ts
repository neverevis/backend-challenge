import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { config } from "../../config";
import { migrationsList } from "./migrations";

/**
 * MikroORM é usado para: pool de conexões, EntityManager.transactional()
 * (unidade de trabalho / transação SQL) e migrations versionadas e reversíveis.
 *
 * Os repositórios escrevem SQL explícito em vez de entidades decoradas:
 * o domínio fica livre de decorators de ORM, e os pontos críticos
 * (SELECT ... FOR UPDATE, UPDATE condicionado por versão) ficam visíveis.
 * Justificativa completa no ARCHITECTURE.md.
 */
export default defineConfig({
  host: config.database.host,
  port: config.database.port,
  user: config.database.user,
  password: config.database.password,
  dbName: config.database.name,
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    migrationsList,
    transactional: true,
    allOrNothing: true,
    snapshot: false,
  },
  pool: { min: 2, max: config.database.poolMax },
  debug: false,
});
