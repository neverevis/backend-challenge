import { IsolationLevel } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { type Repositories, type UnitOfWork } from "../../application/ports/repositories";
import { config } from "../../config";
import { translateDbError } from "./pg-errors";
import { pgRepositories } from "./pg-repositories";

/**
 * Cada chamada abre um EntityManager novo (fork) e uma transação SQL.
 * READ COMMITTED é suficiente para escrita porque a serialização por wallet
 * vem do SELECT ... FOR UPDATE: depois de obter o lock, cada SELECT enxerga
 * tudo que já foi confirmado por quem segurava o lock antes.
 */
export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          // Não espera indefinidamente por uma hot wallet: falha rápido como transitório.
          await em.execute(`SET LOCAL lock_timeout = '${Math.trunc(config.database.lockTimeoutMs)}ms'`);
          return fn(pgRepositories(em));
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (e) {
      throw translateDbError(e);
    }
  }

  async read<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          await em.execute("SET TRANSACTION READ ONLY");
          return fn(pgRepositories(em));
        },
        { isolationLevel: IsolationLevel.REPEATABLE_READ },
      );
    } catch (e) {
      throw translateDbError(e);
    }
  }
}
