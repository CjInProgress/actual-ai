import {
  RuleEntity,
  TransactionEntity,
} from '@actual-app/core/src/types/models';
import { APIPayeeEntity } from '@actual-app/core/src/server/api-models';
import {
  ActualApiServiceI, APICategoryEntity, APICategoryGroupEntity,
  LlmServiceI, ProcessingStrategyI,
  PromptGeneratorI,
} from '../types';
import TagService from './tag-service';
import ModelUnavailableException from '../exceptions/model-unavailable-exception';
import { isModelUnreachable } from '../utils/model-reachability';
import type PayeeHistory from './payee-history';

class TransactionProcessor {
  private readonly actualApiService: ActualApiServiceI;

  private readonly llmService: LlmServiceI;

  private readonly promptGenerator: PromptGeneratorI;

  private readonly tagService: TagService;

  private readonly processingStrategies: ProcessingStrategyI[];

  constructor(
    actualApiClient: ActualApiServiceI,
    llmService: LlmServiceI,
    promptGenerator: PromptGeneratorI,
    tagService: TagService,
    processingStrategies: ProcessingStrategyI[],
  ) {
    this.actualApiService = actualApiClient;
    this.llmService = llmService;
    this.promptGenerator = promptGenerator;
    this.tagService = tagService;
    this.processingStrategies = processingStrategies;
  }

  public async process(
    transaction: TransactionEntity,
    categoryGroups: APICategoryGroupEntity[],
    payees: APIPayeeEntity[],
    rules: RuleEntity[],
    categories: (APICategoryEntity | APICategoryGroupEntity)[],
    suggestedCategories: Map<string, {
        name: string;
        groupName: string;
        groupIsNew: boolean;
        groupId?: string;
        transactions: TransactionEntity[];
      }>,
    payeeHistory?: PayeeHistory,
  ): Promise<void> {
    try {
      const history = payeeHistory?.lookup(transaction);
      if (history?.length) {
        // so a reviewer can tell an answer that followed past categories from one the model made up
        console.log(`Payee history: ${history.map((h) => `${h.categoryName} x${h.count}`).join(', ')}`);
      }
      const prompt = this.promptGenerator.generate(
        categoryGroups,
        transaction,
        payees,
        rules,
        history,
      );

      let response;
      try {
        response = await this.llmService.ask(prompt);
      } catch (error) {
        if (isModelUnreachable(error)) {
          throw new ModelUnavailableException(
            `The model did not answer for transaction ${transaction.id}`,
            { cause: error },
          );
        }
        throw error;
      }

      const strategy = this.processingStrategies.find((s) => s.isSatisfiedBy(response));
      if (strategy) {
        await strategy.process(transaction, response, categories, suggestedCategories);
        return;
      }

      console.warn(`Unexpected response format: ${JSON.stringify(response)}`);
      await this.actualApiService.updateTransactionNotes(
        transaction.id,
        this.tagService.addNotGuessedTag(transaction.notes ?? ''),
      );
    } catch (error) {
      if (error instanceof ModelUnavailableException) {
        throw error;
      }
      console.error(`Error processing transaction ${transaction.id}:`, error);
      await this.actualApiService.updateTransactionNotes(
        transaction.id,
        this.tagService.addNotGuessedTag(transaction.notes ?? ''),
      );
    }
  }
}

export default TransactionProcessor;
