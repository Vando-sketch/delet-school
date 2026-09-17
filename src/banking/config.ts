import 'dotenv/config';
import * as fs from 'node:fs';
import type { BankingConfig } from './types.js';

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value ? value : fallback;
}

export function getBankingConfig(): BankingConfig {
  const blz = process.env.FINTS_BLZ;
  const user = process.env.FINTS_USER;
  const pin = process.env.FINTS_PIN;
  const endpoint = process.env.FINTS_ENDPOINT;
  const iban = process.env.FINTS_IBAN;
  const tanMedium = process.env.FINTS_TAN_MEDIUM;

  const autoSyncIntervalHours = Number(optional('FINTS_AUTO_SYNC_INTERVAL_HOURS', '24'));
  const syncStatements = optional('FINTS_SYNC_STATEMENTS', 'true').toLowerCase() === 'true';
  const syncTransactions = optional('FINTS_SYNC_TRANSACTIONS', 'true').toLowerCase() === 'true';
  const autoIngestStatements = optional('FINTS_AUTO_INGEST_STATEMENTS', 'true').toLowerCase() === 'true';
  const destinationFolder = optional('FINTS_DESTINATION_FOLDER', './data/banking/statements');
  const mock = optional('FINTS_MOCK', 'false').toLowerCase() === 'true' || (!blz && !user);

  let defaultPython = 'python3';
  if (process.env.VIRTUAL_ENV && fs.existsSync(`${process.env.VIRTUAL_ENV}/bin/python3`)) {
    defaultPython = `${process.env.VIRTUAL_ENV}/bin/python3`;
  } else if (fs.existsSync('./.venv/bin/python3')) {
    defaultPython = './.venv/bin/python3';
  }

  const pythonBin = optional('FINTS_PYTHON_BIN', defaultPython);

  return {
    blz,
    user,
    pin,
    endpoint,
    iban,
    tanMedium,
    autoSyncIntervalHours,
    syncStatements,
    syncTransactions,
    destinationFolder,
    autoIngestStatements,
    mock,
    pythonBin,
  };
}
