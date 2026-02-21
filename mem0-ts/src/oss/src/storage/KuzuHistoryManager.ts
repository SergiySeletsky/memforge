// eslint-disable-next-line @typescript-eslint/no-require-imports
const kuzu = require("kuzu") as typeof import("kuzu");
import path from "path";
import { HistoryManager } from "./base";

interface KuzuHistoryConfig {
  /** Path to the KuzuDB database directory. Omit (or pass ":memory:") for an
   *  in-process transient store — useful for tests and single-session scripts. */
  dbPath?: string;
}

export class KuzuHistoryManager implements HistoryManager {
  private db: InstanceType<(typeof kuzu)["Database"]>;
  private conn: InstanceType<(typeof kuzu)["Connection"]>;
  private initialized: Promise<void>;

  constructor(config: KuzuHistoryConfig = {}) {
    const raw = config.dbPath;
    // Pass undefined (not a string) to get KuzuDB in-memory mode
    this.db =
      raw && raw !== ":memory:"
        ? new kuzu.Database(path.resolve(raw))
        : new kuzu.Database();
    this.conn = new kuzu.Connection(this.db);
    this.initialized = this.init();
  }

  private async init(): Promise<void> {
    await this.conn.query(`
      CREATE NODE TABLE IF NOT EXISTS MemoryHistory (
        id       STRING,
        memory_id STRING,
        previous_value STRING,
        new_value STRING,
        action   STRING,
        created_at STRING,
        updated_at STRING,
        is_deleted INT64,
        PRIMARY KEY (id)
      )
    `);
  }

  async addHistory(
    memoryId: string,
    previousValue: string | null,
    newValue: string | null,
    action: string,
    createdAt?: string,
    updatedAt?: string,
    isDeleted: number = 0,
  ): Promise<void> {
    await this.initialized;
    const stmt = await this.conn.prepare(
      `CREATE (:MemoryHistory {
        id: $id,
        memory_id: $memory_id,
        previous_value: $previous_value,
        new_value: $new_value,
        action: $action,
        created_at: $created_at,
        updated_at: $updated_at,
        is_deleted: $is_deleted
      })`,
    );
    await this.conn.execute(stmt, {
      id: crypto.randomUUID(),
      memory_id: memoryId,
      previous_value: previousValue ?? "",
      new_value: newValue ?? "",
      action,
      created_at: createdAt || new Date().toISOString(),
      updated_at: updatedAt ?? "",
      is_deleted: isDeleted,
    });
  }

  async getHistory(memoryId: string): Promise<any[]> {
    await this.initialized;
    const stmt = await this.conn.prepare(
      `MATCH (h:MemoryHistory)
       WHERE h.memory_id = $memory_id
       RETURN h.id AS id, h.memory_id AS memory_id,
              h.previous_value AS previous_value, h.new_value AS new_value,
              h.action AS action, h.created_at AS created_at,
              h.updated_at AS updated_at, h.is_deleted AS is_deleted
       ORDER BY h.created_at DESC
       LIMIT 100`,
    );
    const result = await this.conn.execute(stmt, { memory_id: memoryId });
    return await result.getAll();
  }

  async reset(): Promise<void> {
    await this.initialized;
    await this.conn.query("MATCH (h:MemoryHistory) DELETE h");
  }

  close(): void {
    this.conn.close();
    this.db.close();
  }
}
