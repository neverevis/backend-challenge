/**
 * Taxonomia de códigos de falha (README 7.2). Estáveis e legíveis por máquina.
 * A coluna "o provedor deve" está documentada no ARCHITECTURE.md.
 */
export enum FailureCode {
  // ---- saldo
  /** BET sem saldo suficiente. Reenviar não adianta. */
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  /** ROLLBACK/REFUND que deixaria o saldo negativo (ex.: rollback de um WIN já gasto). */
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",

  // ---- consistência com a wallet
  WalletNotFound = "WALLET_NOT_FOUND",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  CurrencyMismatch = "CURRENCY_MISMATCH",

  // ---- referência (REFUND, ROLLBACK, e WIN/LOSS quando informada)
  /** A referência não chegou dentro do limite de tentativas. */
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  /** Referência de outro player, wallet, moeda ou rodada. */
  ReferenceMismatch = "REFERENCE_MISMATCH",
  /** Ex.: REFUND referenciando um WIN. */
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  /** A referência existe mas foi REJECTED/FAILED: não há o que reverter. */
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  /** Reversão parcial não é suportada: o valor deve ser igual ao da referência. */
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  /** A referência já foi revertida. */
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",

  // ---- FAILED (erro permanente de infraestrutura / mensagem inválida)
  MalformedMessage = "MALFORMED_MESSAGE",
  ProcessingFailed = "PROCESSING_FAILED",
}
