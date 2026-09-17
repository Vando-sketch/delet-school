import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PythonFinTSClient, BankingService, type FinTSClient, type BankingConfig } from '../src/banking/index.js';

describe('PythonFinTSClient', () => {
  it('parses successful accounts output from Python client', async () => {
    const mockExecFile = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        accounts: [
          {
            iban: 'DE89370400440532013000',
            bic: 'COBADEFFXXX',
            accountNumber: '0532013000',
            balance: { amount: 1500, currency: 'EUR', date: '2026-09-16' },
          },
        ],
      }),
      stderr: '',
    });

    const config: BankingConfig = {
      blz: '12030000',
      user: 'testuser',
      pin: '12345',
      autoSyncIntervalHours: 0,
      syncStatements: true,
      syncTransactions: true,
      destinationFolder: '/tmp/statements',
      autoIngestStatements: false,
      mock: false,
      pythonBin: 'python3',
    };

    const client = new PythonFinTSClient(config, mockExecFile);
    const result = await client.getAccounts();

    expect(result.success).toBe(true);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts?.[0].iban).toBe('DE89370400440532013000');
    expect(result.accounts?.[0].balance?.amount).toBe(1500);
  });

  it('handles error output gracefully', async () => {
    const mockExecFile = vi.fn().mockRejectedValue(new Error('Process exited with code 1'));

    const config: BankingConfig = {
      autoSyncIntervalHours: 0,
      syncStatements: true,
      syncTransactions: true,
      destinationFolder: '/tmp',
      autoIngestStatements: false,
      mock: false,
      pythonBin: 'python3',
    };

    const client = new PythonFinTSClient(config, mockExecFile);
    const result = await client.getAccounts();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Process exited with code 1');
  });

  it('passes mock argument when mock mode is enabled', async () => {
    const mockExecFile = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, accounts: [] }),
      stderr: '',
    });

    const config: BankingConfig = {
      autoSyncIntervalHours: 0,
      syncStatements: true,
      syncTransactions: true,
      destinationFolder: '/tmp',
      autoIngestStatements: false,
      mock: true,
      pythonBin: 'python3',
    };

    const client = new PythonFinTSClient(config, mockExecFile);
    await client.getAccounts();

    expect(mockExecFile).toHaveBeenCalled();
    const args = mockExecFile.mock.calls[0][1];
    expect(args).toContain('--mock');
  });
});

describe('BankingService', () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'banking-service-test-'));
    stateFile = path.join(tmpDir, 'state.json');
  });

  it('performs synchronization and updates state', async () => {
    const mockClient: FinTSClient = {
      getAccounts: vi.fn().mockResolvedValue({
        success: true,
        accounts: [
          {
            iban: 'DE1234567890',
            bic: 'TESTBIC',
            accountNumber: '1234567890',
            bankName: 'Test Bank',
            balance: { amount: 2000, currency: 'EUR', date: '2026-09-16' },
          },
        ],
      }),
      getTransactions: vi.fn().mockResolvedValue({
        success: true,
        transactions: [
          {
            id: 'tx-1',
            date: '2026-09-16',
            amount: -50,
            currency: 'EUR',
            purpose: 'Groceries',
            accountIban: 'DE1234567890',
          },
        ],
      }),
      getStatements: vi.fn().mockResolvedValue({
        success: true,
        statements: [
          {
            id: 'stmt-1',
            filename: 'Kontoauszug_2026_09.pdf',
            path: path.join(tmpDir, 'sample.pdf'),
            date: '2026-09-16',
            size: 1024,
            accountIban: 'DE1234567890',
            autoIngested: false,
          },
        ],
      }),
      submitTan: vi.fn().mockResolvedValue({ success: true }),
    };

    // Create a dummy file for the statement
    await fs.writeFile(path.join(tmpDir, 'sample.pdf'), 'dummy pdf');

    const config: BankingConfig = {
      autoSyncIntervalHours: 0,
      syncStatements: true,
      syncTransactions: true,
      destinationFolder: tmpDir,
      autoIngestStatements: false,
      mock: false,
      pythonBin: 'python3',
    };

    const service = new BankingService(config, mockClient, stateFile);
    await service.init();

    const result = await service.sync();
    expect(result.success).toBe(true);
    expect(result.accountsCount).toBe(1);
    expect(result.transactionsCount).toBe(1);
    expect(result.statementsCount).toBe(1);

    const accounts = service.getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].iban).toBe('DE1234567890');

    const transactions = service.getTransactions();
    expect(transactions).toHaveLength(1);
    expect(transactions[0].amount).toBe(-50);

    const statements = service.getStatements();
    expect(statements).toHaveLength(1);
    expect(statements[0].filename).toBe('Kontoauszug_2026_09.pdf');

    // Verify state was saved to disk
    const savedContent = await fs.readFile(stateFile, 'utf-8');
    const parsed = JSON.parse(savedContent);
    expect(parsed.accounts).toHaveLength(1);
  });

  it('handles TAN challenge from bank', async () => {
    const mockClient: FinTSClient = {
      getAccounts: vi.fn().mockResolvedValue({
        success: false,
        need_tan: true,
        challenge: {
          challengeId: 'tan-999',
          prompt: 'Please approve the pushTAN request on your banking app',
          tanMedium: 'pushTAN App',
          decoupled: true,
          requiresResponse: true,
          createdAt: new Date().toISOString(),
        },
      }),
      getTransactions: vi.fn(),
      getStatements: vi.fn(),
      submitTan: vi.fn().mockResolvedValue({ success: true }),
    };

    const config: BankingConfig = {
      autoSyncIntervalHours: 0,
      syncStatements: true,
      syncTransactions: true,
      destinationFolder: tmpDir,
      autoIngestStatements: false,
      mock: false,
      pythonBin: 'python3',
    };

    const service = new BankingService(config, mockClient, stateFile);
    await service.init();

    const result = await service.sync();
    expect(result.success).toBe(false);
    expect(result.tanChallenge).toBeDefined();
    expect(result.tanChallenge?.challengeId).toBe('tan-999');

    expect(service.getPendingTan()?.challengeId).toBe('tan-999');

    // Now submit TAN
    const tanRes = await service.submitTan('123456');
    expect(tanRes.success).toBe(true);
    expect(service.getPendingTan()).toBeUndefined();
  });
});
