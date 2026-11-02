import { CategoryEntity, TransactionEntity } from '@actual-app/core/src/types/models';
import type {
  ActualApiServiceI, ProcessingStrategyI, UnifiedResponse,
} from '../../types';
import { isFeatureEnabled } from '../../config';
import TagService from '../tag-service';

class NewCategoryStrategy implements ProcessingStrategyI {
  private readonly actualApiService: ActualApiServiceI;

  private readonly tagService: TagService;

  constructor(actualApiService: ActualApiServiceI, tagService: TagService) {
    this.actualApiService = actualApiService;
    this.tagService = tagService;
  }

  public isSatisfiedBy(response: UnifiedResponse): boolean {
    if (response.newCategory === undefined) {
      return false;
    }
    return response.type === 'new';
  }

  public async process(
    transaction: TransactionEntity,
    response: UnifiedResponse,
    categories: CategoryEntity[],
    suggestedCategories: Map<string, {
        name: string;
        groupName: string;
        groupIsNew: boolean;
        groupId?: string;
        transactions: TransactionEntity[];
      }>,
  ) {
    if (response.newCategory === undefined) {
      throw new Error('No newCategory in response');
    }
    // Without suggestNewCategories nothing would ever act on the suggestion,
    // and the untouched transaction went back to the model on every run.
    if (!isFeatureEnabled('suggestNewCategories')) {
      console.log(`No existing category fits; new category "${response.newCategory.name}" not enabled, marking as missed`);
      await this.actualApiService.updateTransactionNotes(
        transaction.id,
        this.tagService.addNotGuessedTag(transaction.notes ?? ''),
      );
      return;
    }
    const categoryKey = `${response.newCategory.groupName}:${response.newCategory.name}`;

    const existing = suggestedCategories.get(categoryKey);
    if (existing) {
      existing.transactions.push(transaction);
    } else {
      suggestedCategories.set(categoryKey, {
        ...response.newCategory,
        transactions: [transaction],
      });
    }
  }
}

export default NewCategoryStrategy;
