export * from './types.js';
export * from './config.js';
export * from './client.js';
export * from './service.js';

import { BankingService } from './service.js';

let bankingServiceInstance: BankingService | undefined;

export function getBankingService(): BankingService {
  if (!bankingServiceInstance) {
    bankingServiceInstance = new BankingService();
  }
  return bankingServiceInstance;
}
