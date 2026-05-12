export class KeychainUnavailableError extends Error {
  constructor() {
    super("Keychain is reserved for future long-lived credentials and is not used by MVP auth");
  }
}

export async function readFutureSecret(): Promise<never> {
  throw new KeychainUnavailableError();
}
