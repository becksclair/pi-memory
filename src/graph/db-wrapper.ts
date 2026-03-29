// Runtime-agnostic database interface
export interface DatabaseWrapper {
	prepare(sql: string): PreparedStatementWrapper;
	exec(sql: string): void;
	transaction<T extends (...args: any[]) => any>(fn: T): T;
	close(): void;
}

export interface PreparedStatementWrapper {
	/**
	 * Executes the prepared statement with the given parameters.
	 * @returns Object containing:
	 *   - changes: Number of rows affected. NOTE: On Bun runtime, this is always 1 (optimistic)
	 *     because bun:sqlite does not expose changes count. Use lastInsertRowid for reliable results.
	 *   - lastInsertRowid: The row ID of the last inserted row. This is accurate on all runtimes.
	 */
	run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
	get(...params: unknown[]): Record<string, unknown> | undefined;
	all(...params: unknown[]): Record<string, unknown>[];
}

// Factory to create database based on runtime
export async function createDatabase(dbPath: string): Promise<DatabaseWrapper> {
	if (process.versions.bun) {
		// Use Bun's native SQLite
		const { Database } = await import("bun:sqlite");
		const db = new Database(dbPath);
		return new BunDatabaseWrapper(db);
	}
	// Use better-sqlite3 for Node
	const { default: DatabaseConstructor } = await import("better-sqlite3");
	const db = new DatabaseConstructor(dbPath);
	return new BetterSqlite3Wrapper(db);
}

// Wrapper for bun:sqlite
class BunDatabaseWrapper implements DatabaseWrapper {
	constructor(private db: any) {}

	prepare(sql: string): PreparedStatementWrapper {
		const stmt = this.db.query(sql);
		return new BunStatementWrapper(stmt, this.db);
	}

	exec(sql: string): void {
		this.db.exec(sql);
	}

	transaction<T extends (...args: any[]) => any>(fn: T): T {
		return this.db.transaction(fn);
	}

	close(): void {
		this.db.close();
	}
}

class BunStatementWrapper implements PreparedStatementWrapper {
	constructor(
		private stmt: any,
		private db: any,
	) {}

	run(...params: unknown[]) {
		// bun:sqlite's run() returns void, unlike better-sqlite3 which returns changes/lastInsertRowid
		// We use db.lastInsertRowId for the last inserted row ID (if available)
		// Note: changes count is NOT available in bun:sqlite. We return changes: 1 as optimistic default.
		// This is a KNOWN LIMITATION - code should not rely on accurate changes count when using Bun runtime.
		// lastInsertRowid is accurate and can be relied upon.
		this.stmt.run(...params);
		const lastInsertRowid = this.db.lastInsertRowId ?? 0;
		return { changes: 1, lastInsertRowid };
	}

	get(...params: unknown[]) {
		return this.stmt.get(...params) as Record<string, unknown> | undefined;
	}

	all(...params: unknown[]) {
		return this.stmt.all(...params) as Record<string, unknown>[];
	}
}

// Wrapper for better-sqlite3
class BetterSqlite3Wrapper implements DatabaseWrapper {
	constructor(private db: any) {}

	prepare(sql: string): PreparedStatementWrapper {
		const stmt = this.db.prepare(sql);
		return new BetterSqlite3StatementWrapper(stmt);
	}

	exec(sql: string): void {
		this.db.exec(sql);
	}

	transaction<T extends (...args: any[]) => any>(fn: T): T {
		return this.db.transaction(fn);
	}

	close(): void {
		this.db.close();
	}
}

class BetterSqlite3StatementWrapper implements PreparedStatementWrapper {
	constructor(private stmt: any) {}

	run(...params: unknown[]) {
		const result = this.stmt.run(...params);
		return {
			changes: result.changes,
			lastInsertRowid: result.lastInsertRowid,
		};
	}

	get(...params: unknown[]) {
		return this.stmt.get(...params) as Record<string, unknown> | undefined;
	}

	all(...params: unknown[]) {
		return this.stmt.all(...params) as Record<string, unknown>[];
	}
}
