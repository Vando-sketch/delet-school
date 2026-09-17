import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import pino from 'pino';
import { getBankingConfig } from './config.js';
import { PythonFinTSClient, type FinTSClient } from './client.js';
import type {
  BankingConfig,
  BankingState,
  BankingSyncResult,
  BankAccount,
  BankTransaction,
  BankStatement,
  TanChallenge,
} from './types.js';
import { config as appConfig } from '../config/index.js';

const logger = pino({ name: 'banking-service' });

export class BankingService {
  private config: BankingConfig;
  private client: FinTSClient;
  private state: BankingState;
  private stateFilePath: string;
  private syncTimer?: NodeJS.Timeout;

  constructor(
    config?: BankingConfig,
    client?: FinTSClient,
    stateFilePath: string = './data/banking/state.json',
  ) {
    this.config = config ?? getBankingConfig();
    this.client = client ?? new PythonFinTSClient(this.config);
    this.stateFilePath = path.resolve(stateFilePath);
    this.state = {
      accounts: [],
      transactions: [],
      statements: [],
      isSyncing: false,
    };
  }

  async init(): Promise<void> {
    await this.loadState();
    if (this.config.autoSyncIntervalHours > 0) {
      const intervalMs = this.config.autoSyncIntervalHours * 60 * 60 * 1000;
      logger.info({ intervalHours: this.config.autoSyncIntervalHours }, 'Starting banking auto-sync scheduler');
      this.syncTimer = setInterval(() => {
        this.sync().catch((err) => {
          logger.error({ err }, 'Error during scheduled banking sync');
        });
      }, intervalMs);
    }
  }

  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
  }

  getState(): BankingState {
    return { ...this.state };
  }

  getAccounts(): BankAccount[] {
    return this.state.accounts;
  }

  getTransactions(iban?: string): BankTransaction[] {
    if (iban) {
      return this.state.transactions.filter((tx) => tx.accountIban === iban);
    }
    return this.state.transactions;
  }

  getStatements(iban?: string): BankStatement[] {
    if (iban) {
      return this.state.statements.filter((s) => s.accountIban === iban);
    }
    return this.state.statements;
  }

  getPendingTan(): TanChallenge | undefined {
    return this.state.pendingTan;
  }

  private async loadState(): Promise<void> {
    try {
      const data = await fs.readFile(this.stateFilePath, 'utf-8');
      const loaded = JSON.parse(data);
      this.state = {
        ...this.state,
        ...loaded,
        isSyncing: false, // never restore as syncing
      };
      logger.info({ accountsCount: this.state.accounts.length }, 'Loaded banking state from disk');
    } catch {
      // File doesn't exist yet, start clean
      await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
    }
  }

  private async saveState(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
      await fs.writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      logger.error({ err, path: this.stateFilePath }, 'Failed to persist banking state');
    }
  }

  async sync(): Promise<BankingSyncResult> {
    if (this.state.isSyncing) {
      return {
        success: false,
        accountsCount: this.state.accounts.length,
        transactionsCount: this.state.transactions.length,
        statementsCount: this.state.statements.length,
        error: 'Sync already in progress',
      };
    }

    this.state.isSyncing = true;
    logger.info('Starting bank synchronization');

    try {
      // 1. Fetch Accounts
      const accountsRes = await this.client.getAccounts();
      if (!accountsRes.success) {
        if (accountsRes.need_tan && accountsRes.challenge) {
          this.state.pendingTan = accountsRes.challenge;
          await this.saveState();
          logger.warn({ challenge: accountsRes.challenge }, 'Bank requested TAN challenge');
          return {
            success: false,
            accountsCount: this.state.accounts.length,
            transactionsCount: this.state.transactions.length,
            statementsCount: this.state.statements.length,
            tanChallenge: accountsRes.challenge,
            error: 'TAN required by bank',
          };
        }
        throw new Error(accountsRes.error || 'Failed to fetch accounts');
      }

      this.state.pendingTan = undefined;
      const accounts = accountsRes.accounts || [];
      this.state.accounts = accounts;

      let newTxCount = 0;
      let newStmtCount = 0;

      // 2. Fetch Transactions & Statements for each account
      for (const account of accounts) {
        // If specific IBAN configured, skip other accounts
        if (this.config.iban && account.iban !== this.config.iban) {
          continue;
        }

        if (this.config.syncTransactions) {
          const txRes = await this.client.getTransactions(account.iban, 30);
          if (txRes.success && txRes.transactions) {
            for (const tx of txRes.transactions) {
              const existingIdx = this.state.transactions.findIndex(
                (t) => t.id === tx.id || (t.date === tx.date && t.amount === tx.amount && t.purpose === tx.purpose),
              );
              if (existingIdx >= 0) {
                this.state.transactions[existingIdx] = tx;
              } else {
                this.state.transactions.unshift(tx);
                newTxCount++;
              }
            }
          }
        }

        if (this.config.syncStatements) {
          const outDir = path.resolve(this.config.destinationFolder);
          const stmtRes = await this.client.getStatements(account.iban, outDir);
          if (stmtRes.success && stmtRes.statements) {
            for (const stmt of stmtRes.statements) {
              const existingIdx = this.state.statements.findIndex((s) => s.id === stmt.id || s.filename === stmt.filename);
              if (existingIdx < 0) {
                // Check if we should copy to INGEST_WATCH_DIR
                let autoIngested = false;
                if (this.config.autoIngestStatements) {
                  try {
                    const watchDir = path.resolve(appConfig.ingest.watchDir);
                    const destDir = path.join(watchDir, 'Kontoauszuege');
                    await fs.mkdir(destDir, { recursive: true });
                    const destPath = path.join(destDir, stmt.filename);
                    await fs.copyFile(stmt.path, destPath);
                    autoIngested = true;
                    logger.info({ statement: stmt.filename, destPath }, 'Auto-ingested bank statement into watch directory');
                  } catch (copyErr) {
                    logger.warn({ copyErr, file: stmt.filename }, 'Failed to auto-ingest statement to watch dir');
                  }
                }
                this.state.statements.unshift({ ...stmt, autoIngested });
                newStmtCount++;
              }
            }
          }
        }
      }

      this.state.lastSyncAt = new Date().toISOString();
      await this.saveState();

      logger.info(
        {
          accountsCount: this.state.accounts.length,
          newTransactions: newTxCount,
          newStatements: newStmtCount,
        },
        'Bank synchronization complete',
      );

      return {
        success: true,
        accountsCount: this.state.accounts.length,
        transactionsCount: this.state.transactions.length,
        statementsCount: this.state.statements.length,
      };
    } catch (err: unknown) {
      logger.error({ err }, 'Bank synchronization failed');
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        accountsCount: this.state.accounts.length,
        transactionsCount: this.state.transactions.length,
        statementsCount: this.state.statements.length,
        error: msg,
      };
    } finally {
      this.state.isSyncing = false;
    }
  }

  async submitTan(tan: string): Promise<{ success: boolean; message?: string; error?: string }> {
    if (!this.state.pendingTan) {
      return { success: false, error: 'No pending TAN challenge found' };
    }

    try {
      const res = await this.client.submitTan(tan);
      if (res.success) {
        this.state.pendingTan = undefined;
        await this.saveState();
        // Trigger sync continuation
        setTimeout(() => this.sync().catch(() => {}), 100);
        return { success: true, message: res.message || 'TAN accepted, continuing sync' };
      }
      return { success: false, error: res.error || 'Invalid TAN' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }
}
