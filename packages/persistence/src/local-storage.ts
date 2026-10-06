import type { EnergyGoalVersion, FoodLogItem } from '@macros/contracts';
import { InMemoryFoodLogRepository, InMemoryEnergyGoalRepository } from './in-memory.js';
import { foodLogToRow, rowToFoodLog, goalToRow, rowToGoal, type FoodLogRow, type GoalRow } from './row-codec.js';
import type { FoodLogRepository, EnergyGoalRepository, AppendFoodLogResult } from './repositories.js';

/** Injected native storage; this package has no React Native dependency. */
export interface StringStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** Serialized writes become visible only after durable storage succeeds. */
export class LocalFoodLogRepository implements FoodLogRepository {
  private rows: FoodLogRow[] = [];
  private memory = new InMemoryFoodLogRepository();
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(private readonly store: StringStore, private readonly key: string) {}
  static async open(store: StringStore, key: string): Promise<LocalFoodLogRepository> {
    const repo = new LocalFoodLogRepository(store, key);
    const raw = await store.getItem(key);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Invalid local food log');
      for (const row of parsed as FoodLogRow[]) {
        const item = rowToFoodLog(row);
        const result = await repo.memory.append(item);
        if (result.outcome !== 'appended') throw new Error('Duplicate local food log');
        repo.rows.push(foodLogToRow(result.item));
      }
    }
    return repo;
  }
  append(item: FoodLogItem): Promise<AppendFoodLogResult> {
    const operation = this.tail.then(async () => {
      const candidate = new InMemoryFoodLogRepository();
      for (const row of this.rows) await candidate.append(rowToFoodLog(row));
      const result = await candidate.append(item);
      if (result.outcome === 'appended') {
        const next = [...this.rows, foodLogToRow(result.item)];
        await this.store.setItem(this.key, JSON.stringify(next));
        this.rows = next;
        this.memory = candidate;
      }
      return result;
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  listByLocalDate(userId: string, date: string) { return this.memory.listByLocalDate(userId, date); }
  findById(userId: string, logId: string) { return this.memory.findById(userId, logId); }
  listRecentProductVersionIds(userId: string, limit: number) { return this.memory.listRecentProductVersionIds(userId, limit); }
  /** A synchronous projection of already-committed rows for the native host. */
  snapshot(userId: string, date: string): readonly FoodLogItem[] {
    return this.rows.filter(r => r.user_id === userId && r.local_date === date).map(rowToFoodLog);
  }
}

export class LocalEnergyGoalRepository implements EnergyGoalRepository {
  private rows: GoalRow[] = [];
  private memory = new InMemoryEnergyGoalRepository();
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(private readonly store: StringStore, private readonly key: string) {}
  static async open(store: StringStore, key: string): Promise<LocalEnergyGoalRepository> {
    const repo = new LocalEnergyGoalRepository(store, key);
    const raw = await store.getItem(key);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Invalid local goals');
      for (const row of parsed as GoalRow[]) {
        const goal = rowToGoal(row);
        await repo.memory.append(goal);
        repo.rows.push(goalToRow(goal));
      }
    }
    return repo;
  }
  append(goal: EnergyGoalVersion): Promise<EnergyGoalVersion> {
    const operation = this.tail.then(async () => {
      if (this.rows.some(r => r.goal_version_id === goal.goalVersionId)) throw new Error('Goal version already exists');
      const validated = rowToGoal(goalToRow(goal));
      const next = [...this.rows, goalToRow(validated)];
      await this.store.setItem(this.key, JSON.stringify(next));
      this.rows = next;
      await this.memory.append(validated);
      return validated;
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  getEffective(userId: string, at: string) { return this.memory.getEffective(userId, at); }
}
