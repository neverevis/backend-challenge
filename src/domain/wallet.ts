import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletError } from "./errors";
import { Money } from "./money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  money: Money;
  transactionId: string;
  /** id do lançamento que será criado */
  entryId: string;
  at: Date;
}

/**
 * Aggregate root da carteira.
 *
 * Única forma de mudar o saldo é `debit`/`credit`, e ambas devolvem o
 * lançamento correspondente: saldo e ledger não podem divergir.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a carteira com `version = 1`. Se o saldo inicial for positivo, devolve
   * também o lançamento de abertura (transação interna OPENING).
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId: string;
    openingEntryId: string;
    at: Date;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError("Initial balance cannot be negative");
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
    if (props.initialBalance.isZero()) return { wallet };

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(currency),
      balanceAfter: props.initialBalance,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.currency, s.balance, s.version, s.createdAt, s.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(`Cannot debit ${props.money} from balance ${this._balance}`);
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, props);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private apply(direction: LedgerDirection, p: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(p.money);
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(p.money) : before.subtract(p.money);

    // create() valida valor positivo, saldo não negativo e aritmética.
    const entry = WalletLedgerEntry.create({
      id: p.entryId,
      walletId: this.id,
      transactionId: p.transactionId,
      direction,
      money: p.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: p.at,
    });

    this._balance = after;
    this._version += 1; // só incrementa quando o saldo muda
    this._updatedAt = p.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
