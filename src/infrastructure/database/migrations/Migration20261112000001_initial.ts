import { Migration } from "@mikro-orm/migrations";

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade
 * vivem aqui (README seção 5, item 9) — o código de aplicação é a primeira
 * linha de defesa, o banco é a última.
 */
export class Migration20261112000001_initial extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      CREATE TABLE wallets (
        id              uuid           PRIMARY KEY,
        player_id       uuid           NOT NULL,
        currency        char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance_amount  numeric(20, 2) NOT NULL CHECK (balance_amount >= 0),
        version         integer        NOT NULL CHECK (version >= 1),
        created_at      timestamptz    NOT NULL,
        updated_at      timestamptz    NOT NULL,
        CONSTRAINT wallets_player_currency_key UNIQUE (player_id, currency)
      );
    `);

    // ------------------------------------------------------ wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid           PRIMARY KEY,
        provider_id                        text           NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
        external_transaction_id            text           NOT NULL CHECK (length(external_transaction_id) BETWEEN 1 AND 128),
        idempotency_key                    text           NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
        payload_hash                       char(64)       NOT NULL,
        wallet_id                          uuid           NOT NULL REFERENCES wallets (id),
        player_id                          uuid           NOT NULL,
        round_id                           text           NOT NULL,
        game_id                            text           NOT NULL,
        kind                               text           NOT NULL
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                             numeric(20, 2) NOT NULL CHECK (amount > 0),
        currency                           char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id  text,
        reference_transaction_id           uuid           REFERENCES wager_transactions (id),
        status                             text           NOT NULL
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                       text,
        result_balance_amount              numeric(20, 2) CHECK (result_balance_amount >= 0),
        reference_attempts                 integer        NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_reference_check_at            timestamptz,
        created_at                         timestamptz    NOT NULL,
        processed_at                       timestamptz,
        updated_at                         timestamptz    NOT NULL,

        -- Idempotência persistente: a chave é a fonte da verdade, por provider.
        CONSTRAINT wager_tx_idempotency_key UNIQUE (provider_id, idempotency_key),
        -- Referências são resolvidas por (provider, externalId): precisa ser único.
        CONSTRAINT wager_tx_external_id_key UNIQUE (provider_id, external_transaction_id),

        CONSTRAINT wager_tx_reversal_requires_reference CHECK (
          kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL
        ),
        CONSTRAINT wager_tx_failure_code_iff_rejected_or_failed CHECK (
          (status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)
        ),
        CONSTRAINT wager_tx_processed_has_timestamp CHECK (
          (status = 'PROCESSED') = (processed_at IS NOT NULL)
        ),
        CONSTRAINT wager_tx_pending_reference_has_schedule CHECK (
          status <> 'PENDING_REFERENCE' OR next_reference_check_at IS NOT NULL
        ),
        CONSTRAINT wager_tx_opening_is_internal CHECK (
          (kind = 'OPENING') = (provider_id = 'internal')
        )
      );
    `);

    // Uma referência só pode ser revertida (REFUND/ROLLBACK) uma vez.
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';
    `);
    // Worker de referências pendentes.
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_due
        ON wager_transactions (next_reference_check_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    // Quando a referência chega, acha quem estava esperando por ela.
    this.addSql(`
      CREATE INDEX wager_tx_waiting_for_reference
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`CREATE INDEX wager_tx_wallet ON wager_transactions (wallet_id);`);

    // --------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id                     uuid           PRIMARY KEY,
        seq                    bigint         GENERATED ALWAYS AS IDENTITY UNIQUE,
        wallet_id              uuid           NOT NULL REFERENCES wallets (id),
        transaction_id         uuid           NOT NULL REFERENCES wager_transactions (id),
        direction              text           NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount                 numeric(20, 2) NOT NULL CHECK (amount > 0),
        currency               char(3)        NOT NULL,
        balance_before_amount  numeric(20, 2) NOT NULL CHECK (balance_before_amount >= 0),
        balance_after_amount   numeric(20, 2) NOT NULL CHECK (balance_after_amount >= 0),
        created_at             timestamptz    NOT NULL,

        -- No máximo um lançamento por wallet por transação.
        CONSTRAINT ledger_one_entry_per_tx_wallet UNIQUE (transaction_id, wallet_id),
        -- A aritmética do lançamento fecha.
        CONSTRAINT ledger_entry_balanced CHECK (
          balance_after_amount = CASE direction
            WHEN 'CREDIT' THEN balance_before_amount + amount
            ELSE balance_before_amount - amount
          END
        )
      );
    `);
    this.addSql(`CREATE INDEX ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq);`);

    // ---------------------------------------------------------- outbox / inbox
    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid        PRIMARY KEY,
        seq              bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
        aggregate_id     uuid        NOT NULL,
        event_type       text        NOT NULL,
        payload          jsonb       NOT NULL,
        occurred_at      timestamptz NOT NULL,
        attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at  timestamptz,
        published_at     timestamptz
      );
    `);
    this.addSql(`
      CREATE INDEX outbox_pending_due ON outbox_messages (next_attempt_at, seq)
        WHERE published_at IS NULL;
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  text        NOT NULL,
        message_id     text        NOT NULL,
        payload_hash   char(64)    NOT NULL,
        received_at    timestamptz NOT NULL,
        processed_at   timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // ================================================================ triggers

    // Ledger é append-only: UPDATE, DELETE e TRUNCATE são proibidos.
    this.addSql(`
      CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only (% forbidden)', TG_TABLE_NAME, TG_OP
          USING ERRCODE = 'restrict_violation';
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
    `);

    // Transações: campos de negócio imutáveis; estado terminal não muda; sem DELETE.
    this.addSql(`
      CREATE FUNCTION guard_wager_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions cannot be deleted' USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'transaction % is terminal (%)', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key,
            NEW.payload_hash, NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id,
            NEW.kind, NEW.amount, NEW.currency, NEW.reference_external_transaction_id,
            NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key,
            OLD.payload_hash, OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id,
            OLD.kind, OLD.amount, OLD.currency, OLD.reference_external_transaction_id,
            OLD.created_at) THEN
          RAISE EXCEPTION 'immutable columns of wager_transactions cannot change'
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION guard_wager_transaction();
    `);

    // Wallet: identidade imutável; version incrementa exatamente quando o saldo muda.
    this.addSql(`
      CREATE FUNCTION guard_wallet_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
           IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet identity cannot change' USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.balance_amount <> OLD.balance_amount AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'balance change must increment version by 1' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.balance_amount = OLD.balance_amount AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'version changes only with balance' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER wallet_guard BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION guard_wallet_update();
    `);
    this.addSql(`
      CREATE TRIGGER wallet_no_delete BEFORE DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    `);

    // Saldo ↔ ledger: no COMMIT, toda mudança de saldo precisa de um lançamento
    // exatamente com aquele "antes" e "depois". Constraint trigger DEFERRED
    // porque a wallet é atualizada antes do lançamento ser inserido.
    this.addSql(`
      CREATE FUNCTION check_wallet_balance_has_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        old_balance numeric(20, 2) := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE OLD.balance_amount END;
      BEGIN
        IF NEW.balance_amount <> old_balance AND NOT EXISTS (
          SELECT 1 FROM wallet_ledger_entries
           WHERE wallet_id = NEW.id
             AND balance_before_amount = old_balance
             AND balance_after_amount = NEW.balance_amount
        ) THEN
          RAISE EXCEPTION 'wallet % balance changed % -> % without ledger entry',
            NEW.id, old_balance, NEW.balance_amount USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_balance_has_ledger
        AFTER INSERT OR UPDATE OF balance_amount ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION check_wallet_balance_has_ledger();
    `);

    // Lançamento só para transação PROCESSED que move saldo (LOSS e REJECTED não geram).
    this.addSql(`
      CREATE FUNCTION check_ledger_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM wager_transactions t
           WHERE t.id = NEW.transaction_id
             AND t.wallet_id = NEW.wallet_id
             AND t.status = 'PROCESSED'
             AND t.kind <> 'LOSS'
             AND t.amount = NEW.amount
             AND t.currency = NEW.currency
        ) THEN
          RAISE EXCEPTION 'ledger entry % does not match a processed balance-moving transaction', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_matches_transaction
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION check_ledger_transaction();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
    this.addSql(`DROP FUNCTION IF EXISTS check_ledger_transaction();`);
    this.addSql(`DROP FUNCTION IF EXISTS check_wallet_balance_has_ledger();`);
    this.addSql(`DROP FUNCTION IF EXISTS guard_wallet_update();`);
    this.addSql(`DROP FUNCTION IF EXISTS guard_wager_transaction();`);
    this.addSql(`DROP FUNCTION IF EXISTS forbid_mutation();`);
  }
}
