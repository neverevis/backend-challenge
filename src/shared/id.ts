/**
 * Gera UUID v7: ordenado por tempo, o que mantém os índices B-tree do Postgres
 * compactos (inserções sempre no fim do índice, ao contrário do v4 aleatório).
 */
export function newId(): string {
  return Bun.randomUUIDv7();
}
