import { ValidationError } from "../../application/errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Evita mandar texto arbitrário para uma coluna uuid (o Postgres responderia 500). */
export function assertUuid(value: string, field = "id"): string {
  if (!UUID.test(value)) throw new ValidationError([{ field, message: "must be a UUID" }]);
  return value.toLowerCase();
}
