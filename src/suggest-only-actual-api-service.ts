import {
  APIAccountEntity,
  APIPayeeEntity,
} from '@actual-app/core/src/server/api-models';
import { TransactionEntity, RuleEntity } from '@actual-app/core/src/types/models';
import {
  ActualApiServiceI, APICategoryEntity, APICategoryGroupEntity,
} from './types';
import TagService from './transaction/tag-service';

// Wraps the real API service for the suggestOnly feature. Every write that
// would set a category becomes a notes-only write carrying the suggestion,
// and category changes are refused, so no strategy can bypass the mode.
class SuggestOnlyActualApiService implements ActualApiServiceI {
  private readonly inner: ActualApiServiceI;

  private readonly tagService: TagService;

  private categoryNames: Map<string, string> | undefined;

  constructor(inner: ActualApiServiceI, tagService: TagService) {
    this.inner = inner;
    this.tagService = tagService;
  }

  public async initializeApi(): Promise<void> {
    this.categoryNames = undefined;
    return this.inner.initializeApi();
  }

  public async shutdownApi(): Promise<void> {
    return this.inner.shutdownApi();
  }

  public async getCategoryGroups(): Promise<APICategoryGroupEntity[]> {
    return this.inner.getCategoryGroups();
  }

  public async getCategories(): Promise<(APICategoryEntity | APICategoryGroupEntity)[]> {
    return this.inner.getCategories();
  }

  public async getAccounts(): Promise<APIAccountEntity[]> {
    return this.inner.getAccounts();
  }

  public async getPayees(): Promise<APIPayeeEntity[]> {
    return this.inner.getPayees();
  }

  public async getTransactions(): Promise<TransactionEntity[]> {
    return this.inner.getTransactions();
  }

  public async getRules(): Promise<RuleEntity[]> {
    return this.inner.getRules();
  }

  public async getPayeeRules(payeeId: string): Promise<RuleEntity[]> {
    return this.inner.getPayeeRules(payeeId);
  }

  public async updateTransactionNotes(id: string, notes: string): Promise<void> {
    return this.inner.updateTransactionNotes(id, notes);
  }

  public async updateTransactionNotesAndCategory(
    id: string,
    notes: string,
    categoryId: string,
  ): Promise<void> {
    const categoryName = await this.getCategoryName(categoryId);
    console.log(`SUGGEST ONLY: transaction ${id} suggested category ${categoryName}`);
    return this.inner.updateTransactionNotes(id, this.tagService.toSuggestion(notes, categoryName));
  }

  public async runBankSync(): Promise<void> {
    return this.inner.runBankSync();
  }

  public async createCategory(name: string, _groupId: string): Promise<string> {
    return Promise.reject(new Error(`suggestOnly: refusing to create category "${name}"`));
  }

  public async createCategoryGroup(name: string): Promise<string> {
    return Promise.reject(new Error(`suggestOnly: refusing to create category group "${name}"`));
  }

  public async updateCategoryGroup(id: string, _name: string): Promise<void> {
    return Promise.reject(new Error(`suggestOnly: refusing to update category group ${id}`));
  }

  private async getCategoryName(categoryId: string): Promise<string> {
    if (!this.categoryNames) {
      const categories = await this.inner.getCategories();
      this.categoryNames = new Map(categories.map((c) => [c.id, c.name]));
    }
    return this.categoryNames.get(categoryId) ?? categoryId;
  }
}

export default SuggestOnlyActualApiService;
