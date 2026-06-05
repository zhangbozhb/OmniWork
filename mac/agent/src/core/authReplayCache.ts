export class AuthReplayCache {
  private readonly seenOrder: string[] = [];
  private readonly seenSet = new Set<string>();

  constructor(private readonly maxEntries = 1024) {}

  has(key: string): boolean {
    return this.seenSet.has(key);
  }

  remember(key: string): void {
    this.seenSet.add(key);
    this.seenOrder.push(key);
    while (this.seenOrder.length > this.maxEntries) {
      const oldest = this.seenOrder.shift();
      if (oldest) {
        this.seenSet.delete(oldest);
      }
    }
  }
}
