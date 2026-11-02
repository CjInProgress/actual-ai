import TransactionService from '../src/transaction-service';
import InMemoryActualApiService from './test-doubles/in-memory-actual-api-service';
import MockedLlmService from './test-doubles/mocked-llm-service';
import MockedPromptGenerator from './test-doubles/mocked-prompt-generator';
import GivenActualData from './test-doubles/given/given-actual-data';
import SimilarityCalculator from '../src/similarity-calculator';
import CategorySuggestionOptimizer from '../src/category-suggestion-optimizer';
import TagService from '../src/transaction/tag-service';
import RuleMatchStrategy from '../src/transaction/processing-strategy/rule-match-strategy';
import ExistingCategoryStrategy from '../src/transaction/processing-strategy/existing-category-strategy';
import NewCategoryStrategy from '../src/transaction/processing-strategy/new-category-strategy';
import CategorySuggester from '../src/transaction/category-suggester';
import BatchTransactionProcessor from '../src/transaction/batch-transaction-processor';
import TransactionProcessor from '../src/transaction/transaction-processor';
import TransactionFilterer from '../src/transaction/transaction-filterer';
import SuggestOnlyActualApiService from '../src/suggest-only-actual-api-service';

describe('suggestOnly', () => {
  let inMemoryApiService: InMemoryActualApiService;
  let suggestOnlyApiService: SuggestOnlyActualApiService;
  let mockedLlmService: MockedLlmService;
  let transactionService: TransactionService;
  const tagService = new TagService('#actual-ai-miss', '#actual-ai', '#ai-suggest');

  beforeEach(() => {
    inMemoryApiService = new InMemoryActualApiService();
    suggestOnlyApiService = new SuggestOnlyActualApiService(inMemoryApiService, tagService);
    mockedLlmService = new MockedLlmService();

    // Every collaborator gets the wrapper, exactly as container.ts wires it.
    const transactionProcessor = new TransactionProcessor(
      suggestOnlyApiService,
      mockedLlmService,
      new MockedPromptGenerator(),
      tagService,
      [
        new RuleMatchStrategy(suggestOnlyApiService, tagService),
        new ExistingCategoryStrategy(suggestOnlyApiService, tagService),
        new NewCategoryStrategy(suggestOnlyApiService, tagService),
      ],
    );
    transactionService = new TransactionService(
      suggestOnlyApiService,
      new CategorySuggester(
        suggestOnlyApiService,
        new CategorySuggestionOptimizer(new SimilarityCalculator()),
        tagService,
      ),
      new BatchTransactionProcessor(transactionProcessor, 20),
      new TransactionFilterer(tagService),
      false,
    );

    inMemoryApiService.setCategoryGroups(GivenActualData.createSampleCategoryGroups());
    inMemoryApiService.setCategories(GivenActualData.createSampleCategories());
    inMemoryApiService.setPayees(GivenActualData.createSamplePayees());
    inMemoryApiService.setAccounts(GivenActualData.createSampleAccounts());
    inMemoryApiService.setRules(GivenActualData.createSampleRules());
  });

  it('writes the guess into the notes and leaves the category empty', async () => {
    inMemoryApiService.setTransactions([
      GivenActualData.createTransaction('1', -123, 'Carrefour 1234', 'card 1234'),
    ]);
    mockedLlmService.setUnifiedResponse({
      type: 'existing',
      categoryId: GivenActualData.CATEGORY_GROCERIES,
    });

    await transactionService.processTransactions();

    const [transaction] = await inMemoryApiService.getTransactions();
    expect(transaction.category).toBeFalsy();
    expect(transaction.notes).toBe('card 1234 #ai-suggest Groceries');
  });

  it('keeps the rule attribution after the suggestion', async () => {
    inMemoryApiService.setTransactions([
      GivenActualData.createTransaction('1', -123, 'Carrefour 1234'),
    ]);
    mockedLlmService.setUnifiedResponse({
      type: 'rule',
      ruleName: 'Groceries rule',
      categoryId: GivenActualData.CATEGORY_GROCERIES,
    });

    await transactionService.processTransactions();

    const [transaction] = await inMemoryApiService.getTransactions();
    expect(transaction.category).toBeFalsy();
    expect(transaction.notes).toBe('#ai-suggest Groceries (rule: Groceries rule)');
  });

  it('does not ask the model again about a transaction waiting for approval', async () => {
    inMemoryApiService.setTransactions([
      GivenActualData.createTransaction('1', -123, 'Carrefour 1234'),
    ]);
    mockedLlmService.setUnifiedResponse({
      type: 'existing',
      categoryId: GivenActualData.CATEGORY_GROCERIES,
    });
    const ask = jest.spyOn(mockedLlmService, 'ask');

    await transactionService.processTransactions();
    await transactionService.processTransactions();

    expect(ask).toHaveBeenCalledTimes(1);
    const [transaction] = await inMemoryApiService.getTransactions();
    expect(transaction.notes).toBe('#ai-suggest Groceries');
  });

  it('still marks a miss in the notes', async () => {
    inMemoryApiService.setTransactions([
      GivenActualData.createTransaction('1', -123, 'Unknown shop'),
    ]);
    mockedLlmService.setUnifiedResponse({ type: 'existing' });

    await transactionService.processTransactions();

    const [transaction] = await inMemoryApiService.getTransactions();
    expect(transaction.category).toBeFalsy();
    expect(transaction.notes).toBe('#actual-ai-miss');
  });

  it('marks a new-category answer as missed instead of asking again every run', async () => {
    inMemoryApiService.setTransactions([
      GivenActualData.createTransaction('1', -3300, 'POS 88213 XJ7 LLC'),
    ]);
    mockedLlmService.setUnifiedResponse({
      type: 'new',
      newCategory: { name: 'Shopping', groupName: 'Shopping', groupIsNew: true },
    });
    const ask = jest.spyOn(mockedLlmService, 'ask');

    await transactionService.processTransactions();
    await transactionService.processTransactions();

    const [transaction] = await inMemoryApiService.getTransactions();
    expect(transaction.category).toBeFalsy();
    expect(transaction.notes).toBe('#actual-ai-miss');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('refuses to create or change categories', async () => {
    await expect(suggestOnlyApiService.createCategory('New', '1')).rejects.toThrow('suggestOnly');
    await expect(suggestOnlyApiService.createCategoryGroup('New')).rejects.toThrow('suggestOnly');
    await expect(suggestOnlyApiService.updateCategoryGroup('1', 'New')).rejects.toThrow('suggestOnly');
    expect(await inMemoryApiService.getCategories()).toHaveLength(
      GivenActualData.createSampleCategories().length,
    );
  });
});

describe('TagService suggestions', () => {
  const service = new TagService('#actual-ai-miss', '#actual-ai', '#ai-suggest');

  it('replaces the guessed tag with the suggestion', () => {
    expect(service.toSuggestion('note #actual-ai', 'Eating Out')).toBe('note #ai-suggest Eating Out');
  });

  it('appends the suggestion when there is no guessed tag', () => {
    expect(service.toSuggestion('note', 'Groceries')).toBe('note #ai-suggest Groceries');
  });

  it('recognises a suggested note', () => {
    expect(service.isSuggested('note #ai-suggest Groceries')).toBe(true);
    expect(service.isSuggested('note #actual-ai')).toBe(false);
  });

  it('rejects a suggested tag that shares a prefix with another tag', () => {
    expect(() => new TagService('#actual-ai-miss', '#actual-ai', '#actual-ai-suggest')
      .assertSuggestedTagIsDistinct()).toThrow('prefix');
    expect(() => service.assertSuggestedTagIsDistinct()).not.toThrow();
  });
});
