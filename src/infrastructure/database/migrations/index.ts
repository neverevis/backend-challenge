import { Migration20261112000001_initial } from "./Migration20261112000001_initial";

/**
 * Lista explícita de migrations, em ordem. Evita depender de glob no
 * filesystem (que se comporta diferente entre Bun e Node).
 */
export const migrationsList = [
  { name: "Migration20261112000001_initial", class: Migration20261112000001_initial },
];
