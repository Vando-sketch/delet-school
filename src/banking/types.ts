export interface AccountBalance {
  amount: number;
  currency: string;
  date: string;
  status?: string;
}

export interface BankAccount {
  iban: string;
  bic: string;
  accountNumber: string;
  subaccount?: string;
  bankName?: string;
  balance?: AccountBalance;
}

export interface BankTransaction {
  id: string;
  date: string;
  valueDate?: string;
  amount: number;
  currency: string;
  applicantName?: string;
  applicantIban?: string;
  applicantBic?: string;
  purpose?: string;
  postingText?: string;
  endToEndReference?: string;
  accountIban: string;
}

export interface BankStatement {
  id: string;
  filename: string;
  path: string;
  date: string;
  size: number;
  accountIban: string;
  autoIngested: boolean;
}

export interface TanChallenge {
  challengeId: string;
  prompt: string;
  tanMedium?: string;
  decoupled: boolean;
  requiresResponse: boolean;
  createdAt: string;
}

export interface BankingSyncResult {
  success: boolean;
  accountsCount: number;
  transactionsCount: number;
  statementsCount: number;
  error?: string;
  tanChallenge?: TanChallenge;
}

export interface BankingState {
  accounts: BankAccount[];
  transactions: BankTransaction[];
  statements: BankStatement[];
  lastSyncAt?: string;
  isSyncing: boolean;
  pendingTan?: TanChallenge;
}

export interface BankingConfig {
  blz?: string;
  user?: string;
  pin?: string;
  endpoint?: string;
  iban?: string;
  tanMedium?: string;
  autoSyncIntervalHours: number;
  syncStatements: boolean;
  syncTransactions: boolean;
  destinationFolder: string;
  autoIngestStatements: boolean;
  mock: boolean;
  pythonBin: string;
}
