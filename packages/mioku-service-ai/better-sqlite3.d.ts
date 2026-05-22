declare module "better-sqlite3" {
  interface Statement {
    run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: any[]): any;
    all(...params: any[]): any[];
  }

  interface Database {
    exec(sql: string): this;
    prepare(sql: string): Statement;
    pragma(source: string, options?: Record<string, any>): any;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
    close(): void;
  }

  interface DatabaseConstructor {
    new (filename: string, options?: Record<string, any>): Database;
    (filename: string, options?: Record<string, any>): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
