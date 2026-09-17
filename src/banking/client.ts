import * as path from 'node:path';
import { defaultExecFile, type ExecFileFn } from '../lib/execFile.js';
import type { BankAccount, BankTransaction, BankStatement, BankingConfig, TanChallenge } from './types.js';

export interface FinTSClient {
  getAccounts(): Promise<{ success: boolean; accounts?: BankAccount[]; error?: string; need_tan?: boolean; challenge?: TanChallenge }>;
  getTransactions(iban?: string, days?: number): Promise<{ success: boolean; transactions?: BankTransaction[]; error?: string }>;
  getStatements(iban?: string, outDir?: string): Promise<{ success: boolean; statements?: BankStatement[]; error?: string }>;
  submitTan(tan: string): Promise<{ success: boolean; message?: string; error?: string }>;
}

export class PythonFinTSClient implements FinTSClient {
  private config: BankingConfig;
  private execFile: ExecFileFn;
  private scriptPath: string;

  constructor(config: BankingConfig, execFile: ExecFileFn = defaultExecFile, scriptPath?: string) {
    this.config = config;
    this.execFile = execFile;
    this.scriptPath = scriptPath ?? path.resolve(process.cwd(), 'scripts', 'fints_client.py');
  }

  private async runCommand<T = Record<string, unknown>>(command: string, extraArgs: string[] = []): Promise<T> {
    const pythonBin = this.config.pythonBin || 'python3';
    const configPayload = JSON.stringify({
      blz: this.config.blz,
      user: this.config.user,
      pin: this.config.pin,
      endpoint: this.config.endpoint,
      iban: this.config.iban,
      tanMedium: this.config.tanMedium,
      mock: this.config.mock,
    });

    const args = [this.scriptPath, command, '--config', configPayload, ...extraArgs];
    if (this.config.mock) {
      args.push('--mock');
    }

    try {
      const { stdout, stderr } = await this.execFile(pythonBin, args);
      if (!stdout && stderr) {
        return { success: false, error: stderr.trim() } as T;
      }
      return JSON.parse(stdout.trim()) as T;
    } catch (err: unknown) {
      const errorObj = err as { stdout?: string; message?: string };
      // If the process failed, check if stdout returned valid JSON anyway
      if (errorObj.stdout) {
        try {
          return JSON.parse(errorObj.stdout.trim()) as T;
        } catch {
          // ignore
        }
      }
      return { success: false, error: errorObj.message || String(err) } as T;
    }
  }

  async getAccounts(): Promise<{ success: boolean; accounts?: BankAccount[]; error?: string; need_tan?: boolean; challenge?: TanChallenge }> {
    return this.runCommand('accounts');
  }

  async getTransactions(iban?: string, days: number = 30): Promise<{ success: boolean; transactions?: BankTransaction[]; error?: string }> {
    const extraArgs = ['--days', String(days)];
    if (iban) extraArgs.push('--iban', iban);
    return this.runCommand('transactions', extraArgs);
  }

  async getStatements(iban?: string, outDir?: string): Promise<{ success: boolean; statements?: BankStatement[]; error?: string }> {
    const targetDir = outDir || this.config.destinationFolder;
    const extraArgs = ['--outdir', targetDir];
    if (iban) extraArgs.push('--iban', iban);
    return this.runCommand('statements', extraArgs);
  }

  async submitTan(tan: string): Promise<{ success: boolean; message?: string; error?: string }> {
    return this.runCommand('submit-tan', ['--tan', tan]);
  }
}
