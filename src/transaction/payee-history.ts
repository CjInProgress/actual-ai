import type { TransactionEntity } from '@actual-app/core/src/types/models';
import type { APICategoryEntity, APICategoryGroupEntity, PayeeHistoryEntry } from '../types';
import type TagService from './tag-service';

const MAX_ENTRIES = 3;

// Bank descriptions carry store numbers, dates and card digits ("TST* DOS EQUIS #123 04/12"),
// so the same merchant only matches after those are stripped.
export function normalizeImportedPayee(importedPayee: string): string {
  return importedPayee
    .toLowerCase()
    .replace(/^(tst|sq|sp|pp|paypal)\s*\*\s*/, '')
    .replace(/[0-9#*/\\.,:;'"()_-]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1)
    .slice(0, 3)
    .join(' ');
}

/**
 * How the owner categorized earlier transactions from each payee, for the prompt. Only
 * categories a person set count: a category actual-ai set itself (guessed tag, no approval)
 * would only teach the model its own past answers.
 */
export default class PayeeHistory {
  private readonly byPayee = new Map<string, Map<string, number>>();

  private readonly byImportedPayee = new Map<string, Map<string, number>>();

  private readonly categoryNames: Map<string, string>;

  private readonly tagService: TagService;

  private learned = 0;

  constructor(
    transactions: TransactionEntity[],
    categories: (APICategoryEntity | APICategoryGroupEntity)[],
    tagService: TagService,
  ) {
    this.tagService = tagService;
    // group ids are in here too, which is harmless: no transaction has a group as its category
    this.categoryNames = new Map(categories.map((c) => [c.id, c.name]));
    transactions
      .flatMap((t) => (t.subtransactions?.length ? t.subtransactions : [t]))
      .forEach((t) => this.add(t));
  }

  public get size(): number {
    return this.learned;
  }

  public get payeeCount(): number {
    return this.byPayee.size;
  }

  public lookup(transaction: TransactionEntity): PayeeHistoryEntry[] {
    const counts = (transaction.payee ? this.byPayee.get(transaction.payee) : undefined)
      ?? this.byImportedPayee.get(normalizeImportedPayee(transaction.imported_payee ?? ''));
    if (!counts) {
      return [];
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ENTRIES)
      .map(([categoryId, count]) => ({
        categoryId,
        categoryName: this.categoryNames.get(categoryId) ?? categoryId,
        count,
      }));
  }

  private add(transaction: TransactionEntity): void {
    const { category } = transaction;
    if (!category || !this.categoryNames.has(category)
      || transaction.transfer_id || transaction.starting_balance_flag || transaction.tombstone
      || this.tagService.isGuessed(transaction.notes ?? '')) {
      return;
    }
    this.learned += 1;
    if (transaction.payee) {
      PayeeHistory.count(this.byPayee, transaction.payee, category);
    }
    const imported = normalizeImportedPayee(transaction.imported_payee ?? '');
    if (imported) {
      PayeeHistory.count(this.byImportedPayee, imported, category);
    }
  }

  private static count(
    index: Map<string, Map<string, number>>,
    key: string,
    category: string,
  ): void {
    const counts = index.get(key) ?? new Map<string, number>();
    counts.set(category, (counts.get(category) ?? 0) + 1);
    index.set(key, counts);
  }
}
